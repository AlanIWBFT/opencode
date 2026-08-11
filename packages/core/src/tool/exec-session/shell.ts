import { ShellSelect } from "../../shell/select.js"
import { which } from "../../util/which.js"
import { powershellRecyclePrelude } from "./recycle.js"

const POWERSHELL_UTF8_PRELUDE = String.raw`
$__opencodeUtf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $__opencodeUtf8
[Console]::OutputEncoding = $__opencodeUtf8
$OutputEncoding = $__opencodeUtf8
`

/** Non-Linux selection is owned by the configured Location's ShellSelect service. */
export function persistentShellExecutable(
  resolvedShell: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (platform !== "linux") return resolvedShell
  const bash = which("bash", environment)
  if (!bash)
    throw new Error(
      "Linux unified exec requires Bash on PATH. Install Bash and restart OpenCode; no fallback to sh is used.",
    )
  return bash
}

export function persistentShellPosix(shell: string) {
  return ["bash", "dash", "ksh", "sh", "zsh"].includes(ShellSelect.name(shell))
}

export function persistentShellArgs(shell: string, tty: boolean, runnerFile: string, bootstrapEnv?: string) {
  const name = ShellSelect.name(shell)
  // A script operand keeps Bash non-interactive on a PTY; pipe stdin can be a socket, so use -s there.
  if (process.platform === "linux" && name === "bash") return ["--noprofile", "--norc", "-p", tty ? "/dev/stdin" : "-s"]
  if (persistentShellPosix(shell)) return ["-l"]
  if (name === "cmd") return ["/d", "/q", "/v:off", ...(tty && bootstrapEnv ? ["/k", `call %${bootstrapEnv}%`] : [])]
  if (ShellSelect.ps(shell))
    return ["-NoProfile", ...(tty ? ["-NoExit", "-File", runnerFile] : ["-NonInteractive", "-Command", "-"])]
  return []
}

export function persistentShellSupported(shell: string, platform: NodeJS.Platform = process.platform) {
  const name = ShellSelect.name(shell)
  if (platform === "linux") return name === "bash"
  return ShellSelect.ps(shell) || name === "cmd" || persistentShellPosix(shell)
}

export function persistentShellExtension(shell: string) {
  if (ShellSelect.name(shell) === "cmd") return "cmd"
  if (ShellSelect.ps(shell)) return "ps1"
  return "sh"
}

export function persistentShellScript(shell: string, input: { command: string; cwd?: string }) {
  const name = ShellSelect.name(shell)
  if (ShellSelect.ps(shell)) {
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
  if (ShellSelect.name(shell) === "cmd")
    return new TextEncoder().encode(
      `call "${input.runnerFile.replaceAll('"', '""')}" ${input.executionID} "${input.commandFile.replaceAll('"', '""')}" "${input.statusFile.replaceAll('"', '""')}"\r\n`,
    )
  const runner = persistentShellRunnerName(input.nonce)
  if (ShellSelect.ps(shell))
    return new TextEncoder().encode(
      `${runner} ${input.executionID} ${powershellQuote(input.commandFile)} ${powershellQuote(input.statusFile)}${input.tty ? "\r" : "\r\n"}`,
    )
  return new TextEncoder().encode(
    `${runner} ${input.executionID} ${posixQuote(posixPath(input.commandFile))} ${posixQuote(posixPath(input.statusFile))} ${posixQuote(input.cwd ? posixPath(input.cwd) : "")}\n`,
  )
}

export function persistentShellBootstrapRequest(shell: string, runnerFile: string, tty: boolean) {
  const name = ShellSelect.name(shell)
  if (tty && (name === "cmd" || ShellSelect.ps(shell))) return undefined
  if (name === "cmd") return new TextEncoder().encode(`call "${runnerFile.replaceAll('"', '""')}" --bootstrap\r\n`)
  if (ShellSelect.ps(shell)) return new TextEncoder().encode(`. ${powershellQuote(runnerFile)}${tty ? "\r" : "\r\n"}`)
  if (process.platform === "linux") return new TextEncoder().encode(`set +o posix\n. ${posixQuote(runnerFile)}\n`)
  return new TextEncoder().encode(`. ${posixQuote(posixPath(runnerFile))}\n`)
}

export function persistentShellBootstrapFrame(nonce: string, tty: boolean) {
  return tty ? `OC${nonce}:b:CO` : `\x1e${nonce}:bootstrap\x1f`
}

export function persistentShellRunnerScript(shell: string, input: { nonce: string; tty: boolean }) {
  const name = ShellSelect.name(shell)
  const runner = persistentShellRunnerName(input.nonce)
  const bootstrap = persistentShellBootstrapFrame(input.nonce, input.tty)
  const frame = input.tty
    ? { start: `OC${input.nonce}:`, startEnd: ":s:CO", done: `OC${input.nonce}:`, doneMiddle: ":d:", doneEnd: ":CO" }
    : {
        start: `\x1e${input.nonce}:`,
        startEnd: ":start\x1f",
        done: `\x1e${input.nonce}:`,
        doneMiddle: ":done:",
        doneEnd: "\x1f",
      }
  if (name === "cmd")
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
  if (ShellSelect.ps(shell)) {
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
      : `command pwd -P >| "$${variable}_status_file"`
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
function cmdBatchPath(value: string) {
  return value.replaceAll("%", "%%").replaceAll('"', '""')
}
function posixQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
function posixPath(value: string) {
  return process.platform === "win32" ? value.replaceAll("\\", "/") : value
}
