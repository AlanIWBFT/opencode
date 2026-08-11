import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Plugin } from "@/plugin"
import * as Tool from "./tool"
import { ExecSession } from "./exec-session"
import { askPermissions, persistentShellScript, persistentShellSupported } from "./shell"
import { recycleBinSafetyNotes } from "./shell/prompt"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath, NonNegativeInt } from "@opencode-ai/core/schema"
import { Shell } from "@opencode-ai/core/shell"
import { Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import path from "path"

export const ExecParameters = Schema.Struct({
  cmd: Schema.String.annotate({ description: "The shell command to execute" }),
  lane_id: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(7)),
  ).annotate({
    description:
      "Persistent execution slot. Defaults to 0 and must be an integer from 0 through 7. Commands in one slot are serial; different slots may run in parallel.",
  }),
  reset_lane: Schema.optional(Schema.Boolean).annotate({
    description:
      "Discard an idle slot and start a clean shell generation before running the command. Lost slots are rebuilt automatically.",
  }),
  workdir: Schema.optional(Schema.String).annotate({
    description:
      "The working directory to run the command in. A reused slot defaults to its current directory, and an explicit value persists in that slot.",
  }),
  yield_time_ms: Schema.optional(NonNegativeInt).annotate({
    description: "How long to wait before returning partial output. Defaults to 5000ms.",
  }),
  max_output_tokens: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum output tokens to return to the model for this chunk.",
  }),
  tty: Schema.optional(Schema.Boolean).annotate({
    description:
      "Create or reset this slot with a terminal for REPLs, Read-Host, or full-screen programs. Defaults to false.",
  }),
})

const WriteInput = Schema.Struct({
  exec_id: NonNegativeInt.annotate({ description: "The running execution ID returned by exec_command" }),
  chars: Schema.optional(Schema.String).annotate({
    description: "Non-empty characters to send to stdin.",
  }),
  close_stdin: Schema.optional(Schema.Boolean).annotate({
    description:
      "Close pipe-backed stdin after writing chars, sending EOF to the process. Not supported with tty enabled.",
  }),
  yield_time_ms: Schema.optional(NonNegativeInt).annotate({
    description: "How long to wait before returning partial output. Defaults to 5000ms.",
  }),
  max_output_tokens: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum output tokens to return to the model for this chunk.",
  }),
})

const PollInput = Schema.Struct({
  exec_id: NonNegativeInt.annotate({ description: "The execution ID returned by exec_command" }),
  yield_time_ms: Schema.optional(NonNegativeInt).annotate({
    description: "How long to wait before returning more output. Defaults to 5000ms.",
  }),
  max_output_tokens: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum output tokens to return to the model for this chunk.",
  }),
})

const TerminateInput = Schema.Struct({
  exec_id: NonNegativeInt.annotate({ description: "The running execution ID returned by exec_command" }),
  yield_time_ms: Schema.optional(NonNegativeInt).annotate({
    description: "How long to wait for final output after termination. Defaults to 500ms.",
  }),
  max_output_tokens: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum output tokens to return to the model for this chunk.",
  }),
})

export const ExecCommandTool = Tool.define(
  "exec_command",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const sessions = yield* ExecSession.Service
    const fs = yield* FSUtil.Service
    const spawner = yield* ChildProcessSpawner

    const resolveWorkdir = Effect.fn("ExecCommand.resolveWorkdir")(function* (
      value: string,
      root: string,
      shell: string,
    ) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && value.startsWith("/") && FSUtil.windowsPath(value) === value) {
          const lines = yield* spawner
            .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", value]))
            .pipe(Effect.catch(() => Effect.succeed([] as string[])))
          const file = lines[0]?.trim()
          if (file) return AbsolutePath.make(FSUtil.normalizePath(file))
        }
        return AbsolutePath.make(FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(value))))
      }
      return AbsolutePath.make(path.resolve(root, value))
    })

    return () =>
      Effect.gen(function* () {
        const shell = Shell.acceptable((yield* config.get()).shell)
        return {
          description: [
            "Execute a shell command and return early with partial output while the process may continue running.",
            execCommandShellDescription(shell, process.platform),
            "Every command runs in a persistent slot. Use lane_id=0 for ordinary sequential work and reuse the same slot for cwd, environment variables, functions, modules, and activated environments.",
            "Use different numeric slots for commands that must run concurrently (slots 0 through 7 per session). Never submit parallel commands to the same slot.",
            "Execution output is the control-sequence-free transcript observed from the shared slot while that execution is active, not process-attributed output. Output emitted while no execution is active (for example from background processes still running after a command finishes) is discarded.",
            'Each poll_exec call returns only newly arrived output; output not yet returned stays buffered and is delivered by later polls, so polling less frequently does not lose output. If bursts exceed the 256KB buffer while an execution is running, the middle is dropped once and marked as "... N bytes omitted ...".',
            "When an execution completes, its remaining buffered output (up to the 256KB buffer, head and tail) is returned and consumed by the chunk that reports running=false. Later poll_exec calls return the completion status without replaying that output. Keep polling until running=false to guarantee you receive the final output.",
            "Keep long-running work in the foreground when it needs reliable polling, input, termination, and transcript continuity. Work left running after the shell command completes is not managed, and its output may interleave with a later execution in the same slot.",
            "Use reset_lane=true when a command needs a clean shell. A busy slot must be terminated before it can be reset.",
            "If a slot's shell state was lost, the next command automatically creates a new generation and reports that inherited shell state was reset.",
            "If a slot reports that its environment changed, retry with reset_lane=true; reset deliberately discards the old shell generation.",
            "Use poll_exec with the returned exec_id to collect more output.",
            "Use write_stdin with the returned exec_id only when the current command is waiting for that exact input. Unconsumed input can be read by the slot protocol after the command exits.",
            "Use terminate_exec to stop a running execution and end its slot generation.",
            "Set tty=true when creating or resetting a slot for a REPL, Read-Host, or a full-screen terminal program.",
          ].join("\n"),
          parameters: ExecParameters,
          execute: (input: typeof ExecParameters.Type, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instance = yield* InstanceState.context
              const laneID = input.lane_id ?? 0
              const cwd = input.workdir
                ? yield* resolveWorkdir(input.workdir, instance.directory, shell)
                : instance.directory
              const invocationCtx = invocation(ctx, "root")
              const registerCleanup = ctx.registerCleanup
                ? (cleanup: Effect.Effect<unknown>) => ctx.registerCleanup?.(cleanup)
                : undefined
              const env = Object.fromEntries(
                Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
              )
              const chunk = yield* sessions.launch({
                command: input.cmd,
                shell,
                cwd: instance.directory,
                laneCwd: input.workdir ? cwd : undefined,
                env,
                laneID,
                resetLane: input.reset_lane,
                tty: input.tty,
                yieldTimeMs: input.yield_time_ms,
                maxOutputTokens: input.max_output_tokens,
                invocation: invocationCtx,
                onExecutionStarted: registerCleanup
                  ? (execID) =>
                      Effect.sync(() =>
                        registerCleanup(
                          sessions
                            .terminate({
                              execID,
                              yieldTimeMs: 0,
                              invocation: { ...invocationCtx, display: "terminate", metadata: () => Effect.void },
                            })
                            .pipe(Effect.asVoid),
                        ),
                      )
                  : undefined,
                prepare: (effectiveCwd) =>
                  Effect.gen(function* () {
                    yield* askPermissions(ctx, {
                      command: input.cmd,
                      cwd: effectiveCwd,
                      shell,
                      instance,
                      fs,
                      spawner,
                    })
                    const extra = yield* plugin.trigger(
                      "shell.env",
                      { cwd: effectiveCwd, sessionID: ctx.sessionID, callID: ctx.callID },
                      { env: {} as Record<string, string> },
                    )
                    return {
                      script: persistentShellScript(shell, {
                        command: input.cmd,
                        cwd: input.workdir ? effectiveCwd : undefined,
                      }),
                      env: extra.env,
                    }
                  }),
              })
              return result(input.cmd, chunk)
            }),
        }
      })
  }),
)

export function execCommandShellDescription(shell: string, platform: NodeJS.Platform) {
  const name = Shell.name(shell)
  const display =
    name === "pwsh"
      ? "PowerShell 7+ (`pwsh`)"
      : name === "powershell"
        ? "Windows PowerShell 5.1 (`powershell`)"
        : name === "cmd"
          ? "`cmd.exe`"
          : `\`${name}\``
  const launch = Shell.posix(shell)
    ? `\`${name} -l\` as a persistent stdin-driven POSIX shell`
    : name === "cmd"
      ? "`cmd.exe /d /q /v:off` as a persistent shell"
      : Shell.ps(shell)
        ? `\`${name} -NoLogo -NoProfile\` as a persistent shell`
        : `\`${name}\` as a persistent stdin-driven POSIX-compatible shell`
  const syntax =
    name === "pwsh"
      ? "PowerShell profiles are not loaded. PowerShell 7 supports `&&` and `||`."
      : name === "powershell"
        ? "PowerShell profiles are not loaded. Windows PowerShell 5.1 does not support `&&` or `||`; use PowerShell conditionals instead."
        : name === "cmd"
          ? "Commands execute from a temporary batch file. Use batch-file syntax, including `%NAME%` for environment variables and `%%A` for FOR variables."
          : Shell.posix(shell)
            ? `Use POSIX-compatible ${name} syntax.`
            : "This configured shell does not support the persistent execution protocol."
  const runtime = Shell.ps(shell)
    ? [
        "PowerShell console input and output are configured as UTF-8.",
        "A final failing native program's exit code is propagated to the tool result.",
        "exit ends only the current command; use terminate_exec to end the persistent slot generation.",
        recycleBinSafetyNotes(platform),
      ]
    : []
  return [
    `Commands run in ${display} on \`${platform}\`.`,
    ...(persistentShellSupported(shell)
      ? []
      : ["The configured shell is unsupported; choose PowerShell, cmd, bash, dash, ksh, sh, or zsh."]),
    `Pass only the command body; the tool starts ${launch}. Do not prefix it with another shell launcher unless a nested shell is intentional.`,
    syntax,
    ...runtime.filter(Boolean),
  ].join("\n")
}

export const WriteStdinTool = Tool.define(
  "write_stdin",
  Effect.gen(function* () {
    const sessions = yield* ExecSession.Service
    return {
      description:
        "Send characters to the command currently running in a persistent slot. chars or close_stdin is required; use poll_exec to poll. Only send input that command is ready to consume; leftover input can invalidate the slot protocol. close_stdin sends EOF to a pipe-backed command and ends that slot generation, so reset it before another command. TTY slots do not support close_stdin.",
      parameters: WriteInput,
      execute: (input: typeof WriteInput.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!input.chars && !input.close_stdin) {
            return {
              title: `stdin -> ${input.exec_id}`,
              output: "write_stdin requires chars or close_stdin; use poll_exec to poll output.",
              metadata: {
                command: `execution ${input.exec_id}`,
                output: "write_stdin requires chars or close_stdin; use poll_exec to poll output.",
                interactions: [],
                execID: input.exec_id,
                processRunning: false,
                truncated: false,
                execDisplay: "stdin",
                execError: "write_stdin requires chars or close_stdin; use poll_exec to poll output.",
              },
            } satisfies Tool.ExecuteResult<ExecSession.Metadata>
          }
          const chunk = yield* sessions.write({
            execID: input.exec_id,
            chars: input.chars,
            closeStdin: input.close_stdin,
            yieldTimeMs: input.yield_time_ms,
            maxOutputTokens: input.max_output_tokens,
            invocation: invocation(ctx, input.chars || input.close_stdin ? "stdin" : "poll"),
          })
          return result(`stdin -> ${input.exec_id}`, chunk)
        }),
    }
  }),
)

export const PollExecTool = Tool.define(
  "poll_exec",
  Effect.gen(function* () {
    const sessions = yield* ExecSession.Service
    return {
      description: "Poll a running exec_command execution for more output without writing to stdin.",
      parameters: PollInput,
      execute: (input: typeof PollInput.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const chunk = yield* sessions.write({
            execID: input.exec_id,
            yieldTimeMs: input.yield_time_ms,
            maxOutputTokens: input.max_output_tokens,
            invocation: invocation(ctx, "poll"),
          })
          return result(`poll ${input.exec_id}`, chunk)
        }),
    }
  }),
)

export const TerminateExecTool = Tool.define(
  "terminate_exec",
  Effect.gen(function* () {
    const sessions = yield* ExecSession.Service
    return {
      description: "Terminate a running exec_command execution, end its slot generation, and return any final output.",
      parameters: TerminateInput,
      execute: (input: typeof TerminateInput.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const chunk = yield* sessions.terminate({
            execID: input.exec_id,
            yieldTimeMs: input.yield_time_ms,
            maxOutputTokens: input.max_output_tokens,
            invocation: invocation(ctx, "terminate"),
          })
          return result(`terminate ${input.exec_id}`, chunk)
        }),
    }
  }),
)

function invocation(ctx: Tool.Context, display: ExecSession.Display): ExecSession.Invocation {
  return {
    sessionID: ctx.sessionID,
    messageID: ctx.messageID,
    callID: ctx.callID,
    display,
    metadata: (input) => ctx.metadata(input),
  }
}

function result(title: string, chunk: ExecSession.Chunk): Tool.ExecuteResult<ExecSession.Metadata> {
  return {
    title,
    output: formatChunk(chunk),
    metadata: chunk.metadata,
  }
}

function formatChunk(chunk: ExecSession.Chunk) {
  const status = chunk.error
    ? `Error: ${chunk.error}`
    : chunk.running
      ? `Process running with execution ID ${chunk.execID}`
      : `Process exited with code ${chunk.exitCode ?? "unknown"}`
  return [
    `Chunk ID: ${chunk.chunkID}`,
    `Wall time: ${(chunk.wallTimeMs / 1_000).toFixed(4)} seconds`,
    status,
    chunk.truncated ? "Output was truncated." : undefined,
    chunk.metadata.outputError ? `Output stream error: ${chunk.metadata.outputError}` : undefined,
    chunk.warning ? `Warning: ${chunk.warning}` : undefined,
    "Output:",
    chunk.output || "(no output)",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}
