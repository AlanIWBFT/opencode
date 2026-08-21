import { describe, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Shell } from "@opencode-ai/core/shell"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ExecSession } from "@/tool/exec-session"
import {
  persistentShellArgs,
  persistentShellBootstrapFrame,
  persistentShellBootstrapRequest,
  persistentShellRunnerScript,
  persistentShellScript,
  persistentShellSupported,
} from "@/tool/shell"
import { execCommandShellDescription } from "@/tool/unified-exec"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const sessionTimes = new Map<SessionID, { created: number; updated: number; archived?: number }>()
const sessionInfo = (sessionID: SessionID) => ({
  id: sessionID,
  slug: "unified-exec",
  projectID: ProjectV2.ID.global,
  directory: process.cwd(),
  title: "Unified exec test",
  version: "test",
  time: sessionTimes.get(sessionID) ?? { created: Date.now(), updated: Date.now() },
})
const sessionReads = new Map<SessionID, Effect.Effect<ReturnType<typeof sessionInfo>>>()
const sessionReadCounts = new Map<SessionID, number>()

const layer = LayerNode.compile(LayerNode.group([ExecSession.node, CrossSpawnSpawner.node, EventV2Bridge.node]), [
  [
    Session.node,
    Layer.mock(Session.Service)({
      get: (sessionID) =>
        Effect.sync(() => sessionReadCounts.set(sessionID, (sessionReadCounts.get(sessionID) ?? 0) + 1)).pipe(
          Effect.andThen(sessionReads.get(sessionID) ?? Effect.succeed(sessionInfo(sessionID))),
        ),
    }),
  ],
])
const it = testEffect(layer)
const scopedSession = (sessionID: SessionID) => {
  sessionTimes.delete(sessionID)
  return sessionID
}

const invocation = (display: ExecSession.Display) => ({
  sessionID: SessionID.make("ses_unified_exec"),
  messageID: MessageID.make("msg_unified_exec"),
  display,
  metadata: () => Effect.void,
})

const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
)
const windowsPowerShell = process.platform === "win32" ? Bun.which("powershell.exe") : undefined
const powerShellShells = Array.from(
  new Set([Shell.ps(Shell.acceptable()) ? Shell.acceptable() : undefined, windowsPowerShell]),
).filter((shell): shell is string => Boolean(shell))

describe("exec command shell description", () => {
  test("describes PowerShell 7 without requiring a nested launcher", () => {
    const description = execCommandShellDescription("pwsh", "win32")
    expect(description).toContain("PowerShell 7+ (`pwsh`) on `win32`")
    expect(description).toContain("`pwsh -NoLogo -NoProfile` as a persistent shell")
    expect(description).toContain("Pass only the command body")
    expect(description).toContain("PowerShell 7 supports `&&` and `||`")
    expect(description).toContain("UTF-8")
    expect(description).toContain("A final failing native program's exit code is propagated")
    expect(description).toContain("exit ends only the current command")
    expect(description).toContain("terminate_exec")
    expect(description).toContain("Recycle Bin")
  })

  test("warns about Windows PowerShell 5.1 syntax", () => {
    const description = execCommandShellDescription("powershell", "win32")
    expect(description).toContain("Windows PowerShell 5.1 (`powershell`) on `win32`")
    expect(description).toContain("does not support `&&` or `||`")
  })

  test("describes cmd and POSIX shell invocation", () => {
    const cmd = execCommandShellDescription("cmd", "win32")
    expect(cmd).toContain("`cmd.exe /d /q /v:off`")
    expect(cmd).toContain("temporary batch file")
    expect(cmd).toContain("`%%A` for FOR variables")
    expect(execCommandShellDescription("bash", "linux")).toContain("`bash -l` as a persistent stdin-driven POSIX shell")
  })

  test("rejects custom shells without a persistent protocol adapter", () => {
    const description = execCommandShellDescription("custom-shell", "linux")
    expect(description).toContain("`custom-shell` as a persistent stdin-driven POSIX-compatible shell")
    expect(description).toContain("configured shell is unsupported")
    expect(description).toContain("choose PowerShell, cmd, bash, dash, ksh, sh, or zsh")
  })
})

function lane(
  command: string,
  options: {
    laneID?: number
    resetLane?: boolean
    tty?: boolean
    yieldTimeMs?: number
    maxOutputTokens?: number
    source?: ReturnType<typeof invocation>
    onPrepare?: (cwd: string) => void
    prepareError?: Error
    shell?: string
    workdir?: string
    environment?: Record<string, string>
    commandEnv?: Record<string, string>
    onLaneReserved?: () => Effect.Effect<void>
    onExecutionStarted?: (execID: number) => Effect.Effect<void>
    failLaneRequest?: boolean
    failLaneBootstrap?: boolean
    bootstrapTimeoutMs?: number
  } = {},
) {
  return Effect.gen(function* () {
    const sessions = yield* ExecSession.Service
    const shell = options.shell ?? Shell.acceptable()
    return yield* sessions.launch({
      command,
      shell,
      cwd: process.cwd(),
      laneCwd: options.workdir,
      env: options.environment ?? env,
      laneID: options.laneID,
      resetLane: options.resetLane,
      tty: options.tty,
      yieldTimeMs: options.yieldTimeMs ?? 2_000,
      maxOutputTokens: options.maxOutputTokens,
      invocation: options.source ?? invocation("root"),
      onLaneReserved: options.onLaneReserved,
      onExecutionStarted: options.onExecutionStarted,
      failLaneRequest: options.failLaneRequest,
      failLaneBootstrap: options.failLaneBootstrap,
      bootstrapTimeoutMs: options.bootstrapTimeoutMs,
      prepare: (cwd) =>
        Effect.sync(() => {
          if (options.prepareError) throw options.prepareError
          options.onPrepare?.(cwd)
          return {
            script: persistentShellScript(shell, { command, cwd: options.workdir ? cwd : undefined }),
            env: options.commandEnv,
          }
        }),
    })
  })
}

function shellCommand(input: { ps: string; cmd: string; posix: string }) {
  const shell = Shell.acceptable()
  if (Shell.ps(shell)) return input.ps
  if (Shell.name(shell) === "cmd") return input.cmd
  return input.posix
}

function missingShell() {
  const name = Shell.name(Shell.acceptable()) + (process.platform === "win32" ? ".exe" : "")
  return path.join(os.tmpdir(), `opencode-missing-shell-${crypto.randomUUID()}`, name)
}

function blockedReservation() {
  return Effect.gen(function* () {
    const reserved = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    return {
      reserved,
      release,
      hook: () => Deferred.succeed(reserved, undefined).pipe(Effect.andThen(Deferred.await(release))),
    }
  })
}

function finish(
  id: number,
  source = invocation("poll"),
  duration: Parameters<typeof pollWithTimeout>[2] = "5 seconds",
) {
  return Effect.gen(function* () {
    const sessions = yield* ExecSession.Service
    return yield* pollWithTimeout(
      Effect.gen(function* () {
        const next = yield* sessions.write({ execID: id, yieldTimeMs: 100, invocation: source })
        return next.running ? undefined : next
      }),
      "lane command did not finish",
      duration,
    )
  })
}

describe("tool.unified-exec lanes", () => {
  test("uses shell-reported cwd and escapes injected cmd batch paths", () => {
    const nonce = "0123456789abcdef"
    const cmdRunner = persistentShellRunnerScript("cmd", { nonce, tty: false })
    const powerShellRunner = persistentShellRunnerScript("pwsh", { nonce, tty: false })
    const posixRunner = persistentShellRunnerScript("bash", { nonce, tty: false })
    expect(cmdRunner).toContain('cd > "%~3"')
    expect(cmdRunner).not.toContain("%CD%")
    expect(powerShellRunner).toContain("Provider.Name -ne 'FileSystem'")
    expect(powerShellRunner).toContain("System.Management.Automation.PowerShell]::Create")
    expect(powerShellRunner).toContain("RunspaceMode]::CurrentRunspace")
    expect(powerShellRunner).not.toContain("HistorySaveStyle SaveNothing")
    expect(persistentShellRunnerScript("pwsh", { nonce, tty: true })).toContain("HistorySaveStyle SaveNothing")
    expect(powerShellRunner.indexOf("$__opencodeStatusError")).toBeLessThan(powerShellRunner.indexOf("$__opencodeDone"))
    expect(posixRunner).toContain("command pwd -P")
    if (process.platform === "win32") expect(posixRunner).toContain("cygpath -w")
    expect(persistentShellScript("cmd", { command: "echo ready", cwd: "C:\\literal\\%TEMP%\\repo" })).toContain(
      "C:\\literal\\%%TEMP%%\\repo",
    )
  })

  test("starts interactive runners without echoed bootstrap requests", () => {
    const nonce = "0123456789abcdef"
    const runnerFile = "/tmp/runner"
    expect(persistentShellArgs("pwsh", true, runnerFile)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NoExit",
      "-File",
      runnerFile,
    ])
    expect(persistentShellArgs("pwsh", false, runnerFile)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "-",
    ])
    for (const shell of ["pwsh", "cmd", "bash"]) {
      const marker = persistentShellBootstrapFrame(nonce, true)
      const request = persistentShellBootstrapRequest(shell, runnerFile, true)
      const runner = persistentShellRunnerScript(shell, { nonce, tty: true })
      if (shell === "bash") expect(new TextDecoder().decode(request)).not.toContain(marker)
      else expect(request).toBeUndefined()
      expect(runner).toContain(marker)
    }
  })

  for (const shell of powerShellShells) {
    it.instance(
      `does not persist internal TTY execution requests to PSReadLine history [${Shell.name(shell)}]`,
      () =>
        Effect.gen(function* () {
          const result = yield* lane(
            '$options = Get-PSReadLineOption; Write-Output "history-style:$($options.HistorySaveStyle)"; Write-Output "history-path:$($options.HistorySavePath)"',
            {
              laneID: 0,
              tty: true,
              shell,
            },
          )
          expect(result.output).toContain("history-style:SaveNothing")
          const historyPath = result.output.match(/history-path:(.+)/)?.[1].trim()
          if (!historyPath) throw new Error(`PowerShell did not report its history path: ${result.output}`)
          expect(path.basename(path.dirname(historyPath))).toMatch(/^opencode-lane-/)
          const history = yield* Effect.promise(async () => {
            try {
              return await fs.readFile(historyPath, "utf8")
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
              throw error
            }
          })
          expect(history).not.toContain("__opencode_run_")
        }),
      15_000,
    )

    if (shell !== windowsPowerShell) continue
    it.instance(
      `fails bootstrap when PSReadLine history isolation fails [${Shell.name(shell)}]`,
      () =>
        Effect.gen(function* () {
          const modules = yield* tmpdirScoped()
          const module = path.join(modules, "PSReadLine")
          yield* Effect.promise(() => fs.mkdir(module, { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(module, "PSReadLine.psm1"),
              "function Set-PSReadLineOption { throw 'simulated PSReadLine failure' }\nExport-ModuleMember -Function Set-PSReadLineOption\n",
            ),
          )
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(module, "PSReadLine.psd1"),
              "@{ RootModule = 'PSReadLine.psm1'; ModuleVersion = '99.0.0'; FunctionsToExport = @('Set-PSReadLineOption') }\n",
            ),
          )
          const result = yield* lane("Write-Output should-not-run", {
            laneID: 0,
            tty: true,
            shell,
            environment: { ...env, PSModulePath: modules },
          })
          expect(result.error).toContain("could not isolate PSReadLine history: simulated PSReadLine failure")
          expect(result.output).not.toContain("should-not-run")
        }),
      15_000,
    )
  }

  test("rejects a custom configured shell without a protocol adapter", () => {
    const shell = process.platform === "win32" ? "C:\\tools\\custom-shell.exe" : "/usr/local/bin/custom-shell"
    expect(persistentShellSupported(shell)).toBe(false)
  })

  it.instance("loses the slot when a reset shell never acknowledges bootstrap", () =>
    Effect.gen(function* () {
      const seeded = yield* lane(
        shellCommand({
          ps: "$env:OPENCODE_BOOTSTRAP_RESET = 'kept'; Write-Output seeded",
          cmd: "set OPENCODE_BOOTSTRAP_RESET=kept&& echo seeded",
          posix: "export OPENCODE_BOOTSTRAP_RESET=kept; printf seeded",
        }),
        { laneID: 0 },
      )
      const failed = yield* lane("should-not-run", {
        laneID: 0,
        resetLane: true,
        failLaneBootstrap: true,
        bootstrapTimeoutMs: 100,
        yieldTimeMs: 0,
      })
      expect(failed.error).toContain("bootstrap timed out")

      const recovered = yield* lane(
        shellCommand({
          ps: "Write-Output recovered",
          cmd: "echo recovered",
          posix: "printf recovered",
        }),
        { laneID: 0 },
      )
      expect(recovered.error).toBeUndefined()
      expect(recovered.output).toContain("recovered")
      expect(recovered.warning).toContain("previous shell state was lost")
      expect(recovered.metadata.shellGeneration).toBeGreaterThan(seeded.metadata.shellGeneration ?? 0)
      expect(recovered.metadata.shellReused).toBe(false)
    }),
  )

  it.instance("reuses state and cwd in a lane", () =>
    Effect.gen(function* () {
      const first = yield* lane(
        shellCommand({
          ps: "$env:OPENCODE_LANE_TEST = 'yes'; $OpenCodeLaneScalar = 'scalar'; function Get-OpenCodeLaneValue { 'function' }; Set-Location $env:TEMP; Write-Output first",
          cmd: "set OPENCODE_LANE_TEST=yes&& cd /d %TEMP%&& echo first",
          posix:
            'export OPENCODE_LANE_TEST=yes; opencode_lane_value() { printf function; }; cd "${TMPDIR:-/tmp}"; printf first',
        }),
      )
      expect(first.running).toBe(false)
      expect(first.metadata.laneID).toBe(0)
      expect(first.metadata.shellReused).toBe(false)

      let preparedCwd = ""
      const second = yield* lane(
        shellCommand({
          ps: 'Write-Output "$($env:OPENCODE_LANE_TEST):$($OpenCodeLaneScalar):$(Get-OpenCodeLaneValue):$((Get-Location).Path)"',
          cmd: "echo %OPENCODE_LANE_TEST%:%CD%",
          posix: 'printf \'%s:%s:%s\' "$OPENCODE_LANE_TEST" "$(opencode_lane_value)" "$PWD"',
        }),
        { onPrepare: (cwd) => (preparedCwd = cwd) },
      )
      expect(second.metadata.shellReused).toBe(true)
      expect(second.metadata.shellGeneration).toBe(first.metadata.shellGeneration)
      expect(second.output).toContain("yes")
      if (Shell.ps(Shell.acceptable())) expect(second.output).toContain("scalar:function")
      expect(second.metadata.cwd).toBe(preparedCwd)
    }),
  )

  it.instance("runs Remove-Item from strict external PowerShell scripts", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const test = yield* TestInstance

      for (const [index, shell] of powerShellShells.entries()) {
        const target = path.join(test.directory, `strict-external-${index}.txt`)
        const script = path.join(test.directory, `UserScript-${index}.ps1`)
        yield* Effect.promise(() => Bun.write(target, "probe"))
        yield* Effect.promise(() =>
          Bun.write(
            script,
            [
              "param([string] $Target)",
              "Set-StrictMode -Version Latest",
              "$env:OPENCODE_EXTERNAL_SCRIPT_PROVIDER = 'probe'",
              "Remove-Item -LiteralPath $Target",
              "Remove-Item Env:OPENCODE_EXTERNAL_SCRIPT_PROVIDER",
              'Write-Output "file=$(Test-Path -LiteralPath $Target);env=$(Test-Path Env:OPENCODE_EXTERNAL_SCRIPT_PROVIDER)"',
            ].join("\n"),
          ),
        )
        const result = yield* lane(`& '${script.replaceAll("'", "''")}' -Target '${target.replaceAll("'", "''")}'`, {
          laneID: index,
          shell,
        })
        expect(result.error).toBeUndefined()
        expect(result.output).toContain("file=False;env=False")
        expect(result.output).not.toContain("cannot be retrieved because it has not been set")
      }
    }),
  )

  it.instance("does not trust mutable shell cwd variables", () =>
    Effect.gen(function* () {
      const result = yield* lane(
        shellCommand({
          ps: "$env:PWD = 'C:\\spoofed'; Set-Location -LiteralPath $env:TEMP",
          cmd: 'cd /d "%TEMP%"&& set "CD=C:\\spoofed"',
          posix: 'cd "${TMPDIR:-/tmp}"; PWD=/spoofed',
        }),
        { laneID: 0 },
      )
      expect(typeof result.metadata.cwd).toBe("string")
      if (typeof result.metadata.cwd !== "string") return
      const expected = yield* Effect.promise(() => fs.realpath(os.tmpdir()))
      const normalize = (value: string) =>
        process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
      expect(normalize(result.metadata.cwd)).toBe(normalize(expected))
    }),
  )

  it.instance(
    "reports a missing POSIX workdir without losing the lane",
    () =>
      Effect.gen(function* () {
        const shell = process.platform === "win32" ? Shell.gitbash() : Shell.acceptable()
        if (!shell || !Shell.posix(shell)) return
        const workdir = path.join(os.tmpdir(), `opencode-missing-workdir-${crypto.randomUUID()}`)
        const seeded = yield* lane("printf seeded", { laneID: 0, shell })
        const moved = yield* lane("pwd -P", { laneID: 0, shell, workdir: os.tmpdir() })
        const normalize = (value: string) =>
          process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
        expect(moved.exitCode).toBe(0)
        expect(typeof moved.metadata.cwd).toBe("string")
        expect(typeof seeded.metadata.cwd).toBe("string")
        if (!moved.metadata.cwd || !seeded.metadata.cwd) return
        if (process.platform === "win32") expect(path.win32.isAbsolute(moved.metadata.cwd)).toBe(true)
        else expect(moved.output.trim()).toBe(moved.metadata.cwd)
        expect(normalize(moved.metadata.cwd)).not.toBe(normalize(seeded.metadata.cwd))
        const failed = yield* lane("printf should-not-run", {
          laneID: 0,
          shell,
          workdir,
        })
        expect(failed.running).toBe(false)
        expect(failed.error).toBeUndefined()
        expect(failed.exitCode).not.toBe(0)
        expect(failed.output).not.toContain("should-not-run")

        const recovered = yield* lane("printf recovered", { laneID: 0, shell })
        expect(recovered.output).toBe("recovered")
        expect(recovered.metadata.shellGeneration).toBe(seeded.metadata.shellGeneration)
        expect(recovered.metadata.shellReused).toBe(true)
      }),
    15_000,
  )

  it.instance("loses a POSIX lane when its physical cwd can no longer be reported", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const shell = Shell.acceptable()
      if (!Shell.posix(shell)) return
      const directory = path.join(os.tmpdir(), `opencode-deleted-cwd-${crypto.randomUUID()}`)
      const quoted = `'${directory.replaceAll("'", `'\\''`)}'`
      const result = yield* lane(`mkdir -p -- ${quoted}; cd -- ${quoted}; rmdir -- ${quoted}`, {
        laneID: 0,
        shell,
      })
      expect(result.metadata.outputError).toContain("invalid completion frame")
      const recovered = yield* lane("printf recovered", { laneID: 0, shell })
      expect(recovered.output).toBe("recovered")
      expect(recovered.warning).toContain("previous shell state was lost")
      expect(recovered.metadata.shellReused).toBe(false)
    }),
  )

  it.instance("loses a PowerShell lane after changing to a non-filesystem provider", () =>
    Effect.gen(function* () {
      const shell = Shell.acceptable()
      if (!Shell.ps(shell)) return
      const result = yield* lane("Set-Location Env:", { laneID: 0, shell })
      expect(result.metadata.outputError).toContain("invalid completion frame")
      expect(result.output).toContain("location is not a FileSystem path")
      const recovered = yield* lane("Write-Output recovered", { laneID: 0, shell })
      expect(recovered.output).toContain("recovered")
      expect(recovered.warning).toContain("previous shell state was lost")
      expect(recovered.metadata.shellReused).toBe(false)
    }),
  )

  it.instance(
    "preserves the trailing newline in TTY command output",
    () =>
      Effect.gen(function* () {
        const started = yield* lane(
          shellCommand({ ps: "Write-Output tty-line", cmd: "echo tty-line", posix: "printf 'tty-line\\n'" }),
          { laneID: 0, tty: true },
        )
        const result = started.running ? yield* finish(started.execID!) : started
        expect(result.running).toBe(false)
        expect(result.metadata.output).toContain("tty-line")
        expect(result.metadata.output.endsWith("\n")).toBe(true)
      }),
    15_000,
  )

  it.instance("does not expose runner arguments to POSIX commands", () =>
    Effect.gen(function* () {
      const shell = process.platform === "win32" ? Shell.gitbash() : Shell.acceptable()
      if (!shell || !Shell.posix(shell)) return
      const result = yield* lane('printf \'%s:%s:%s:%s\' "$#" "${1-}" "${2-}" "${3-}"', {
        laneID: 0,
        shell,
      })
      expect(result.output).toBe("0:::")
    }),
  )

  it.instance("prepares commands before creating or resetting a lane", () =>
    Effect.gen(function* () {
      const deniedNew = yield* Effect.exit(
        lane("echo should-not-run", {
          laneID: 0,
          prepareError: new Error("permission denied"),
        }),
      )
      expect(Exit.isFailure(deniedNew)).toBe(true)
      if (Exit.isFailure(deniedNew)) expect(Cause.pretty(deniedNew.cause)).toContain("permission denied")

      const first = yield* lane(shellCommand({ ps: "Write-Output first", cmd: "echo first", posix: "printf first" }), {
        laneID: 0,
      })
      expect(first.metadata.shellGeneration).toBe(1)
      expect(first.metadata.shellReused).toBe(false)

      const seeded = yield* lane(
        shellCommand({
          ps: "$env:OPENCODE_PREPARE_ORDER = 'kept'; Write-Output seeded",
          cmd: "set OPENCODE_PREPARE_ORDER=kept&& echo seeded",
          posix: "export OPENCODE_PREPARE_ORDER=kept; printf seeded",
        }),
        { laneID: 1 },
      )
      const deniedReset = yield* Effect.exit(
        lane("echo should-not-run", {
          laneID: 1,
          resetLane: true,
          prepareError: new Error("permission denied"),
        }),
      )
      expect(Exit.isFailure(deniedReset)).toBe(true)
      if (Exit.isFailure(deniedReset)) expect(Cause.pretty(deniedReset.cause)).toContain("permission denied")

      const reused = yield* lane(
        shellCommand({
          ps: "Write-Output $env:OPENCODE_PREPARE_ORDER",
          cmd: "echo %OPENCODE_PREPARE_ORDER%",
          posix: 'printf %s "$OPENCODE_PREPARE_ORDER"',
        }),
        { laneID: 1 },
      )
      expect(reused.output).toContain("kept")
      expect(reused.metadata.shellGeneration).toBe(seeded.metadata.shellGeneration)
      expect(reused.metadata.shellReused).toBe(true)
    }),
  )

  it.instance("leaves a slot lost when its destructive reset fails to start", () =>
    Effect.gen(function* () {
      const seeded = yield* lane(
        shellCommand({
          ps: "$env:OPENCODE_FAILED_RESET = 'kept'; Write-Output seeded",
          cmd: "set OPENCODE_FAILED_RESET=kept&& echo seeded",
          posix: "export OPENCODE_FAILED_RESET=kept; printf seeded",
        }),
        { laneID: 0 },
      )
      const failed = yield* lane("echo should-not-run", {
        laneID: 0,
        resetLane: true,
        shell: missingShell(),
      })
      expect(failed.error).toMatch(/could not (start|initialize) persistent shell/)
      const recovered = yield* lane(
        shellCommand({
          ps: "Write-Output recovered",
          cmd: "echo recovered",
          posix: "printf recovered",
        }),
        { laneID: 0 },
      )
      expect(recovered.output).toContain("recovered")
      expect(recovered.warning).toContain("previous shell state was lost")
      expect(recovered.metadata.shellGeneration).toBeGreaterThan(seeded.metadata.shellGeneration ?? 0)
      expect(recovered.metadata.shellReused).toBe(false)
    }),
  )

  it.instance("releases a reused lane reservation when launch is interrupted", () =>
    Effect.gen(function* () {
      const seeded = yield* lane(
        shellCommand({
          ps: "$env:OPENCODE_INTERRUPTED_REUSE = 'kept'; Write-Output seeded",
          cmd: "set OPENCODE_INTERRUPTED_REUSE=kept&& echo seeded",
          posix: "export OPENCODE_INTERRUPTED_REUSE=kept; printf seeded",
        }),
        { laneID: 0 },
      )
      const blocked = yield* blockedReservation()
      const fiber = yield* lane("echo should-not-run", {
        laneID: 0,
        onLaneReserved: blocked.hook,
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(blocked.reserved)
      yield* Fiber.interrupt(fiber)
      const reused = yield* lane(
        shellCommand({
          ps: "Write-Output $env:OPENCODE_INTERRUPTED_REUSE",
          cmd: "echo %OPENCODE_INTERRUPTED_REUSE%",
          posix: 'printf %s "$OPENCODE_INTERRUPTED_REUSE"',
        }),
        { laneID: 0 },
      )
      expect(reused.output).toContain("kept")
      expect(reused.metadata.shellGeneration).toBe(seeded.metadata.shellGeneration)
      expect(reused.metadata.shellReused).toBe(true)
    }),
  )

  it.instance("leaves a slot lost when a destructive reset is interrupted", () =>
    Effect.gen(function* () {
      const seeded = yield* lane(
        shellCommand({
          ps: "$env:OPENCODE_INTERRUPTED_RESET = 'kept'; Write-Output seeded",
          cmd: "set OPENCODE_INTERRUPTED_RESET=kept&& echo seeded",
          posix: "export OPENCODE_INTERRUPTED_RESET=kept; printf seeded",
        }),
        { laneID: 0 },
      )
      const blocked = yield* blockedReservation()
      const fiber = yield* lane("echo should-not-run", {
        laneID: 0,
        resetLane: true,
        onLaneReserved: blocked.hook,
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(blocked.reserved)
      yield* Fiber.interrupt(fiber)
      const recovered = yield* lane(
        shellCommand({
          ps: "Write-Output recovered",
          cmd: "echo recovered",
          posix: "printf recovered",
        }),
        { laneID: 0 },
      )
      expect(recovered.output).toContain("recovered")
      expect(recovered.warning).toContain("previous shell state was lost")
      expect(recovered.metadata.shellGeneration).toBeGreaterThan(seeded.metadata.shellGeneration ?? 0)
      expect(recovered.metadata.shellReused).toBe(false)
    }),
  )

  it.instance("invalidates a reused lane when its request cannot be written", () =>
    Effect.gen(function* () {
      yield* lane(shellCommand({ ps: "Write-Output seeded", cmd: "echo seeded", posix: "printf seeded" }), {
        laneID: 0,
      })
      const failed = yield* lane("echo should-not-run", {
        laneID: 0,
        failLaneRequest: true,
      })
      expect(failed.error).toContain("stdin is unavailable")
      const recovered = yield* lane(
        shellCommand({ ps: "Write-Output recovered", cmd: "echo recovered", posix: "printf recovered" }),
        {
          laneID: 0,
        },
      )
      expect(recovered.output).toContain("recovered")
      expect(recovered.warning).toContain("previous shell state was lost")
      expect(recovered.metadata.shellReused).toBe(false)
    }),
  )

  it.instance("preserves native exit codes and keeps the lane reusable", () =>
    Effect.gen(function* () {
      if (!Shell.ps(Shell.acceptable())) return
      const failed = yield* lane("cmd.exe /d /c exit 23", { laneID: 0 })
      expect(failed.exitCode).toBe(23)
      const recovered = yield* lane("Write-Output recovered", { laneID: 0 })
      expect(recovered.exitCode).toBe(0)
      expect(recovered.output).toContain("recovered")
      expect(recovered.metadata.shellReused).toBe(true)
    }),
  )

  it.instance("contains explicit PowerShell exit in the current execution", () =>
    Effect.gen(function* () {
      for (const [index, shell] of powerShellShells.entries()) {
        const seeded = yield* lane(
          "$OpenCodeExitState = 'kept'; function Get-OpenCodeExitState { 'function' }; Set-Location $env:TEMP; exit 29",
          { laneID: index, shell },
        )
        expect(seeded.exitCode).toBe(29)
        expect(seeded.metadata.outputError).toBeUndefined()

        const reused = yield* lane(
          'Write-Output ("{0}:{1}:{2}" -f $OpenCodeExitState,(Get-OpenCodeExitState),(Get-Location).Path)',
          { laneID: index, shell },
        )
        expect(reused.exitCode).toBe(0)
        expect(reused.output).toContain("kept:function")
        expect(reused.metadata.shellReused).toBe(true)
        expect(reused.metadata.shellGeneration).toBe(seeded.metadata.shellGeneration)
      }
    }),
  )

  it.instance("contains conventional PowerShell native exit propagation", () =>
    Effect.gen(function* () {
      for (const [index, shell] of powerShellShells.entries()) {
        const failed = yield* lane("cmd.exe /d /c exit 17; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }", {
          laneID: index,
          shell,
        })
        expect(failed.exitCode).toBe(17)
        expect(failed.metadata.outputError).toBeUndefined()

        const recovered = yield* lane("cmd.exe /d /c exit 23; Write-Output recovered", { laneID: index, shell })
        expect(recovered.exitCode).toBe(0)
        expect(recovered.output).toContain("recovered")
        expect(recovered.metadata.shellGeneration).toBe(failed.metadata.shellGeneration)

        const reused = yield* lane("Write-Output reused", { laneID: index, shell })
        expect(reused.output).toContain("reused")
        expect(reused.metadata.shellReused).toBe(true)
        expect(reused.metadata.shellGeneration).toBe(failed.metadata.shellGeneration)
      }
    }),
  )

  it.instance("reports terminating PowerShell errors without losing the lane", () =>
    Effect.gen(function* () {
      for (const [index, shell] of powerShellShells.entries()) {
        const failed = yield* lane("throw 'boundary-boom'", { laneID: index, shell })
        expect(failed.exitCode).toBe(1)
        expect(failed.output).toContain("boundary-boom")
        expect(failed.output).not.toContain('Exception calling "Invoke"')
        expect(failed.output).not.toContain("PipelineBase.Invoke")
        expect(failed.output).not.toContain("PowerShell.CoreInvoke")
        expect(failed.output).not.toContain("Stack trace")

        const reused = yield* lane("Write-Output reused", { laneID: index, shell })
        expect(reused.output).toContain("reused")
        expect(reused.metadata.shellReused).toBe(true)
        expect(reused.metadata.shellGeneration).toBe(failed.metadata.shellGeneration)
      }
    }),
  )

  it.instance("preserves imported PowerShell modules across isolated executions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      for (const [index, shell] of powerShellShells.entries()) {
        const module = path.join(test.directory, `ExitBoundaryModule-${index}.psm1`)
        yield* Effect.promise(() =>
          Bun.write(
            module,
            'function Get-ExitBoundaryModuleValue { "module-kept" }; Export-ModuleMember -Function Get-ExitBoundaryModuleValue',
          ),
        )
        const imported = yield* lane(`Import-Module '${module.replaceAll("'", "''")}' -Force`, {
          laneID: index,
          shell,
        })
        expect(imported.exitCode).toBe(0)

        const reused = yield* lane(
          `Write-Output "$([bool](Get-Module 'ExitBoundaryModule-${index}')):$(Get-ExitBoundaryModuleValue)"`,
          { laneID: index, shell },
        )
        expect(reused.output).toContain("True:module-kept")
        expect(reused.metadata.shellReused).toBe(true)
        expect(reused.metadata.shellGeneration).toBe(imported.metadata.shellGeneration)
      }
    }),
  )

  it.instance("does not reuse a previous PowerShell native exit code", () =>
    Effect.gen(function* () {
      if (!Shell.ps(Shell.acceptable())) return
      const native = yield* lane("cmd.exe /d /c exit 23", { laneID: 0 })
      expect(native.exitCode).toBe(23)
      const cmdlet = yield* lane("Write-Error boom", { laneID: 0 })
      expect(cmdlet.exitCode).toBe(1)
      expect(cmdlet.metadata.shellReused).toBe(true)
    }),
  )

  it.instance("collects stderr before completing a lane command", () =>
    Effect.gen(function* () {
      const executable = process.execPath
      const result = yield* lane(
        shellCommand({
          ps: `& '${executable.replaceAll("'", "''")}' -e "process.stderr.write('stderr-tail')"`,
          cmd: `"${executable.replaceAll('"', '""')}" -e "process.stderr.write('stderr-tail')"`,
          posix: `${JSON.stringify(executable)} -e "process.stderr.write('stderr-tail')"`,
        }),
        { laneID: 0 },
      )
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain("stderr-tail")
      expect(result.metadata.output).toContain("stderr-tail")
    }),
  )

  it.instance("returns promptly when the background watcher observes completion first", () =>
    Effect.gen(function* () {
      const result = yield* lane(shellCommand({ ps: "Write-Output quick", cmd: "echo quick", posix: "printf quick" }), {
        laneID: 0,
        yieldTimeMs: 10_000,
      })
      expect(result.running).toBe(false)
      expect(result.output).toContain("quick")
      expect(result.wallTimeMs).toBeLessThan(5_000)
    }),
  )

  it.instance("runs PowerShell command files with UTF-8 cwd and output", () =>
    Effect.gen(function* () {
      if (!Shell.ps(Shell.acceptable())) return
      const unicode = String.fromCodePoint(0x5de5, 0x4f5c)
      const directory = path.join(os.tmpdir(), `opencode-${unicode}-${crypto.randomUUID()}`)
      yield* Effect.promise(() => fs.mkdir(directory))
      const escaped = directory.replaceAll("'", "''")
      const before = new Set(
        (yield* Effect.promise(() => fs.readdir(os.tmpdir()))).filter((file) => file.startsWith("opencode-exec-")),
      )
      const marker = `OPENCODE_COMMAND_LINE_${crypto.randomUUID().replaceAll("-", "")}`
      const result = yield* lane(
        `Set-Location -LiteralPath '${escaped}'; Write-Output '${unicode}-output'; if ([Environment]::CommandLine.Contains('${marker}')) { Write-Output visible } else { Write-Output hidden }`,
        { laneID: 0 },
      )
      expect(result.output).toContain(`${unicode}-output`)
      expect(result.output).toContain("hidden")
      expect(result.metadata.cwd).toBe(directory)
      const created = (yield* Effect.promise(() => fs.readdir(os.tmpdir()))).filter(
        (file) => file.startsWith("opencode-exec-") && !before.has(file),
      )
      expect(created).toEqual([])
      yield* Effect.promise(() => fs.rmdir(directory))
    }),
  )

  it.instance("runs different lanes concurrently and rejects a busy lane", () =>
    Effect.gen(function* () {
      const sessions = yield* ExecSession.Service
      const waiting = yield* lane(
        shellCommand({
          ps: "Write-Output ready; Start-Sleep 30",
          cmd: "echo ready&& ping -n 31 127.0.0.1 >nul",
          posix: "printf ready; sleep 30",
        }),
        { laneID: 0, yieldTimeMs: 500 },
      )
      expect(waiting.running).toBe(true)
      const busy = yield* lane("echo should-not-run", { laneID: 0, yieldTimeMs: 0 })
      expect(busy.error).toContain("busy")
      const resetBusy = yield* lane("echo should-not-run", { laneID: 0, resetLane: true, yieldTimeMs: 0 })
      expect(resetBusy.error).toContain("busy")
      const parallel = yield* lane(
        shellCommand({ ps: "Write-Output parallel", cmd: "echo parallel", posix: "printf parallel" }),
        { laneID: 1 },
      )
      expect(parallel.output).toContain("parallel")
      yield* sessions.terminate({ execID: waiting.execID!, invocation: invocation("terminate") })
    }),
  )

  it.instance("serializes overlapping short commands in the same lane", () =>
    Effect.gen(function* () {
      const blocked = yield* blockedReservation()
      const first = yield* lane(shellCommand({ ps: "Write-Output first", cmd: "echo first", posix: "printf first" }), {
        laneID: 0,
        onLaneReserved: blocked.hook,
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(blocked.reserved)
      const second = yield* lane(
        shellCommand({ ps: "Write-Output second", cmd: "echo second", posix: "printf second" }),
        { laneID: 0 },
      ).pipe(Effect.forkScoped)
      const early = yield* Fiber.join(second).pipe(Effect.timeout("100 millis"), Effect.option)
      expect(early._tag).toBe("None")
      yield* Deferred.succeed(blocked.release, undefined)

      const firstResult = yield* Fiber.join(first)
      const secondResult = yield* Fiber.join(second)
      expect(firstResult.output).toContain("first")
      expect(secondResult.output).toContain("second")
      expect(secondResult.error).toBeUndefined()
      expect(secondResult.metadata.shellReused).toBe(true)
    }),
  )

  it.instance("preserves FIFO order for multiple queued commands", () =>
    Effect.gen(function* () {
      const blocked = yield* blockedReservation()
      const prepared: string[] = []
      const first = yield* lane(shellCommand({ ps: "Write-Output first", cmd: "echo first", posix: "printf first" }), {
        laneID: 0,
        onPrepare: () => prepared.push("first"),
        onLaneReserved: blocked.hook,
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(blocked.reserved)
      const second = yield* lane(
        shellCommand({ ps: "Write-Output second", cmd: "echo second", posix: "printf second" }),
        { laneID: 0, onPrepare: () => prepared.push("second") },
      ).pipe(Effect.forkScoped)
      yield* Effect.sleep("10 millis")
      const third = yield* lane(shellCommand({ ps: "Write-Output third", cmd: "echo third", posix: "printf third" }), {
        laneID: 0,
        onPrepare: () => prepared.push("third"),
      }).pipe(Effect.forkScoped)
      yield* Deferred.succeed(blocked.release, undefined)

      expect((yield* Fiber.join(first)).output).toContain("first")
      expect((yield* Fiber.join(second)).output).toContain("second")
      expect((yield* Fiber.join(third)).output).toContain("third")
      expect(prepared).toEqual(["first", "second", "third"])
    }),
  )

  it.instance("reads persistent session state only once before execution registration", () =>
    Effect.gen(function* () {
      const source = { ...invocation("root"), sessionID: SessionID.make("ses_single_session_read") }
      sessionReadCounts.delete(source.sessionID)
      const result = yield* lane(shellCommand({ ps: "Write-Output ready", cmd: "echo ready", posix: "printf ready" }), {
        laneID: 0,
        source,
      })
      expect(result.output).toContain("ready")
      expect(sessionReadCounts.get(source.sessionID)).toBe(1)
    }),
  )

  it.instance("reports busy after an earlier same-lane command returns as running", () =>
    Effect.gen(function* () {
      const sessions = yield* ExecSession.Service
      const blocked = yield* blockedReservation()
      const first = yield* lane(
        shellCommand({
          ps: "Write-Output ready; Start-Sleep 30",
          cmd: "echo ready&& ping -n 31 127.0.0.1 >nul",
          posix: "printf ready; sleep 30",
        }),
        {
          laneID: 0,
          yieldTimeMs: 500,
          onLaneReserved: blocked.hook,
        },
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(blocked.reserved)
      const second = yield* lane("echo should-not-run", { laneID: 0, yieldTimeMs: 0 }).pipe(Effect.forkScoped)
      const early = yield* Fiber.join(second).pipe(Effect.timeout("100 millis"), Effect.option)
      expect(early._tag).toBe("None")
      yield* Deferred.succeed(blocked.release, undefined)

      const firstResult = yield* Fiber.join(first)
      const secondResult = yield* Fiber.join(second)
      expect(firstResult.running).toBe(true)
      expect(secondResult.error).toContain(`busy with execution ${firstResult.execID}`)
      yield* sessions.terminate({ execID: firstResult.execID!, invocation: invocation("terminate") })
    }),
  )

  it.instance(
    "atomically limits concurrent execution registration",
    () =>
      Effect.gen(function* () {
        const sessions = yield* ExecSession.Service
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let reserved = 0
        const command = shellCommand({
          ps: "Start-Sleep 30",
          cmd: "ping -n 31 127.0.0.1 >nul",
          posix: "sleep 30",
        })
        const fibers = yield* Effect.forEach(
          Array.from({ length: 26 }, (_, index) => index),
          (index) =>
            lane(command, {
              laneID: 0,
              yieldTimeMs: 0,
              source: {
                ...invocation("root"),
                sessionID: SessionID.make(`ses_running_limit_${index}`),
              },
              onLaneReserved: () =>
                Effect.gen(function* () {
                  reserved++
                  if (reserved === 26) yield* Deferred.succeed(ready, undefined)
                  yield* Deferred.await(release)
                }),
            }).pipe(Effect.forkScoped),
        )
        yield* Deferred.await(ready)
        yield* Deferred.succeed(release, undefined)
        const results = yield* Effect.forEach(fibers, Fiber.join, { concurrency: "unbounded" })
        const running = results.flatMap((result, index) => (result.running ? [{ result, index }] : []))
        const rejected = results.filter((result) => result.error?.includes("too many running executions"))
        expect(running).toHaveLength(25)
        expect(rejected).toHaveLength(1)
        yield* Effect.forEach(
          running,
          ({ result, index }) =>
            sessions.terminate({
              execID: result.execID!,
              invocation: {
                ...invocation("terminate"),
                sessionID: SessionID.make(`ses_running_limit_${index}`),
              },
            }),
          { concurrency: "unbounded", discard: true },
        )
      }),
    120_000,
  )

  it.instance("automatically rebuilds a lane after termination and increments the generation", () =>
    Effect.gen(function* () {
      const sessions = yield* ExecSession.Service
      const waiting = yield* lane(
        shellCommand({ ps: "Start-Sleep 30", cmd: "ping -n 31 127.0.0.1 >nul", posix: "sleep 30" }),
        {
          laneID: 0,
          yieldTimeMs: 0,
        },
      )
      yield* sessions.terminate({ execID: waiting.execID!, invocation: invocation("terminate") })
      const rebuilt = yield* lane(
        shellCommand({ ps: "Write-Output rebuilt", cmd: "echo rebuilt", posix: "printf rebuilt" }),
        { laneID: 0 },
      )
      expect(rebuilt.output).toContain("rebuilt")
      expect(rebuilt.warning).toContain("execution terminated")
      expect(rebuilt.metadata.shellGeneration).toBeGreaterThan(waiting.metadata.shellGeneration ?? 0)
      expect(rebuilt.metadata.shellReused).toBe(false)
    }),
  )

  it.instance(
    "keeps fixed lost slots bounded and removes their runner files",
    () =>
      Effect.gen(function* () {
        const prefix = "opencode-lane-"
        const before = new Set(
          (yield* Effect.promise(() => fs.readdir(os.tmpdir(), { withFileTypes: true })))
            .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
            .map((entry) => entry.name),
        )
        for (let index = 0; index < 8; index++) {
          const result = yield* lane(shellCommand({ ps: "[Environment]::Exit(0)", cmd: "exit", posix: "exit" }), {
            laneID: index,
          })
          expect(result.running).toBe(false)
        }
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const created = (yield* Effect.promise(() => fs.readdir(os.tmpdir(), { withFileTypes: true })))
              .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && !before.has(entry.name))
              .map((entry) => entry.name)
            return created.length === 0 ? true : undefined
          }),
          "lost lane runner files were not removed",
          "5 seconds",
        )

        const rebuilt = yield* lane(
          shellCommand({ ps: "Write-Output rebuilt", cmd: "echo rebuilt", posix: "printf rebuilt" }),
          { laneID: 7 },
        )
        expect(rebuilt.output).toContain("rebuilt")
        expect(rebuilt.warning).toContain("previous shell state was lost")
      }),
    30_000,
  )

  it.instance(
    "reaps the least recently used unreserved idle lane after exceeding the workspace soft target",
    () =>
      Effect.gen(function* () {
        const source = (session: string) => ({
          ...invocation("root"),
          sessionID: SessionID.make(session),
        })
        const command = shellCommand({ ps: "Write-Output ready", cmd: "echo ready", posix: "printf ready" })
        const createIdle = Effect.fnUntraced(function* (session: string, laneID: number) {
          const invocation = source(session)
          const started = yield* lane(command, { laneID, source: invocation })
          const completed = started.running
            ? yield* finish(started.execID!, { ...invocation, display: "poll" })
            : started
          expect(completed.error).toBeUndefined()
        })
        for (let index = 0; index < 4; index++) yield* createIdle("ses_lane_limit_a", index)
        for (let index = 0; index < 3; index++) yield* createIdle("ses_lane_limit_b", index)

        const blocked = yield* blockedReservation()
        const reserved = yield* lane(command, {
          laneID: 0,
          source: source("ses_lane_limit_a"),
          onLaneReserved: blocked.hook,
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(blocked.reserved)

        yield* createIdle("ses_lane_limit_b", 3)
        const added = yield* lane(command, {
          laneID: 0,
          source: source("ses_lane_limit_c"),
        })
        expect(added.error).toBeUndefined()
        expect(added.metadata.shellGeneration).toBe(1)

        yield* Deferred.succeed(blocked.release, undefined)
        const retained = yield* Fiber.join(reserved)
        expect(retained.error).toBeUndefined()
        expect(retained.metadata.shellReused).toBe(true)

        const rebuilt = yield* lane(command, { laneID: 1, source: source("ses_lane_limit_a") })
        expect(rebuilt.error).toBeUndefined()
        expect(rebuilt.warning).toContain("reaped")
        expect(rebuilt.metadata.shellGeneration).toBe(2)
      }),
    60_000,
  )

  it.instance("releases live lanes when their session is archived", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const sessionID = scopedSession(SessionID.make("ses_archived_lifecycle"))
      const source = { ...invocation("root"), sessionID }
      const first = yield* lane(shellCommand({ ps: "Write-Output first", cmd: "echo first", posix: "printf first" }), {
        laneID: 0,
        source,
      })
      sessionTimes.set(sessionID, { created: Date.now(), updated: Date.now(), archived: Date.now() })
      yield* events.publish(Session.Event.Updated, {
        sessionID,
        info: {
          id: sessionID,
          slug: "archived-session",
          projectID: ProjectV2.ID.global,
          directory: process.cwd(),
          title: "Archived session",
          version: "test",
          time: { created: Date.now(), updated: Date.now(), archived: Date.now() },
        },
      })
      const archived = yield* lane("echo should-not-run", { laneID: 0, yieldTimeMs: 0, source })
      expect(archived.error).toContain("session is archived")
      sessionTimes.set(sessionID, { created: Date.now(), updated: Date.now(), archived: 0 })
      yield* events.publish(Session.Event.Updated, {
        sessionID,
        info: {
          id: sessionID,
          slug: "unarchived-session",
          projectID: ProjectV2.ID.global,
          directory: process.cwd(),
          title: "Unarchived session",
          version: "test",
          time: { created: Date.now(), updated: Date.now(), archived: 0 },
        },
      })
      const rebuilt = yield* lane(
        shellCommand({ ps: "Write-Output rebuilt", cmd: "echo rebuilt", posix: "printf rebuilt" }),
        { laneID: 0, source },
      )
      expect(rebuilt.output).toContain("rebuilt")
      expect(rebuilt.warning).toContain("session archived")
      expect(rebuilt.metadata.shellGeneration).toBeGreaterThan(first.metadata.shellGeneration ?? 0)
    }),
  )

  it.instance("cleans an uncommitted candidate when its session is archived", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const sessionID = scopedSession(SessionID.make("ses_archived_candidate"))
      const source = { ...invocation("root"), sessionID }
      const blocked = yield* blockedReservation()
      const fiber = yield* lane("echo should-not-run", {
        laneID: 0,
        source,
        onLaneReserved: blocked.hook,
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(blocked.reserved)
      const queued = yield* lane("echo queued-should-not-run", { laneID: 0, source }).pipe(Effect.forkScoped)
      expect((yield* Fiber.join(queued).pipe(Effect.timeout("100 millis"), Effect.option))._tag).toBe("None")
      sessionTimes.set(sessionID, { created: Date.now(), updated: Date.now(), archived: Date.now() })
      yield* events.publish(Session.Event.Updated, {
        sessionID,
        info: {
          id: sessionID,
          slug: "archived-candidate",
          projectID: ProjectV2.ID.global,
          directory: process.cwd(),
          title: "Archived candidate",
          version: "test",
          time: { created: Date.now(), updated: Date.now(), archived: Date.now() },
        },
      })
      const result = yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"))
      expect(result.error).toContain("preparation was invalidated")
      const queuedResult = yield* Fiber.join(queued).pipe(Effect.timeout("1 second"))
      expect(queuedResult.error).toContain("queued command was invalidated")
      expect(queuedResult.output).not.toContain("queued-should-not-run")
      sessionTimes.set(sessionID, { created: Date.now(), updated: Date.now(), archived: 0 })
      yield* events.publish(Session.Event.Updated, {
        sessionID,
        info: {
          id: sessionID,
          slug: "restored-candidate",
          projectID: ProjectV2.ID.global,
          directory: process.cwd(),
          title: "Restored candidate",
          version: "test",
          time: { created: Date.now(), updated: Date.now(), archived: 0 },
        },
      })
      const restored = yield* lane(
        shellCommand({ ps: "Write-Output restored", cmd: "echo restored", posix: "printf restored" }),
        { laneID: 0, resetLane: true, source },
      )
      expect(restored.output).toContain("restored")
      expect(restored.metadata.shellGeneration).toBe(1)
    }),
  )

  it.instance("clears a slot launch queue when its session is deleted", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const blocked = yield* blockedReservation()
      const source = { ...invocation("root"), sessionID: SessionID.make("ses_delete_queued") }
      const first = yield* lane("echo should-not-run", {
        laneID: 0,
        source,
        onLaneReserved: blocked.hook,
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(blocked.reserved)
      const queued = yield* lane("echo queued-should-not-run", { laneID: 0, source }).pipe(Effect.forkScoped)
      expect((yield* Fiber.join(queued).pipe(Effect.timeout("100 millis"), Effect.option))._tag).toBe("None")
      yield* events.publish(Session.Event.Deleted, {
        sessionID: source.sessionID,
        info: {
          id: source.sessionID,
          slug: "deleted-queued-session",
          projectID: ProjectV2.ID.global,
          directory: process.cwd(),
          title: "Deleted queued session",
          version: "test",
          time: { created: Date.now(), updated: Date.now() },
        },
      })

      const firstResult = yield* Fiber.join(first).pipe(Effect.timeout("1 second"))
      expect(firstResult.error).toContain("preparation was invalidated")
      const queuedResult = yield* Fiber.join(queued).pipe(Effect.timeout("1 second"))
      expect(queuedResult.error).toContain("queued command was invalidated")
      expect(queuedResult.output).not.toContain("queued-should-not-run")
    }),
  )

  it.instance("uses persisted archive truthiness without an update event", () =>
    Effect.gen(function* () {
      const sessionID = scopedSession(SessionID.make("ses_persistently_archived"))
      sessionTimes.set(sessionID, { created: Date.now(), updated: Date.now(), archived: Date.now() })
      const archived = yield* lane("echo should-not-run", {
        laneID: 0,
        source: { ...invocation("root"), sessionID },
      })
      expect(archived.error).toContain("session is archived")
      sessionTimes.set(sessionID, { created: Date.now(), updated: Date.now(), archived: 0 })
      const restored = yield* lane(
        shellCommand({ ps: "Write-Output restored", cmd: "echo restored", posix: "printf restored" }),
        { laneID: 0, source: { ...invocation("root"), sessionID } },
      )
      expect(restored.output).toContain("restored")
    }),
  )

  it.instance(
    "removes lane records when their session is deleted",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const first = yield* lane(
          shellCommand({ ps: "Write-Output first", cmd: "echo first", posix: "printf first" }),
          {
            laneID: 0,
          },
        )
        const lost = yield* lane(shellCommand({ ps: "[Environment]::Exit(0)", cmd: "exit", posix: "exit" }), {
          laneID: 1,
        })
        const sessionID = invocation("root").sessionID
        yield* events.publish(Session.Event.Deleted, {
          sessionID,
          info: {
            id: sessionID,
            slug: "deleted-session",
            projectID: ProjectV2.ID.global,
            directory: process.cwd(),
            title: "Deleted session",
            version: "test",
            time: { created: Date.now(), updated: Date.now() },
          },
        })
        const recreated = yield* lane(
          shellCommand({ ps: "Write-Output recreated", cmd: "echo recreated", posix: "printf recreated" }),
          {
            laneID: 0,
          },
        )
        expect(recreated.error).toBeUndefined()
        expect(recreated.output).toContain("recreated")
        expect(recreated.metadata.shellReused).toBe(false)
        expect(recreated.metadata.shellGeneration).toBe(first.metadata.shellGeneration)
        const recreatedLost = yield* lane(
          shellCommand({ ps: "Write-Output recreated", cmd: "echo recreated", posix: "printf recreated" }),
          {
            laneID: 1,
          },
        )
        expect(recreatedLost.error).toBeUndefined()
        expect(recreatedLost.metadata.shellGeneration).toBe(lost.metadata.shellGeneration)
      }),
    15_000,
  )

  it.instance("preserves special cmd environment values without expanding them", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const shell = process.env.COMSPEC || Bun.which("cmd.exe")
      if (!shell) return
      const value = 'left%PATH%!bang!^&|<>"()  '
      const executable = process.execPath.replaceAll('"', '""')
      const result = yield* lane(
        `"${executable}" -e "process.stdout.write(JSON.stringify(process.env.OPENCODE_CMD_ENV))"`,
        {
          laneID: 0,
          shell,
          commandEnv: { OPENCODE_CMD_ENV: value },
        },
      )
      expect(result.exitCode).toBe(0)
      expect(result.output).toBe(JSON.stringify(value))
      expect(result.output).not.toContain(env.PATH)
    }),
  )

  it.instance(
    "treats plugin environment as immutable lane generation state",
    () =>
      Effect.gen(function* () {
        const key = `OPENCODE_GENERATION_ENV_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`
        const initial = yield* lane(
          shellCommand({
            ps: `$env:OPENCODE_GENERATION_STATE = 'kept'; Write-Output "$([Environment]::GetEnvironmentVariable('${key}')):$env:OPENCODE_GENERATION_STATE"`,
            cmd: `set OPENCODE_GENERATION_STATE=kept&& echo %${key}%:%OPENCODE_GENERATION_STATE%`,
            posix: `export OPENCODE_GENERATION_STATE=kept; printf '%s:%s' "$${key}" "$OPENCODE_GENERATION_STATE"`,
          }),
          {
            laneID: 0,
            commandEnv: { [key]: "first" },
          },
        )
        expect(initial.output).toContain("first:kept")

        const changed = yield* lane("echo should-not-run", {
          laneID: 0,
          commandEnv: { [key]: "second" },
        })
        expect(changed.error).toContain("environment changed")
        expect(changed.error).toContain("existing slot was preserved")

        const removed = yield* lane("echo should-not-run", { laneID: 0 })
        expect(removed.error).toContain("environment changed")

        const reused = yield* lane(
          shellCommand({
            ps: `Write-Output "$([Environment]::GetEnvironmentVariable('${key}')):$env:OPENCODE_GENERATION_STATE"`,
            cmd: `echo %${key}%:%OPENCODE_GENERATION_STATE%`,
            posix: `printf '%s:%s' "$${key}" "$OPENCODE_GENERATION_STATE"`,
          }),
          {
            laneID: 0,
            commandEnv: { [key]: "first" },
          },
        )
        expect(reused.output).toContain("first:kept")
        expect(reused.metadata.shellGeneration).toBe(initial.metadata.shellGeneration)
        expect(reused.metadata.shellReused).toBe(true)

        const reset = yield* lane(
          shellCommand({
            ps: `Write-Output ([Environment]::GetEnvironmentVariable('${key}'))`,
            cmd: `echo %${key}%`,
            posix: `printf %s "$${key}"`,
          }),
          {
            laneID: 0,
            resetLane: true,
            commandEnv: { [key]: "second" },
          },
        )
        const resetCompleted = reset.running ? yield* finish(reset.execID!) : reset
        expect(reset.output + resetCompleted.output).toContain("second")
        expect(resetCompleted.metadata.shellGeneration).toBeGreaterThan(initial.metadata.shellGeneration ?? 0)

        const cleared = yield* lane(
          shellCommand({
            ps: `if (Test-Path 'Env:${key}') { 'present' } else { 'absent' }`,
            cmd: `if defined ${key} (echo present) else (echo absent)`,
            posix: `if env | grep -q '^${key}='; then printf present; else printf absent; fi`,
          }),
          {
            laneID: 0,
            resetLane: true,
          },
        )
        expect(cleared.output).toContain("absent")
        expect(cleared.metadata.shellGeneration).toBeGreaterThan(reset.metadata.shellGeneration ?? 0)
      }),
    15_000,
  )

  it.instance("keeps lane files private and never writes plugin environment values", () =>
    Effect.gen(function* () {
      const secret = `secret-${crypto.randomUUID()}`
      const before = new Set(yield* Effect.promise(() => fs.readdir(os.tmpdir())))
      let inspected = false
      const result = yield* lane(shellCommand({ ps: "Write-Output ready", cmd: "echo ready", posix: "printf ready" }), {
        laneID: 0,
        commandEnv: { OPENCODE_FILE_SECRET: secret },
        onLaneReserved: () =>
          Effect.promise(async () => {
            const directories = (await fs.readdir(os.tmpdir(), { withFileTypes: true })).filter(
              (entry) => !before.has(entry.name) && entry.isDirectory() && entry.name.startsWith("opencode-lane-"),
            )
            expect(directories.length).toBeGreaterThan(0)
            const contents = (
              await Promise.all(
                directories.map(async (entry) => {
                  const directory = path.join(os.tmpdir(), entry.name)
                  if (process.platform !== "win32") {
                    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
                  }
                  const files = await fs.readdir(directory)
                  return Promise.all(
                    files.map(async (file) => {
                      const target = path.join(directory, file)
                      if (process.platform !== "win32") {
                        expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
                      }
                      return fs.readFile(target, "utf8")
                    }),
                  )
                }),
              )
            ).flat()
            expect(contents.join("\n")).not.toContain(secret)
            inspected = true
          }),
      })
      expect(result.output).toContain("ready")
      expect(inspected).toBe(true)
    }),
  )

  it.instance("writes stdin to a pipe lane command", () =>
    Effect.gen(function* () {
      if (!Shell.ps(Shell.acceptable())) return
      const sessions = yield* ExecSession.Service
      const started = yield* lane(
        'Write-Output ready; $value = [Console]::In.ReadLine(); Write-Output "received:$value"',
        {
          laneID: 0,
          yieldTimeMs: 500,
        },
      )
      expect(started.running).toBe(true)
      expect(started.output).toContain("ready")
      const written = yield* sessions.write({
        execID: started.execID!,
        chars: "hello\n",
        yieldTimeMs: 1_000,
        invocation: invocation("stdin"),
      })
      const result = written.running ? yield* finish(written.execID!) : written
      expect(written.output + result.output).toContain("received:hello")
    }),
  )

  const pipeShells = [
    Shell.ps(Shell.acceptable())
      ? {
          label: "powershell",
          shell: Shell.acceptable(),
          command:
            '$buffer = New-Object byte[] 5; $count = [Console]::OpenStandardInput().Read($buffer, 0, 5); Write-Output "received:$([Text.Encoding]::UTF8.GetString($buffer, 0, $count))"',
          input: "hello",
        }
      : undefined,
    windowsPowerShell && path.resolve(windowsPowerShell) !== path.resolve(Shell.acceptable())
      ? {
          label: "windows-powershell",
          shell: windowsPowerShell,
          command:
            '$buffer = New-Object byte[] 5; $count = [Console]::OpenStandardInput().Read($buffer, 0, 5); Write-Output "received:$([Text.Encoding]::UTF8.GetString($buffer, 0, $count))"',
          input: "hello",
        }
      : undefined,
    process.platform === "win32" && (process.env.COMSPEC || Bun.which("cmd.exe"))
      ? {
          label: "cmd",
          shell: process.env.COMSPEC || Bun.which("cmd.exe")!,
          command: 'set /p "OPENCODE_PIPE_INPUT="\r\necho received:%OPENCODE_PIPE_INPUT%',
          input: "hello\r\n",
        }
      : undefined,
    Shell.gitbash()
      ? {
          label: "posix",
          shell: Shell.gitbash()!,
          command: "IFS= read -r OPENCODE_PIPE_INPUT; printf 'received:%s\\n' \"$OPENCODE_PIPE_INPUT\"",
          input: "hello\n",
        }
      : undefined,
    process.platform !== "win32" && !Shell.ps(Shell.acceptable())
      ? {
          label: "posix",
          shell: Shell.acceptable(),
          command: "IFS= read -r OPENCODE_PIPE_INPUT; printf 'received:%s\\n' \"$OPENCODE_PIPE_INPUT\"",
          input: "hello\n",
        }
      : undefined,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item))

  for (const item of pipeShells) {
    it.instance(`gates immediate pipe input until the command starts [${item.label}]`, () =>
      Effect.gen(function* () {
        const sessions = yield* ExecSession.Service
        const started = yield* lane(item.command, {
          laneID: 0,
          shell: item.shell,
          yieldTimeMs: 0,
        })
        expect(started.running).toBe(true)
        const written = yield* sessions.write({
          execID: started.execID!,
          chars: item.input,
          yieldTimeMs: 1_000,
          invocation: invocation("stdin"),
        })
        const completed = written.running ? yield* finish(written.execID!) : written
        expect(written.output + completed.output).toContain("received:hello")
      }),
    )
  }

  it.instance("ends a pipe lane generation after sending EOF", () =>
    Effect.gen(function* () {
      if (!Shell.ps(Shell.acceptable())) return
      const sessions = yield* ExecSession.Service
      const started = yield* lane('$value = [Console]::In.ReadToEnd(); Write-Output "received:$value"', {
        laneID: 0,
        yieldTimeMs: 500,
      })
      const written = yield* sessions.write({
        execID: started.execID!,
        chars: "hello",
        closeStdin: true,
        yieldTimeMs: 1_000,
        invocation: invocation("stdin"),
      })
      const result = written.running ? yield* finish(written.execID!) : written
      expect(written.output + result.output).toContain("received:hello")
      const rebuilt = yield* lane("Write-Output rebuilt", { laneID: 0 })
      expect(rebuilt.output).toContain("rebuilt")
      expect(rebuilt.warning).toContain("stdin closed")
      expect(rebuilt.metadata.shellReused).toBe(false)
    }),
  )

  it.instance(
    "supports stdin and lane reuse in a TTY lane",
    () =>
      Effect.gen(function* () {
        if (!Shell.ps(Shell.acceptable())) return
        const sessions = yield* ExecSession.Service
        const started = yield* lane(
          '$value = Read-Host; $env:OPENCODE_TTY_VALUE = $value; Write-Output "received:$value"',
          {
            laneID: 0,
            tty: true,
            yieldTimeMs: 500,
          },
        )
        expect(started.running).toBe(true)
        const written = yield* sessions.write({
          execID: started.execID!,
          chars: "hello\r",
          yieldTimeMs: 1_000,
          invocation: invocation("stdin"),
        })
        const result = written.running ? yield* finish(written.execID!, invocation("poll"), "10 seconds") : written
        expect(written.output + result.output).toContain("received:hello")
        expect(written.metadata.output.trimEnd().endsWith("received:hello")).toBe(true)
        const reuseStarted = yield* lane("Write-Output $env:OPENCODE_TTY_VALUE", { laneID: 0 })
        const reused = reuseStarted.running
          ? yield* finish(reuseStarted.execID!, invocation("poll"), "10 seconds")
          : reuseStarted
        expect(reused.output).toContain("hello")
        expect(reused.metadata.shellReused).toBe(true)
      }),
    15_000,
  )

  const terminalShells = [
    process.platform === "win32" && (process.env.COMSPEC || Bun.which("cmd.exe"))
      ? {
          label: "cmd",
          shell: process.env.COMSPEC || Bun.which("cmd.exe")!,
          command: 'set /p "OPENCODE_TTY_INPUT="\r\necho received:%OPENCODE_TTY_INPUT%',
          reuse: "echo reused:%OPENCODE_TTY_INPUT%",
        }
      : undefined,
    Shell.gitbash()
      ? {
          label: "posix",
          shell: Shell.gitbash()!,
          command:
            "IFS= read -r OPENCODE_TTY_INPUT; export OPENCODE_TTY_INPUT; printf 'received:%s\\n' \"$OPENCODE_TTY_INPUT\"",
          reuse: "printf 'reused:%s\\n' \"$OPENCODE_TTY_INPUT\"",
        }
      : undefined,
    process.platform !== "win32" && !Shell.ps(Shell.acceptable())
      ? {
          label: "posix",
          shell: Shell.acceptable(),
          command:
            "IFS= read -r OPENCODE_TTY_INPUT; export OPENCODE_TTY_INPUT; printf 'received:%s\\n' \"$OPENCODE_TTY_INPUT\"",
          reuse: "printf 'reused:%s\\n' \"$OPENCODE_TTY_INPUT\"",
        }
      : undefined,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item))

  for (const item of terminalShells) {
    it.instance(
      `supports stdin and reuse in a non-PowerShell TTY lane [${item.label}]`,
      () =>
        Effect.gen(function* () {
          const sessions = yield* ExecSession.Service
          const started = yield* lane(item.command, {
            laneID: 0,
            shell: item.shell,
            tty: true,
            yieldTimeMs: 500,
          })
          expect(started.running).toBe(true)
          const written = yield* sessions.write({
            execID: started.execID!,
            chars: item.label === "cmd" ? "hello\r\n" : "hello\n",
            yieldTimeMs: 1_000,
            invocation: invocation("stdin"),
          })
          const completed = written.running ? yield* finish(written.execID!, invocation("poll"), "10 seconds") : written
          expect(written.output + completed.output).toContain("received:hello")
          const reuseStarted = yield* lane(item.reuse, {
            laneID: 0,
            shell: item.shell,
          })
          const reused = reuseStarted.running
            ? yield* finish(reuseStarted.execID!, invocation("poll"), "10 seconds")
            : reuseStarted
          expect(reused.output).toContain("reused:hello")
          expect(reused.metadata.shellReused).toBe(true)
        }),
      15_000,
    )
  }

  it.instance("rejects a TTY mode change without discarding the lane", () =>
    Effect.gen(function* () {
      if (!Shell.ps(Shell.acceptable())) return
      const first = yield* lane("Write-Output pipe", { laneID: 0 })
      const changed = yield* lane("Write-Output tty", { laneID: 0, tty: true })
      expect(changed.error).toContain("tty mode changed")
      const reused = yield* lane("Write-Output reused", { laneID: 0 })
      expect(reused.output).toContain("reused")
      expect(reused.metadata.shellGeneration).toBe(first.metadata.shellGeneration)
      expect(reused.metadata.shellReused).toBe(true)
      const reset = yield* lane("Write-Output tty", { laneID: 0, tty: true, resetLane: true })
      expect(reset.output).toContain("tty")
      expect(reset.metadata.shellGeneration).toBeGreaterThan(first.metadata.shellGeneration ?? 0)
    }),
  )

  it.instance("sanitizes controls and truncates visible lane output", () =>
    Effect.gen(function* () {
      if (!Shell.ps(Shell.acceptable())) return
      const command =
        "$text = 'prefix' + [char]27 + '[31m' + ('a' * 40000) + [char]27 + '[0m' + 'suffix'; [Console]::Out.Write($text)"
      const result = yield* lane(command, { laneID: 0 })
      expect(result.metadata.output.length).toBe(30_000)
      expect(result.metadata.output.endsWith("suffix")).toBe(true)
      expect(result.metadata.output).not.toContain("\u001b")
      expect(result.metadata.truncated).toBe(true)
    }),
  )

  it.instance("bounds model output while retaining its head and tail", () =>
    Effect.gen(function* () {
      if (!Shell.ps(Shell.acceptable())) return
      const result = yield* lane("[Console]::Out.Write('HEAD' + ('x' * 300000) + 'TAIL')", {
        laneID: 0,
        maxOutputTokens: 100,
      })
      expect(result.truncated).toBe(true)
      expect(result.output.startsWith("HEAD")).toBe(true)
      expect(result.output).toContain("bytes omitted")
      expect(result.output.endsWith("TAIL")).toBe(true)
    }),
  )

  it.instance(
    "keeps TTY framing live when output exceeds the PTY replay buffer",
    () =>
      Effect.gen(function* () {
        const executable = process.execPath
        const script = 'process.stdout.write("HEAD" + "x".repeat(2100000) + "TAIL")'
        const started = yield* lane(
          shellCommand({
            ps: "[Console]::Out.Write('HEAD' + ('x' * 2100000) + 'TAIL')",
            cmd: `"${executable.replaceAll('"', '""')}" -e "${script}"`,
            posix: "printf HEAD; head -c 2100000 /dev/zero | tr '\\0' x; printf TAIL",
          }),
          { laneID: 0, tty: true, yieldTimeMs: 30_000, maxOutputTokens: 100 },
        )
        const completed = started.running ? yield* finish(started.execID!, invocation("poll"), "45 seconds") : started
        const output = started.running ? started.output + completed.output : completed.output
        expect(completed.running).toBe(false)
        expect(completed.metadata.outputError).toBeUndefined()
        expect(output).toContain("HEAD")
        expect(output).toContain("bytes omitted")
        expect(output).toContain("TAIL")

        const reused = yield* lane(
          shellCommand({ ps: "Write-Output reused", cmd: "echo reused", posix: "printf reused" }),
          { laneID: 0 },
        )
        expect(reused.output).toContain("reused")
        expect(reused.metadata.shellReused).toBe(true)
      }),
    90_000,
  )

  it.instance("consumes completed output instead of replaying it on later polls", () =>
    Effect.gen(function* () {
      const sessions = yield* ExecSession.Service
      const started = yield* lane(
        shellCommand({
          ps: "Start-Sleep -Milliseconds 200; Write-Output final-once",
          cmd: "ping -n 2 127.0.0.1 >nul && echo final-once",
          posix: "sleep 0.2; printf final-once",
        }),
        { laneID: 0, yieldTimeMs: 0 },
      )
      expect(started.running).toBe(true)

      const completed = yield* sessions.write({
        execID: started.execID!,
        yieldTimeMs: 2_000,
        invocation: invocation("poll"),
      })
      expect(completed.running).toBe(false)
      expect(completed.output).toContain("final-once")

      const repeated = yield* sessions.write({
        execID: started.execID!,
        yieldTimeMs: 0,
        invocation: invocation("poll"),
      })
      expect(repeated.running).toBe(false)
      expect(repeated.output).toBe("")
    }),
  )

  it.instance("rejects cross-session follow-up calls", () =>
    Effect.gen(function* () {
      const sessions = yield* ExecSession.Service
      const started = yield* lane(
        shellCommand({ ps: "Start-Sleep 30", cmd: "ping -n 31 127.0.0.1 >nul", posix: "sleep 30" }),
        {
          laneID: 0,
          yieldTimeMs: 0,
        },
      )
      const rejected = yield* sessions.write({
        execID: started.execID!,
        invocation: { ...invocation("poll"), sessionID: SessionID.make("ses_other") },
      })
      expect(rejected.error).toContain("does not belong")
      yield* sessions.terminate({ execID: started.execID!, invocation: invocation("terminate") })
    }),
  )

  it.instance("terminates a running lane and records termination", () =>
    Effect.gen(function* () {
      const sessions = yield* ExecSession.Service
      const started = yield* lane(
        shellCommand({ ps: "Start-Sleep 30", cmd: "ping -n 31 127.0.0.1 >nul", posix: "sleep 30" }),
        {
          laneID: 0,
          yieldTimeMs: 0,
        },
      )
      const result = yield* sessions.terminate({
        execID: started.execID!,
        yieldTimeMs: 500,
        invocation: invocation("terminate"),
      })
      expect(result.running).toBe(false)
      expect(result.metadata.terminationRequested).toBe(true)
      expect(result.metadata.durationMs).toBeGreaterThan(0)
      expect(result.metadata.outputError).toBeUndefined()
    }),
  )

  it.instance("stops all running lanes in a session", () =>
    Effect.gen(function* () {
      const sessions = yield* ExecSession.Service
      const command = shellCommand({ ps: "Start-Sleep 30", cmd: "ping -n 31 127.0.0.1 >nul", posix: "sleep 30" })
      const first = yield* lane(command, { laneID: 0, yieldTimeMs: 0 })
      const second = yield* lane(command, { laneID: 1, yieldTimeMs: 0 })
      const stopped = yield* sessions.stop([{ sessionID: invocation("root").sessionID }])
      expect(stopped).toEqual({ matched: 2, terminated: 2, failed: 0 })
      const firstResult = yield* sessions.write({ execID: first.execID!, invocation: invocation("poll") })
      const secondResult = yield* sessions.write({ execID: second.execID!, invocation: invocation("poll") })
      expect(firstResult.running).toBe(false)
      expect(secondResult.running).toBe(false)
      expect(firstResult.metadata.outputError).toBeUndefined()
      expect(secondResult.metadata.outputError).toBeUndefined()
    }),
  )

  it.instance("prevents a staged generation from committing after its session is stopped", () =>
    Effect.gen(function* () {
      const sessions = yield* ExecSession.Service
      const blocked = yield* blockedReservation()
      const source = { ...invocation("root"), sessionID: SessionID.make("ses_stop_staged") }
      const command = shellCommand({ ps: "Write-Output ready", cmd: "echo ready", posix: "printf ready" })
      const stale = yield* lane(command, {
        laneID: 0,
        source,
        onLaneReserved: blocked.hook,
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(blocked.reserved)
      const queued = yield* lane(command, { laneID: 0, source }).pipe(Effect.forkScoped)
      expect((yield* Fiber.join(queued).pipe(Effect.timeout("100 millis"), Effect.option))._tag).toBe("None")

      expect(yield* sessions.stop([{ sessionID: source.sessionID }])).toEqual({
        matched: 0,
        terminated: 0,
        failed: 0,
      })
      const staleResult = yield* Fiber.join(stale).pipe(Effect.timeout("1 second"))
      expect(staleResult.error).toContain("preparation was invalidated")
      const queuedResult = yield* Fiber.join(queued).pipe(Effect.timeout("1 second"))
      expect(queuedResult.error).toContain("queued command was invalidated")
      const replacement = yield* lane(command, { laneID: 0, resetLane: true, source })
      expect(replacement.error).toBeUndefined()
      const reused = yield* lane(command, { laneID: 0, source })
      expect(reused.error).toBeUndefined()
      expect(reused.metadata.shellReused).toBe(true)
      expect(reused.metadata.shellGeneration).toBe(replacement.metadata.shellGeneration)
    }),
  )

  it.instance("rejects a launch whose session read crossed a completed stop", () =>
    Effect.gen(function* () {
      const sessions = yield* ExecSession.Service
      const source = { ...invocation("root"), sessionID: SessionID.make("ses_stop_during_session_read") }
      const requested = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      sessionReads.set(
        source.sessionID,
        Deferred.succeed(requested, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(sessionInfo(source.sessionID)),
        ),
      )
      const command = shellCommand({
        ps: "Write-Output should-not-run",
        cmd: "echo should-not-run",
        posix: "printf should-not-run",
      })
      const stale = yield* lane(command, { laneID: 0, source }).pipe(Effect.forkScoped)
      yield* Deferred.await(requested)
      expect(yield* sessions.stop([{ sessionID: source.sessionID }])).toEqual({ matched: 0, terminated: 0, failed: 0 })
      sessionReads.delete(source.sessionID)
      yield* Deferred.succeed(release, undefined)

      const result = yield* Fiber.join(stale)
      expect(result.error).toContain("session changed while queuing")
      expect(result.output).not.toContain("should-not-run")
    }),
  )

  it.instance("stops every lane when selected messages rewrite a session", () =>
    Effect.gen(function* () {
      const sessions = yield* ExecSession.Service
      const selected = { ...invocation("root"), messageID: MessageID.make("msg_stop_selected") }
      const retained = { ...invocation("root"), messageID: MessageID.make("msg_stop_retained") }
      const waiting = shellCommand({ ps: "Start-Sleep 30", cmd: "ping -n 31 127.0.0.1 >nul", posix: "sleep 30" })
      const removed = yield* lane(waiting, { laneID: 0, source: selected, yieldTimeMs: 0 })
      const running = yield* lane(waiting, { laneID: 1, source: retained, yieldTimeMs: 0 })
      yield* lane(
        shellCommand({
          ps: "$env:OPENCODE_STOP_RETAINED = 'kept'",
          cmd: "set OPENCODE_STOP_RETAINED=kept",
          posix: "export OPENCODE_STOP_RETAINED=kept",
        }),
        { laneID: 2, source: retained },
      )

      const stopped = yield* sessions.stop([
        { sessionID: selected.sessionID, messageIDs: new Set([selected.messageID]) },
      ])
      expect(stopped).toEqual({ matched: 2, terminated: 2, failed: 0 })
      const removedResult = yield* sessions.write({
        execID: removed.execID!,
        invocation: { ...selected, display: "poll" },
      })
      expect(removedResult.running).toBe(false)
      const runningResult = yield* sessions.write({
        execID: running.execID!,
        yieldTimeMs: 0,
        invocation: { ...retained, display: "poll" },
      })
      expect(runningResult.running).toBe(false)
      const rebuilt = yield* lane(
        shellCommand({
          ps: "Write-Output rebuilt",
          cmd: "echo rebuilt",
          posix: "printf rebuilt",
        }),
        { laneID: 2, source: retained },
      )
      expect(rebuilt.output).toContain("rebuilt")
      expect(rebuilt.warning).toContain("session history stopped or changed")
      expect(rebuilt.metadata.shellReused).toBe(false)
    }),
  )
})
