import { expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/schema/session-message"
import { ExecSession } from "@opencode/core/tool/exec-session"
import { persistentShellExecutable, persistentShellScript } from "@opencode/core/tool/exec-session/shell"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ExecSession.node, Session.node, Location.node]), [
    Location.node.replace(tempLocationLayer),
    SessionExecution.node.replace(SessionExecution.noopLayer),
  ]),
)
const shell = process.platform === "win32" ? Bun.which("pwsh") : null
const windowsTest = shell ? it.live : it.live.skip

for (const tty of [false, true]) {
  const linuxTest = process.platform === "linux" ? it.live : it.live.skip
  linuxTest(
    `Linux ${tty ? "PTY" : "pipe"} lanes isolate startup and retain explicit Bash state`,
    () =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const sessions = yield* Session.Service
        const executions = yield* ExecSession.Service
        const session = yield* sessions.create({ location: { directory: location.directory } })
        const bash = persistentShellExecutable("/bin/fish")
        const startup = `${location.directory}/startup.sh`
        yield* Effect.promise(() => Bun.write(startup, "printf 'polluted-startup\\n'\n"))
        const env = {
          ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          ),
          BASH_ENV: startup,
          ENV: startup,
          HISTFILE: `${location.directory}/history`,
          BASH_COMPAT: "3.1",
          SHELLOPTS: "posix:noclobber:errexit:nounset",
          BASHOPTS: "extdebug:failglob",
          "BASH_FUNC_inheritedfn%%": "() { printf polluted-function; }",
        }
        const invocation: ExecSession.Invocation = {
          sessionID: session.id,
          messageID: SessionMessage.ID.create(),
          display: "root",
          metadata: () => Effect.void,
        }
        const launch = (command: string) =>
          executions.launch({
            command,
            shell: bash,
            cwd: location.directory,
            env,
            invocation,
            tty,
            yieldTimeMs: 5000,
            prepare: () => Effect.succeed({ script: persistentShellScript(bash, { command }) }),
          })
        const first = yield* launch(`[[ $- != *i* ]] || exit 1
[[ ! -o posix && ! -o noclobber ]] || exit 2
[[ -z $BASH_ENV && -z $ENV && -z $HISTFILE && -z $BASH_COMPAT ]] || exit 3
if declare -F inheritedfn >/dev/null; then exit 4; fi
retained='bash state'; values=(one two)
[[ \${values[1]} == two ]] || exit 5
set -o noclobber
printf 'lane-ready\\n'`)
        expect(first.error).toBeUndefined()
        expect(first.exitCode).toBe(0)
        expect(first.output).toContain("lane-ready")
        expect(first.output).not.toContain("polluted-startup")
        const second = yield* launch(`printf '%s\\n' "$retained"`)
        expect(second.error).toBeUndefined()
        expect(second.exitCode).toBe(0)
        expect(second.output).toContain("bash state")
        expect(second.metadata.shellReused).toBe(true)
        yield* sessions.stop(session.id)
      }),
    { timeout: 20_000 },
  )
}

windowsTest(
  "PTY slots retain shell state and forward expected interactive input",
  () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const sessions = yield* Session.Service
      const executions = yield* ExecSession.Service
      const session = yield* sessions.create({ location: { directory: location.directory } })
      const invocation: ExecSession.Invocation = {
        sessionID: session.id,
        messageID: SessionMessage.ID.create(),
        display: "root",
        metadata: () => Effect.void,
      }
      const launch = (command: string, yieldTimeMs = 5000) =>
        executions.launch({
          command,
          shell: shell!,
          cwd: location.directory,
          env: Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          ),
          invocation,
          tty: true,
          yieldTimeMs,
          prepare: () => Effect.succeed({ script: persistentShellScript(shell!, { command }) }),
        })
      const first = yield* launch(`$retained = 'pty state'
Write-Output 'ready'
$options = Get-PSReadLineOption
Write-Output ('history-style:' + $options.HistorySaveStyle)
Write-Output ('history-directory:' + [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($options.HistorySavePath)))
$history = if (Test-Path -LiteralPath $options.HistorySavePath) { [IO.File]::ReadAllText($options.HistorySavePath) } else { '' }
Write-Output ('history-internal:' + $history.Contains('__opencode_run_'))`)
      expect(first.error).toBeUndefined()
      expect(first.running).toBe(false)
      expect(first.output).toContain("ready")
      expect(first.output).toContain("history-style:SaveNothing")
      expect(first.output).toContain("history-directory:opencode-lane-")
      expect(first.output).toContain("history-internal:False")
      const read = yield* launch("Write-Output $retained; Write-Output ('reply:' + (Read-Host 'input'))", 200)
      expect(read.running).toBe(true)
      expect(read.metadata.shellReused).toBe(true)
      const written = yield* executions.write({
        execID: read.execID!,
        chars: "typed\r",
        yieldTimeMs: 5000,
        invocation: { ...invocation, display: "stdin" },
      })
      expect(written.error).toBeUndefined()
      expect(written.running).toBe(false)
      expect(read.output + written.output).toContain("pty state")
      expect(written.output).toContain("reply:typed")
      yield* sessions.stop(session.id)
    }),
  { timeout: 20_000 },
)

windowsTest(
  "explicit stop closes only the target session's commands and permits a fresh generation",
  () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const sessions = yield* Session.Service
      const executions = yield* ExecSession.Service
      const parent = yield* sessions.create({ location: { directory: location.directory } })
      const child = yield* sessions.create({ parentID: parent.id })
      const invocation = (sessionID: Session.Info["id"]): ExecSession.Invocation => ({
        sessionID,
        messageID: SessionMessage.ID.create(),
        display: "root",
        metadata: () => Effect.void,
      })
      const launch = (context: ExecSession.Invocation, command: string, yieldTimeMs: number) =>
        executions.launch({
          command,
          shell: shell!,
          cwd: location.directory,
          env: Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          ),
          invocation: context,
          yieldTimeMs,
          prepare: () => Effect.succeed({ script: persistentShellScript(shell!, { command }) }),
        })
      const parentInvocation = invocation(parent.id)
      const childInvocation = invocation(child.id)
      const parentCommand = yield* launch(parentInvocation, "$retained = 'old'; Start-Sleep 30", 100)
      const childCommand = yield* launch(childInvocation, "Start-Sleep 30", 100)
      expect(parentCommand.running).toBe(true)
      expect(childCommand.running).toBe(true)
      expect(yield* sessions.stop(parent.id)).toEqual({ matched: 1, terminated: 1, failed: 0 })
      expect(
        (yield* executions.write({ execID: parentCommand.execID!, invocation: parentInvocation, yieldTimeMs: 0 }))
          .running,
      ).toBe(false)
      expect(
        (yield* executions.write({ execID: childCommand.execID!, invocation: childInvocation, yieldTimeMs: 0 }))
          .running,
      ).toBe(true)
      const resumed = yield* launch(parentInvocation, "Write-Output ('fresh:' + $retained)", 5000)
      expect(resumed.error).toBeUndefined()
      expect(resumed.output).toContain("fresh:")
      expect(resumed.output).not.toContain("old")
      expect(resumed.metadata.shellGeneration).toBe(parentCommand.metadata.shellGeneration! + 1)
      expect(yield* sessions.stop(child.id)).toEqual({ matched: 1, terminated: 1, failed: 0 })
      const missing = yield* sessions.stop(Session.ID.create()).pipe(Effect.flip)
      expect(missing._tag).toBe("Session.NotFoundError")
    }),
  { timeout: 20_000 },
)

windowsTest(
  "persistent slots reuse state, archive stops a running command, and restore creates a fresh generation",
  () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const sessions = yield* Session.Service
      const executions = yield* ExecSession.Service
      const session = yield* sessions.create({ location: { directory: location.directory } })
      const invocation: ExecSession.Invocation = {
        sessionID: session.id,
        messageID: SessionMessage.ID.create(),
        display: "root",
        metadata: () => Effect.void,
      }
      const launch = (command: string, yieldTimeMs = 5000) =>
        executions.launch({
          command,
          shell: shell!,
          cwd: location.directory,
          env: Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          ),
          invocation,
          yieldTimeMs,
          prepare: () => Effect.succeed({ script: persistentShellScript(shell!, { command }) }),
        })
      const first = yield* launch("$retained = 'persistent value'")
      expect(first.error).toBeUndefined()
      expect(first.running).toBe(false)
      expect(first.exitCode).toBe(0)
      const second = yield* launch("[Console]::WriteLine($retained)")
      expect(second.output).toContain("persistent value")
      expect(second.metadata.shellReused).toBe(true)
      expect(second.metadata.shellGeneration).toBe(first.metadata.shellGeneration)
      const active = yield* launch("[Console]::WriteLine('started'); Start-Sleep -Seconds 30", 100)
      expect(active.running).toBe(true)
      expect(active.execID).toBeDefined()
      yield* sessions.setArchived({ sessionID: session.id, archivedAt: Date.now() })
      const stopped = yield* executions.write({
        execID: active.execID!,
        invocation: { ...invocation, display: "poll" },
        yieldTimeMs: 0,
      })
      expect(stopped.running).toBe(false)
      const rejected = yield* launch("[Console]::WriteLine('must not run')")
      expect(rejected.error).toContain("archived")
      yield* sessions.setArchived({ sessionID: session.id, archivedAt: null })
      const restored = yield* launch("[Console]::WriteLine('fresh:' + $retained)")
      expect(restored.error).toBeUndefined()
      expect(restored.output).toContain("fresh:")
      expect(restored.output).not.toContain("persistent value")
      expect(restored.metadata.shellGeneration).toBe(first.metadata.shellGeneration! + 1)
      const deleting = yield* launch("Start-Sleep -Seconds 30", 100)
      expect(deleting.running).toBe(true)
      yield* sessions.remove(session.id)
      const forgotten = yield* executions.write({
        execID: deleting.execID!,
        invocation: { ...invocation, display: "poll" },
        yieldTimeMs: 0,
      })
      expect(forgotten.error).toContain("execution not found")
      expect((yield* launch("Write-Output 'must not restart'")).error).toContain("no longer exists")
    }),
  { timeout: 20_000 },
)
