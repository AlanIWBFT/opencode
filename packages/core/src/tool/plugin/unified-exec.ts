export * as UnifiedExecTool from "./unified-exec.js"

import { SystemPart, ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { Tool } from "@opencode/schema/tool"
import { SessionExec } from "@opencode/schema/session-exec"
import { AbsolutePath, NonNegativeInt } from "@opencode/schema/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import path from "node:path"
import { Config } from "../../config.js"
import { Environment } from "../../environment/index.js"
import { FileAccess } from "../../file-access.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { PluginHooks } from "../../plugin/hooks.js"
import { SessionEnvironment } from "../../session/environment.js"
import { ShellParse } from "../../shell/parse.js"
import { ShellSelect } from "../../shell/select.js"
import { ExecSession } from "../exec-session.js"
import { description, shellDescription } from "../exec-session/prompt.js"
import { persistentShellExecutable, persistentShellPosix, persistentShellScript } from "../exec-session/shell.js"

export const ExecInput = Schema.Struct({
  cmd: Schema.String.annotate({ description: "The shell command to execute" }),
  lane_id: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 }))
    .pipe(Schema.optional)
    .annotate({
      description:
        "Persistent execution slot. Defaults to 0. Commands in one slot are serial; different slots may run in parallel.",
    }),
  reset_lane: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Discard an idle slot and its shell state, then start a clean shell generation. Required when changing an existing slot's tty mode. Lost slots are rebuilt automatically.",
  }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Working directory. A reused slot defaults to its current directory, and an explicit value persists in that slot.",
  }),
  yield_time_ms: NonNegativeInt.pipe(Schema.optional).annotate({
    description: "How long to wait before returning partial output. Defaults to 5000ms.",
  }),
  max_output_tokens: NonNegativeInt.pipe(Schema.optional).annotate({
    description: "Maximum output tokens to return for this chunk.",
  }),
  tty: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Use a terminal for REPLs, Read-Host, or full-screen programs. Changing an existing slot's mode requires reset_lane=true in the same call. Omit to reuse its mode; defaults to false when creating or resetting.",
  }),
})

export const PollInput = Schema.Struct({
  exec_id: NonNegativeInt.annotate({ description: "The execution ID returned by exec_command" }),
  yield_time_ms: NonNegativeInt.pipe(Schema.optional).annotate({
    description: "How long to wait before returning more output. Defaults to 5000ms.",
  }),
  max_output_tokens: ExecInput.fields.max_output_tokens,
})

export const WriteInput = Schema.Struct({
  ...PollInput.fields,
  chars: Schema.String.pipe(Schema.optional).annotate({ description: "Non-empty characters to send to stdin." }),
  close_stdin: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Close pipe-backed stdin after writing chars, sending EOF and ending the slot generation. Not supported with tty enabled.",
  }),
})

export const TerminateInput = Schema.Struct({
  ...PollInput.fields,
  yield_time_ms: NonNegativeInt.pipe(Schema.optional).annotate({
    description: "How long to wait for final output after termination. Defaults to 500ms.",
  }),
})

export const Plugin = {
  id: "opencode.tool.unified-exec",
  effect: Effect.fn("UnifiedExecTool.Plugin")(function* (ctx: Context) {
    const executions = yield* ExecSession.Service
    const shellSelect = yield* ShellSelect.Service
    const location = yield* Location.Service
    const environment = yield* Environment.Service
    const environments = yield* SessionEnvironment.Service
    const permission = yield* Permission.Service
    const access = yield* FileAccess.Service
    const config = yield* Config.Service
    const hooks = yield* PluginHooks.Service
    const resolveShell = shellSelect
      .resolve({ priority: "compat" })
      .pipe(Effect.map((shell) => persistentShellExecutable(shell)))

    const resolveWorkdir = Effect.fn("UnifiedExecTool.resolveWorkdir")(function* (value: string, shell: string) {
      if (process.platform === "win32") {
        if (persistentShellPosix(shell) && value.startsWith("/") && FSUtil.windowsPath(value) === value) {
          const lines = yield* environment.spawner
            .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", value]))
            .pipe(Effect.catch(() => Effect.succeed([] as string[])))
          if (lines[0]?.trim()) return AbsolutePath.make(FSUtil.normalizePath(lines[0].trim()))
        }
        return AbsolutePath.make(FSUtil.normalizePath(path.resolve(location.directory, FSUtil.windowsPath(value))))
      }
      return AbsolutePath.make(path.resolve(location.directory, value))
    })

    const authorize = Effect.fn("UnifiedExecTool.authorize")(function* (
      command: string,
      cwd: string,
      shell: string,
      context: Tool.Context,
    ) {
      const target = yield* access.resolve({ path: cwd, kind: "directory" })
      const portable =
        Config.latest(yield* config.entries(), "experimental")?.portable_shell_scanner ??
        (ctx.app.channel === "local" || ctx.app.channel === "dev")
      const parsed = yield* ShellParse.scan(command, shell, target.absolute, { portable })
      const directories = yield* Effect.forEach(parsed.directories, (directory) =>
        access.resolve({ path: FileAccess.resolvePath(target.absolute, directory), kind: "directory" }),
      )
      yield* access.authorizeExternal([target, ...directories], context)
      if (parsed.commands.length > 0)
        yield* permission.assert({
          action: "shell",
          resources: parsed.commands.map((command) => command.resource),
          save: parsed.commands.map((command) => command.save),
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
        })
      const type = yield* Environment.typeFollowing(environment.files, target.absolute)
      if (type !== "directory")
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.absolute}`))
    })

    yield* ctx.tool
      .transform((editor) => {
        editor.remove("shell")
        editor.add({
          name: "exec_command",
          options: { permission: "shell", codemode: false },
          description: description(),
          input: ExecInput,
          output: Schema.String,
          execute: (input, context) =>
            Effect.gen(function* () {
              const shell = yield* resolveShell
              const cwd = input.workdir ? yield* resolveWorkdir(input.workdir, shell) : location.directory
              const invocationContext = invocation(context, "root")
              const sessionEnvironment =
                location.workspaceID === undefined ? yield* environments.get(context.sessionID) : undefined
              const env = Object.fromEntries(
                Object.entries(sessionEnvironment ?? process.env).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              )
              const chunk = yield* executions.launch({
                command: input.cmd,
                shell,
                cwd: location.directory,
                laneCwd: input.workdir ? cwd : undefined,
                env,
                laneID: input.lane_id ?? 0,
                resetLane: input.reset_lane,
                tty: input.tty,
                yieldTimeMs: input.yield_time_ms,
                maxOutputTokens: input.max_output_tokens,
                invocation: invocationContext,
                onExecutionStarted: context.registerCleanup
                  ? (execID) =>
                      Effect.sync(() =>
                        context.registerCleanup!(
                          executions
                            .terminate({
                              execID,
                              yieldTimeMs: 0,
                              invocation: { ...invocationContext, display: "terminate", metadata: () => Effect.void },
                            })
                            .pipe(Effect.asVoid),
                        ),
                      )
                  : undefined,
                prepare: (effectiveCwd) =>
                  Effect.gen(function* () {
                    yield* authorize(input.cmd, effectiveCwd, shell, context).pipe(
                      Effect.mapError(
                        (error) => new ToolFailure({ message: `Unable to execute command: ${input.cmd}`, error }),
                      ),
                    )
                    const extra = yield* hooks.trigger("shell", "exec.env", {
                      cwd: effectiveCwd,
                      sessionID: context.sessionID,
                      callID: context.id,
                      env: {},
                    })
                    return {
                      script: persistentShellScript(shell, {
                        command: input.cmd,
                        cwd: input.workdir ? effectiveCwd : undefined,
                      }),
                      env: extra.env,
                    }
                  }),
              })
              return result(chunk)
            }).pipe(
              Effect.mapError(
                (error) => new ToolFailure({ message: `Unable to execute command: ${input.cmd}`, error }),
              ),
            ),
        })
        editor.add({
          name: "poll_exec",
          options: { permission: "shell", codemode: false },
          input: PollInput,
          output: Schema.String,
          description: "Poll a running exec_command execution for more output without writing to stdin.",
          execute: (input, context) =>
            executions
              .write({
                execID: input.exec_id,
                yieldTimeMs: input.yield_time_ms,
                maxOutputTokens: input.max_output_tokens,
                invocation: invocation(context, "poll"),
              })
              .pipe(Effect.map(result)),
        })
        editor.add({
          name: "write_stdin",
          options: { permission: "shell", codemode: false },
          input: WriteInput,
          output: Schema.String,
          description:
            "Send characters to the command currently running in a persistent slot. chars or close_stdin is required; use poll_exec to poll. Only send input that command is ready to consume; leftover input can invalidate the slot protocol. close_stdin sends EOF and ends a pipe-backed slot generation; reset it before another command. TTY slots do not support close_stdin.",
          execute: (input, context) => {
            if (!input.chars && !input.close_stdin) {
              const error = "write_stdin requires chars or close_stdin; use poll_exec to poll output."
              return Effect.succeed({
                output: error,
                content: error,
                metadata: {
                  command: `execution ${input.exec_id}`,
                  output: error,
                  interactions: [],
                  execID: input.exec_id,
                  processRunning: false,
                  truncated: false,
                  execDisplay: "stdin",
                  execError: error,
                },
              })
            }
            return executions
              .write({
                execID: input.exec_id,
                chars: input.chars,
                closeStdin: input.close_stdin,
                yieldTimeMs: input.yield_time_ms,
                maxOutputTokens: input.max_output_tokens,
                invocation: invocation(context, "stdin"),
              })
              .pipe(Effect.map(result))
          },
        })
        editor.add({
          name: "terminate_exec",
          options: { permission: "shell", codemode: false },
          input: TerminateInput,
          output: Schema.String,
          description:
            "Terminate a running exec_command execution, end its slot generation, and return any final output.",
          execute: (input, context) =>
            executions
              .terminate({
                execID: input.exec_id,
                yieldTimeMs: input.yield_time_ms,
                maxOutputTokens: input.max_output_tokens,
                invocation: invocation(context, "terminate"),
              })
              .pipe(Effect.map(result)),
        })
      })
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools.exec_command
        if (tool) tool.description = description(yield* resolveShell)
        // Code Mode keeps native tool definitions in its captured catalog, outside event.tools.
        if (!tool && event.tools.execute)
          event.system.push(SystemPart.make(shellDescription(yield* resolveShell, process.platform)))
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}

function invocation(context: Tool.Context, display: ExecSession.Display): ExecSession.Invocation {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    callID: context.id,
    childID: context.childID,
    display,
    metadata: (input) =>
      input.metadata ? context.progress(Schema.encodeSync(SessionExec.Metadata)(input.metadata)) : Effect.void,
  }
}

function result(chunk: ExecSession.Chunk) {
  const status = chunk.error
    ? `Error: ${chunk.error}`
    : chunk.running
      ? `Process running with execution ID ${chunk.execID}`
      : `Process exited with code ${chunk.exitCode ?? "unknown"}`
  const output = [
    `Chunk ID: ${chunk.chunkID}`,
    `Wall time: ${(chunk.wallTimeMs / 1_000).toFixed(4)} seconds`,
    status,
    chunk.truncated ? "Output was truncated." : undefined,
    chunk.metadata.outputError ? `Output stream error: ${chunk.metadata.outputError}` : undefined,
    chunk.warning ? `Warning: ${chunk.warning}` : undefined,
    "Output:",
    chunk.output || "(no output)",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
  return { output, content: output, metadata: Schema.encodeSync(SessionExec.Metadata)(chunk.metadata) }
}
