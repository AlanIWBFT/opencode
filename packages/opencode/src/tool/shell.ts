import { Context, Effect, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // PowerShell cmdlet names are tracked here; delete aliases are gated by ps
  // below so POSIX shells do not get extra file-path prompts.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const PS_DELETE_ALIASES = new Set(["del", "erase", "rmdir", "rd"])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

const WINDOWS_RECYCLE_HELPER = "OpenCode.Windows.RecycleBin.dll"
const WINDOWS_RECYCLE_PROTOCOL = 2

function windowsRecycleHelperPath() {
  const runtime = path.basename(process.execPath).toLowerCase()
  if (!["bun", "bun.exe", "node", "node.exe"].includes(runtime)) {
    return path.join(path.dirname(process.execPath), WINDOWS_RECYCLE_HELPER)
  }
  return fileURLToPath(
    new URL(`../windows-recycle/bin/Release/netstandard2.0/${WINDOWS_RECYCLE_HELPER}`, import.meta.url),
  )
}

function powershellRecyclePrelude() {
  const helper = powershellQuote(windowsRecycleHelperPath())
  return String.raw`
function __opencodeBlockedDelete {
  param(
    [Parameter(Mandatory = $true)] [string] $Reason,
    [System.Exception] $Exception
  )

  $message = @("Deletion could not be completed safely: $Reason")
  if ($null -ne $Exception) {
    $root = $Exception.GetBaseException()
    $message += "Cause: $($root.GetType().FullName): $($root.Message)"
  }
  $message += @(
    'The target was not deleted. Filesystem deletion is only performed through the Recycle Bin.'
    'Do not bypass this safeguard or retry with permanent deletion; ask the user how to proceed.'
  )
  throw ($message -join [Environment]::NewLine)
}

function __opencodeEnsureRecycleApi {
  if ($null -eq ('OpenCode.Windows.RecycleBin' -as [type])) {
    try {
      $null = [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes(${helper}))
    } catch {
      __opencodeBlockedDelete -Reason 'the Recycle Bin helper is unavailable.' -Exception $_.Exception
    }
  }

  if ([OpenCode.Windows.RecycleBin]::ProtocolVersion -ne ${WINDOWS_RECYCLE_PROTOCOL}) {
    __opencodeBlockedDelete -Reason 'the Recycle Bin helper protocol is incompatible.'
  }
}

function __opencodeRecycleFailureReason {
  param(
    [Parameter(Mandatory = $true)] [string] $Target,
    [Parameter(Mandatory = $true)] [string] $Kind,
    [Parameter(Mandatory = $true)] [object] $Result
  )

  $code = if ([string]::IsNullOrWhiteSpace($Result.HResultName)) { $Result.HResultHex } else { $Result.HResultName }
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("the Recycle Bin operation failed for the $($Kind): $Target. $($code): $($Result.Message)")
  $diagnosis = $Result.LockDiagnosis
  if ($null -eq $diagnosis) { return ($lines -join [Environment]::NewLine) }

  if ($diagnosis.BlockingItems.Count -eq 0) {
    $lines.Add('The specific blocking item could not be identified; it may have been released before diagnosis completed.')
  } else {
    $lines.Add('Blocking items observed at diagnosis time:')
    foreach ($blockingItem in $diagnosis.BlockingItems) {
      $blockingKind = if ($blockingItem.Kind -eq 'mapped-image') {
        'loaded image'
      } elseif ($blockingItem.Kind -eq 'mapped-file') {
        'memory-mapped file'
      } else {
        'open handle denies deletion'
      }
      $processes = [System.Collections.Generic.List[string]]::new()
      foreach ($process in $blockingItem.Processes) {
        $name = if ([string]::IsNullOrWhiteSpace($process.Name)) { 'process' } else { $process.Name }
        $processes.Add("$name (PID $($process.ProcessId))")
      }
      $owner = if ($processes.Count -eq 0) { '' } else { '; ' + ($processes -join ', ') }
      $lines.Add("- $($blockingItem.Path) ($blockingKind$owner)")
    }
  }
  if (-not $diagnosis.Complete) {
    $lines.Add('Lock diagnosis was partial; additional blocking items or process details may not have been identified.')
  }
  return ($lines -join [Environment]::NewLine)
}

function __opencodeRecycle {
  param(
    [Parameter(Mandatory = $true)] [string] $Target,
    [Parameter(Mandatory = $true)] [string] $Kind
  )

  try {
    $result = [OpenCode.Windows.RecycleBin]::Recycle($Target)
  } catch {
    __opencodeBlockedDelete -Reason "the Recycle Bin helper failed for the $($Kind): $Target." -Exception $_.Exception
  }
  if ($result.Succeeded) { return }
  __opencodeBlockedDelete -Reason (__opencodeRecycleFailureReason -Target $Target -Kind $Kind -Result $result)
}

function __opencodeResolveRemoveItemTargets {
  param(
    [object[]] $Value,
    [bool] $Literal,
    [bool] $Force,
    [Parameter(Mandatory = $true)] [System.Management.Automation.PSCmdlet] $Cmdlet
  )

  foreach ($item in $Value) {
    if ($null -eq $item) { continue }
    try {
      if ($null -ne $item.PSObject.Properties['PSPath']) {
        Get-Item -LiteralPath $item.PSPath -Force -ErrorAction Stop
        continue
      }
      if ($Literal) {
        Get-Item -LiteralPath ([string] $item) -Force -ErrorAction Stop
        continue
      }
      Get-Item -Path ([string] $item) -Force -ErrorAction Stop
    } catch [System.Management.Automation.ItemNotFoundException] {
      $errorRecord = $_
      $provider = $null
      $drive = $null
      $providerPath = if ($null -ne $item.PSObject.Properties['PSPath']) { [string] $item.PSPath } else { [string] $item }
      try {
        $null = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($providerPath, [ref] $provider, [ref] $drive)
      } catch {
        __opencodeBlockedDelete -Reason "the target provider could not be resolved: $item." -Exception $_.Exception
      }
      if ($null -ne $provider -and $provider.Name -ne 'FileSystem') {
        $Cmdlet.WriteError($errorRecord)
        continue
      }
      __opencodeBlockedDelete -Reason "the target could not be resolved to an existing item: $item." -Exception $errorRecord.Exception
    } catch {
      __opencodeBlockedDelete -Reason "the target could not be resolved to an existing item: $item." -Exception $_.Exception
    }
  }
}

function __opencodeMoveToRecycleBin {
  param(
    [Parameter(Mandatory = $true)] [object] $Item,
    [Parameter(Mandatory = $true)] [System.Management.Automation.PSCmdlet] $Cmdlet,
    [bool] $Recurse,
    [bool] $Force
  )

  if ($null -eq $Item.PSObject.Properties['PSProvider'] -or $Item.PSProvider.Name -ne 'FileSystem') {
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $Item.PSPath -Recurse:$Recurse -Force:$Force
    return
  }

  $target = if ($null -ne $Item.PSObject.Properties['FullName']) {
    [string] $Item.FullName
  } else {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Item.PSPath)
  }

  if (-not $Cmdlet.ShouldProcess($target, 'Move to Recycle Bin')) { return }
  __opencodeEnsureRecycleApi

  if ([System.IO.Directory]::Exists($target)) {
    __opencodeRecycle -Target $target -Kind 'directory'
    return
  }

  if ([System.IO.File]::Exists($target)) {
    __opencodeRecycle -Target $target -Kind 'file'
    return
  }

  __opencodeBlockedDelete "the filesystem target no longer exists: $target."
}

function Remove-Item {
  [CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = 'Path')]
  param(
    [Parameter(Position = 0, ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true, ParameterSetName = 'Path')]
    [SupportsWildcards()]
    [object[]] $Path,

    [Parameter(ValueFromPipelineByPropertyName = $true, ParameterSetName = 'LiteralPath')]
    [Alias('PSPath', 'LP')]
    [object[]] $LiteralPath,

    [switch] $Recurse,
    [switch] $Force
  )

  process {
    $values = if ($PSCmdlet.ParameterSetName -eq 'LiteralPath') { $LiteralPath } else { $Path }
    if ($null -eq $values) { throw 'Remove-Item requires a path.' }
    foreach ($item in (__opencodeResolveRemoveItemTargets -Value $values -Literal:($PSCmdlet.ParameterSetName -eq 'LiteralPath') -Force:$Force -Cmdlet $PSCmdlet)) {
      __opencodeMoveToRecycleBin -Item $item -Cmdlet $PSCmdlet -Recurse:$Recurse -Force:$Force
    }
  }
}

foreach ($__opencodeAlias in @('rm', 'del', 'erase', 'rmdir', 'rd')) {
  Set-Alias -Name $__opencodeAlias -Value Remove-Item -Option AllScope -Force
}
`
}

const POWERSHELL_UTF8_PRELUDE = String.raw`
$__opencodeUtf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $__opencodeUtf8
[Console]::OutputEncoding = $__opencodeUtf8
$OutputEncoding = $__opencodeUtf8
`

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type PermissionInput = {
  command: string
  cwd: string
  shell: string
  instance: InstanceContext
  fs: FSUtil.Interface
  spawner: Context.Service.Shape<typeof ChildProcessSpawner>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
  return undefined
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return undefined
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return undefined
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return undefined
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

export const askPermissions = Effect.fn("ShellTool.askPermissions")(function* (
  ctx: Tool.Context,
  input: PermissionInput,
) {
  const ps = Shell.ps(input.shell)
  yield* Effect.scoped(
    Effect.gen(function* () {
      const tree = yield* Effect.acquireRelease(parse(input.command, ps), (tree) => Effect.sync(() => tree.delete()))
      const scan = yield* collect(tree.rootNode, input.cwd, ps, input.shell, input.instance, input.fs, input.spawner)
      if (!containsPath(input.cwd, input.instance)) scan.dirs.add(input.cwd)
      yield* ask(ctx, scan, input)
    }),
  )
})

export function persistentShellArgs(shell: string, tty: boolean, runnerFile: string, bootstrapEnv?: string) {
  const name = Shell.name(shell)
  if (Shell.posix(shell)) return ["-l"]
  if (name === "cmd") {
    const bootstrap = tty && bootstrapEnv ? ["/k", `call %${bootstrapEnv}%`] : []
    return ["/d", "/q", "/v:off", ...bootstrap]
  }
  if (Shell.ps(shell))
    return ["-NoLogo", "-NoProfile", ...(tty ? ["-NoExit", "-File", runnerFile] : ["-NonInteractive", "-Command", "-"])]
  return []
}

export function persistentShellSupported(shell: string) {
  const name = Shell.name(shell)
  return Shell.ps(shell) || name === "cmd" || ["bash", "dash", "ksh", "sh", "zsh"].includes(name)
}

export function persistentShellExtension(shell: string) {
  const name = Shell.name(shell)
  if (name === "cmd") return "cmd"
  if (Shell.ps(shell)) return "ps1"
  return "sh"
}

export function persistentShellScript(shell: string, input: { command: string; cwd?: string }) {
  const name = Shell.name(shell)
  if (Shell.ps(shell)) {
    const cwd = input.cwd ? `Set-Location -LiteralPath ${powershellQuote(input.cwd)} -ErrorAction Stop\n` : ""
    return `${POWERSHELL_UTF8_PRELUDE}\n${powershellRecyclePrelude()}\n${cwd}${input.command}\n`
  }
  if (name === "cmd") {
    const cwd = input.cwd ? `cd /d "${cmdBatchPath(input.cwd)}" || exit /b 1\r\n` : ""
    return `${cwd}${input.command}\r\n`
  }
  return `${input.command}\n`
}

export function persistentShellRequest(
  shell: string,
  input: {
    executionID: number
    commandFile: string
    runnerFile: string
    statusFile: string
    nonce: string
    tty: boolean
    cwd?: string
  },
) {
  const name = Shell.name(shell)
  if (name === "cmd")
    return new TextEncoder().encode(
      `call "${input.runnerFile.replaceAll('"', '""')}" ${input.executionID} "${input.commandFile.replaceAll('"', '""')}" "${input.statusFile.replaceAll('"', '""')}"\r\n`,
    )
  const runner = persistentShellRunnerName(input.nonce)
  if (Shell.ps(shell))
    return new TextEncoder().encode(
      `${runner} ${input.executionID} ${powershellQuote(input.commandFile)} ${powershellQuote(input.statusFile)}${input.tty ? "\r" : "\r\n"}`,
    )
  return new TextEncoder().encode(
    `${runner} ${input.executionID} ${posixQuote(posixPath(input.commandFile))} ${posixQuote(posixPath(input.statusFile))} ${posixQuote(input.cwd ? posixPath(input.cwd) : "")}\n`,
  )
}

export function persistentShellBootstrapRequest(shell: string, runnerFile: string, tty: boolean) {
  const name = Shell.name(shell)
  if (tty && (name === "cmd" || Shell.ps(shell))) return
  if (name === "cmd") return new TextEncoder().encode(`call "${runnerFile.replaceAll('"', '""')}" --bootstrap\r\n`)
  if (Shell.ps(shell)) return new TextEncoder().encode(`. ${powershellQuote(runnerFile)}${tty ? "\r" : "\r\n"}`)
  return new TextEncoder().encode(`. ${posixQuote(posixPath(runnerFile))}\n`)
}

export function persistentShellBootstrapFrame(nonce: string, tty: boolean) {
  return tty ? `OC${nonce}:b:CO` : `\x1e${nonce}:bootstrap\x1f`
}

export function persistentShellRunnerScript(
  shell: string,
  input: {
    nonce: string
    tty: boolean
  },
) {
  const name = Shell.name(shell)
  const runner = persistentShellRunnerName(input.nonce)
  const bootstrap = persistentShellBootstrapFrame(input.nonce, input.tty)
  const frame = input.tty
    ? {
        start: `OC${input.nonce}:`,
        startEnd: ":s:CO",
        done: `OC${input.nonce}:`,
        doneMiddle: ":d:",
        doneEnd: ":CO",
      }
    : {
        start: `\x1e${input.nonce}:`,
        startEnd: ":start\x1f",
        done: `\x1e${input.nonce}:`,
        doneMiddle: ":done:",
        doneEnd: "\x1f",
      }
  if (name === "cmd") {
    return (
      [
        "@echo off",
        "chcp 65001 >nul",
        `if /i "%~1"=="--bootstrap" (`,
        ...(input.tty ? [`  set "OPENCODE_CMD_BOOTSTRAP_${input.nonce.toUpperCase()}="`] : []),
        `  <nul set /p "=${bootstrap}"`,
        "  exit /b 0",
        ")",
        `<nul set /p "=${frame.start}%~1${frame.startEnd}"`,
        'call "%~2" 2>&1',
        `set "__opencodeExecCode=%errorlevel%"`,
        'cd > "%~3"',
        ...(input.tty ? ["echo("] : []),
        `<nul set /p "=${frame.done}%~1${frame.doneMiddle}%__opencodeExecCode%${frame.doneEnd}"`,
        "exit /b 0",
      ].join("\r\n") + "\r\n"
    )
  }
  if (Shell.ps(shell)) {
    const session = `__opencode_user_session_${input.nonce}`
    const errorWriter = `__opencode_error_writer_${input.nonce}`
    const history = input.tty
      ? String.raw`try {
  $__opencodePSReadLine = @(Microsoft.PowerShell.Core\Get-Module -Name PSReadLine -ListAvailable -ErrorAction Stop)[0]
  if ($null -ne $__opencodePSReadLine) {
    $null = Microsoft.PowerShell.Core\Import-Module -Name PSReadLine -PassThru -ErrorAction Stop
    PSReadLine\Set-PSReadLineOption -HistorySavePath ([IO.Path]::Combine($PSScriptRoot, 'PSReadLine_history.txt')) -HistorySaveStyle SaveNothing -ErrorAction Stop
  }
} catch {
  [Console]::Error.WriteLine('could not isolate PSReadLine history: ' + $_.Exception.GetBaseException().Message)
  [Console]::Error.Flush()
  [Environment]::Exit(1)
}`
      : ""
    const start = powershellQuote(frame.start)
    const startEnd = powershellQuote(frame.startEnd)
    const done = powershellQuote(frame.done)
    const doneMiddle = powershellQuote(frame.doneMiddle)
    const doneEnd = powershellQuote(frame.doneEnd)
    const ready = powershellQuote(bootstrap)
    return String.raw`${POWERSHELL_UTF8_PRELUDE}
${history}
$global:${session} = Microsoft.PowerShell.Core\New-Module -ScriptBlock {}
$global:${errorWriter} = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), $__opencodeUtf8)
$global:${errorWriter}.AutoFlush = $true
[Console]::SetError($global:${errorWriter})

function global:${runner} {
  param(
    [Parameter(Mandatory = $true)] [int] $ExecutionID,
    [Parameter(Mandatory = $true)] [string] $CommandFile,
    [Parameter(Mandatory = $true)] [string] $StatusFile
  )
  $__opencodeStdout = [Console]::OpenStandardOutput()
  $__opencodeStart = $__opencodeUtf8.GetBytes(${start} + $ExecutionID + ${startEnd})
  $__opencodeStdout.Write($__opencodeStart, 0, $__opencodeStart.Length)
  $__opencodeStdout.Flush()
  $__opencodeExecCode = 0
  $__opencodeExecError = $null
  try {
    $__opencodeExecSource = [IO.File]::ReadAllText($CommandFile, $__opencodeUtf8)
    $__opencodeExecSource = '$global:LASTEXITCODE = $null' + [Environment]::NewLine + 'try {' + [Environment]::NewLine + $__opencodeExecSource + [Environment]::NewLine + '} finally {' + [Environment]::NewLine + '$script:__opencodeExecSuccess = $?' + [Environment]::NewLine + '$script:__opencodeExecNative = $global:LASTEXITCODE' + [Environment]::NewLine + '}' + [Environment]::NewLine + '$script:__opencodeExecCompleted = $true'
    $global:${session}.SessionState.PSVariable.Remove('__opencodeExecSuccess')
    $global:${session}.SessionState.PSVariable.Remove('__opencodeExecNative')
    $global:${session}.SessionState.PSVariable.Remove('__opencodeExecCompleted')
    $global:${session}.SessionState.PSVariable.Remove('__opencodeExecError')
    $__opencodeExecBlock = $global:${session}.NewBoundScriptBlock({
      param([string] $Source)
      # A nested pipeline contains exit while retaining the lane module's SessionState.
      $__opencodeExecPipeline = [System.Management.Automation.PowerShell]::Create([System.Management.Automation.RunspaceMode]::CurrentRunspace)
      try {
        $null = $__opencodeExecPipeline.AddScript($Source, $false)
        $__opencodeExecPipeline.Commands.Commands[0].MergeMyResults([System.Management.Automation.Runspaces.PipelineResultTypes]::Error, [System.Management.Automation.Runspaces.PipelineResultTypes]::Output)
        $null = $__opencodeExecPipeline.AddCommand('Microsoft.PowerShell.Core\Out-Default')
        $null = $__opencodeExecPipeline.Invoke()
      } catch {
        $script:__opencodeExecError = if ($null -ne $__opencodeExecPipeline.InvocationStateInfo.Reason) { $__opencodeExecPipeline.InvocationStateInfo.Reason.Message } else { $_.Exception.Message }
      } finally {
        $__opencodeExecPipeline.Dispose()
      }
    })
    . $__opencodeExecBlock $__opencodeExecSource
    [Console]::Out.Flush()
    $__opencodeExecSuccess = $global:${session}.SessionState.PSVariable.GetValue('__opencodeExecSuccess')
    $__opencodeExecNative = $global:${session}.SessionState.PSVariable.GetValue('__opencodeExecNative')
    $__opencodeExecCompleted = $global:${session}.SessionState.PSVariable.GetValue('__opencodeExecCompleted')
    $__opencodeExecError = $global:${session}.SessionState.PSVariable.GetValue('__opencodeExecError')
    $__opencodeExecCode = if ($null -ne $__opencodeExecError) { 1 } elseif (-not $__opencodeExecCompleted -and $global:LASTEXITCODE -is [int]) { $global:LASTEXITCODE } elseif ($__opencodeExecSuccess) { 0 } elseif ($__opencodeExecNative -is [int] -and $__opencodeExecNative -ne 0) { $__opencodeExecNative } else { 1 }
  } catch {
    $__opencodeExecError = [string] $_
    $__opencodeExecCode = 1
  }
  ${POWERSHELL_UTF8_PRELUDE}
  if ($null -ne $__opencodeExecError) { [Console]::Error.WriteLine($__opencodeExecError) }
  $__opencodeStatusError = $null
  try {
    $__opencodeLocation = $global:${session}.SessionState.Path.CurrentLocation
    if ($null -eq $__opencodeLocation.Provider -or $__opencodeLocation.Provider.Name -ne 'FileSystem') {
      throw "persistent shell location is not a FileSystem path: $($__opencodeLocation.Path)"
    }
    $__opencodeExecCwd = [string] $__opencodeLocation.ProviderPath
    if ([string]::IsNullOrEmpty($__opencodeExecCwd)) { throw 'persistent shell returned an empty FileSystem path' }
    [IO.File]::WriteAllText($StatusFile, $__opencodeExecCwd, $__opencodeUtf8)
  } catch {
    $__opencodeStatusError = [string] $_
    $__opencodeExecCode = 1
  }
  if ($null -ne $__opencodeStatusError) { [Console]::Error.WriteLine($__opencodeStatusError) }
  $__opencodeDone = $__opencodeUtf8.GetBytes(${input.tty ? "[Environment]::NewLine + " : ""}${done} + $ExecutionID + ${doneMiddle} + $__opencodeExecCode + ${doneEnd})
  $__opencodeStdout.Write($__opencodeDone, 0, $__opencodeDone.Length)
  $__opencodeStdout.Flush()
}
$__opencodeBootstrap = $__opencodeUtf8.GetBytes(${ready})
$__opencodeBootstrapOutput = [Console]::OpenStandardOutput()
$__opencodeBootstrapOutput.Write($__opencodeBootstrap, 0, $__opencodeBootstrap.Length)
$__opencodeBootstrapOutput.Flush()
`
  }
  const variable = `__opencode_${input.nonce}`
  const writeCwd =
    process.platform === "win32"
      ? `${variable}_exec_cwd=$(command pwd -P) && command cygpath -w -- "$${variable}_exec_cwd" > "$${variable}_status_file"`
      : `command pwd -P > "$${variable}_status_file"`
  return (
    [
      `${runner}() {`,
      `  ${variable}_exec_id=$1`,
      `  ${variable}_command_file=$2`,
      `  ${variable}_status_file=$3`,
      `  ${variable}_requested_cwd=$4`,
      "  shift 4",
      `  command printf '%s%s%s' ${posixQuote(frame.start)} "$${variable}_exec_id" ${posixQuote(frame.startEnd)}`,
      `  if [ -z "$${variable}_requested_cwd" ] || command cd -- "$${variable}_requested_cwd"; then`,
      `    . "$${variable}_command_file" 2>&1`,
      `    ${variable}_exec_code=$?`,
      "  else",
      `    ${variable}_exec_code=$?`,
      "  fi",
      `  ${writeCwd}`,
      `  command printf '${input.tty ? "\\n" : ""}%s%s%s%s%s' ${posixQuote(frame.done)} "$${variable}_exec_id" ${posixQuote(frame.doneMiddle)} "$${variable}_exec_code" ${posixQuote(frame.doneEnd)}`,
      "}",
      `command printf '%s' ${posixQuote(bootstrap)}`,
    ].join("\n") + "\n"
  )
}

function persistentShellRunnerName(nonce: string) {
  return `__opencode_run_${nonce}`
}

function powershellQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function powershellTransport(value: string) {
  const parts: string[] = []
  let ascii = ""
  const flush = () => {
    if (!ascii) return
    parts.push(powershellQuote(ascii))
    ascii = ""
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0x20 && code <= 0x7e) {
      ascii += value[index]
      continue
    }
    flush()
    parts.push(`[char]0x${code.toString(16).padStart(4, "0")}`)
  }
  flush()
  if (parts.length === 0) return "''"
  return parts.length === 1 && parts[0].startsWith("'") ? parts[0] : `(''+${parts.join("+")})`
}

function powershellTransportLines(value: string) {
  return value.replaceAll("\r\n", "\n").split("\n").map(powershellTransport).join(",")
}

function cmdBatchPath(value: string) {
  return value.replaceAll("%", "%%").replaceAll('"', '""')
}

function posixQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function posixPath(value: string) {
  return process.platform === "win32" ? value.replaceAll("\\", "/") : value
}

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    const prelude = powershellTransportLines(`${POWERSHELL_UTF8_PRELUDE}\n${powershellRecyclePrelude()}`)
    const script = powershellTransportLines(command)
    const runner = [
      `$__opencodePrelude = @(${prelude}) -join [Environment]::NewLine;`,
      `$__opencodeScript = @(${script}) -join [Environment]::NewLine;`,
      ". ([scriptblock]::Create($__opencodePrelude));",
      "$__opencodeTokens = $null;",
      "$__opencodeErrors = $null;",
      "$null = [System.Management.Automation.Language.Parser]::ParseInput($__opencodeScript, [ref] $__opencodeTokens, [ref] $__opencodeErrors);",
      "if ($__opencodeErrors.Count -gt 0) {",
      "$__opencodeLines = $__opencodeScript.Split([char]10);",
      "foreach ($__opencodeError in $__opencodeErrors) {",
      "$__opencodeIndex = $__opencodeError.Extent.StartLineNumber - 1;",
      '$__opencodeLine = if ($__opencodeIndex -ge 0 -and $__opencodeIndex -lt $__opencodeLines.Length) { $__opencodeLines[$__opencodeIndex].TrimEnd([char]13) } else { "" };',
      '[Console]::Error.WriteLine("ParserError: At line:$($__opencodeError.Extent.StartLineNumber) char:$($__opencodeError.Extent.StartColumnNumber)");',
      '[Console]::Error.WriteLine("+ $__opencodeLine");',
      '[Console]::Error.WriteLine("+ $(" " * ([Math]::Max(0, $__opencodeError.Extent.StartColumnNumber - 1)))~");',
      "[Console]::Error.WriteLine($__opencodeError.Message);",
      "};",
      "exit 1;",
      "};",
      "$__opencodeExecution = $__opencodeScript;",
      "$__opencodeExecution += [Environment]::NewLine + '$global:__opencodeExecSuccess = $?';",
      "$__opencodeExecution += [Environment]::NewLine + '$global:__opencodeExecNative = $global:LASTEXITCODE';",
      "$__opencodeExecution += [Environment]::NewLine + '$global:__opencodeExecCompleted = $true';",
      "$global:__opencodeExecSuccess = $null;",
      "$global:__opencodeExecNative = $null;",
      "$global:__opencodeExecCompleted = $false;",
      "$global:LASTEXITCODE = $null;",
      "& ([scriptblock]::Create($__opencodeExecution));",
      "$__opencodeInvocationSuccess = $?;",
      "if ($global:__opencodeExecCompleted -and $global:__opencodeExecSuccess) { exit 0 };",
      "if ($global:__opencodeExecCompleted -and $global:__opencodeExecNative -is [int] -and $global:__opencodeExecNative -ne 0) { exit $global:__opencodeExecNative };",
      "if (-not $global:__opencodeExecCompleted -and $__opencodeInvocationSuccess) { exit 0 };",
      "if (-not $global:__opencodeExecCompleted -and $global:LASTEXITCODE -is [int] -and $global:LASTEXITCODE -ne 0) { exit $global:LASTEXITCODE };",
      "exit 1",
    ].join(" ")
    return ChildProcess.make(shell, ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      cwd,
      env,
      stdin: Stream.make(new TextEncoder().encode(runner + "\n")),
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

const collect = Effect.fn("ShellTool.collect")(function* (
  root: Node,
  cwd: string,
  ps: boolean,
  shell: string,
  instance: InstanceContext,
  fs: FSUtil.Interface,
  spawner: Context.Service.Shape<typeof ChildProcessSpawner>,
) {
  const scan: Scan = {
    dirs: new Set<string>(),
    patterns: new Set<string>(),
    always: new Set<string>(),
  }
  const shellKind = ShellID.toKind(Shell.name(shell))

  const cygpath = Effect.fn("ShellTool.cygpath")(function* (text: string) {
    const lines = yield* spawner
      .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    const file = lines[0]?.trim()
    if (!file) return undefined
    return FSUtil.normalizePath(file)
  })

  const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string) {
    if (process.platform === "win32") {
      if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
        const file = yield* cygpath(text)
        if (file) return file
      }
      const driveRelative = ps ? text.match(/^[A-Za-z]:(?![\\/])(.*)$/) : undefined
      if (driveRelative) {
        const drive = text.slice(0, 2).toUpperCase()
        const cwdDrive = path.win32.parse(FSUtil.windowsPath(cwd)).root.slice(0, 2).toUpperCase()
        if (drive !== cwdDrive) return `${drive}\\`
        return FSUtil.normalizePath(path.resolve(cwd, FSUtil.windowsPath(driveRelative[1] || ".")))
      }
      return FSUtil.normalizePath(path.resolve(cwd, FSUtil.windowsPath(text)))
    }
    return path.resolve(cwd, text)
  })

  const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string) {
    const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
    const file = text && prefix(text)
    if (!file || dynamic(file, ps)) return undefined
    const next = ps ? provider(file) : file
    if (!next) return undefined
    return yield* resolvePath(next)
  })

  for (const node of commands(root)) {
    const command = parts(node)
    const tokens = command.map((item) => item.text)
    const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

    if (cmd && (FILES.has(cmd) || (ps && PS_DELETE_ALIASES.has(cmd)) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
      for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
        const resolved = yield* argPath(arg)
        yield* Effect.logInfo("resolved path", { arg, resolved })
        if (!resolved || containsPath(resolved, instance)) continue
        const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
        scan.dirs.add(dir)
      }
    }

    if (tokens.length && (!cmd || !CWD.has(cmd))) {
      scan.patterns.add(source(node))
      scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
    }
  }

  return scan
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const lines = yield* spawner
            .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
            .pipe(Effect.catch(() => Effect.succeed([] as string[])))
          const file = lines[0]?.trim()
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              yield* askPermissions(ctx, { command: params.command, cwd, shell, instance: instanceCtx, fs, spawner })

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
