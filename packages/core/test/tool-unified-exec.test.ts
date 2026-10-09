import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Session } from "@opencode/core/session"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { SessionExecution } from "@opencode/core/session/execution"
import { ShellSelect } from "@opencode/core/shell/select"
import { Tool } from "@opencode/core/tool"
import { ExecSession } from "@opencode/core/tool/exec-session"
import { UnifiedExecTool } from "@opencode/core/tool/plugin/unified-exec"
import { ChildCall } from "@opencode/schema/tool"
import { SessionExec } from "@opencode/schema/session-exec"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const plugin = makeLocationNode({
  name: "test/unified-exec-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(UnifiedExecTool.Plugin, { app: { name: "test", version: "test", channel: "dev" } })),
  deps: [
    Tool.node,
    ExecSession.node,
    ShellSelect.node,
    Location.node,
    Environment.node,
    SessionEnvironment.node,
    Permission.node,
    FileAccess.node,
    Config.node,
    PluginHooks.node,
  ],
})
const base = AppNodeBuilder.build(
  LayerNode.group([plugin, Tool.node, Session.node, Location.node, ExecSession.node, PluginHooks.node]),
  [
    Location.node.replace(tempLocationLayer),
    Config.node.replace(Config.testLayer()),
    SessionExecution.node.replace(SessionExecution.noopLayer),
  ],
)
const direct = testEffect(base)
const scripts = testEffect(base)
const windowsDirect = process.platform === "win32" && Bun.which("pwsh") ? direct.live : direct.live.skip
const windowsScript = process.platform === "win32" && Bun.which("pwsh") ? scripts.live : scripts.live.skip

windowsDirect(
  "four persistent tools replace shell and enforce shell permissions",
  () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const sessions = yield* Session.Service
      const location = yield* Location.Service
      const session = yield* sessions.create({
        location: { directory: location.directory },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      })
      expect((yield* tools.snapshot()).definitions.map((tool) => tool.name)).toEqual([
        "exec_command",
        "poll_exec",
        "terminate_exec",
        "write_stdin",
        "execute",
      ])
      const result = yield* executeTool(tools, {
        ...toolIdentity,
        sessionID: session.id,
        call: {
          type: "tool-call",
          id: "first",
          name: "exec_command",
          input: { cmd: "[Console]::WriteLine('tool integration')" },
        },
      })
      expect(result.status).toBe("completed")
      expect(result.output).toContain("tool integration")
      yield* sessions.setPermissions({
        sessionID: session.id,
        permissions: [{ action: "shell", resource: "*", effect: "deny" }],
      })
      const denied = yield* executeTool(tools, {
        ...toolIdentity,
        sessionID: session.id,
        call: {
          type: "tool-call",
          id: "denied",
          name: "exec_command",
          input: { cmd: "Write-Output 'must not execute'" },
        },
      })
      expect(denied.status).toBe("error")
    }),
  { timeout: 20_000 },
)

windowsScript(
  "failed Script cleans its returned command but leaves a previous Script's command running",
  () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const sessions = yield* Session.Service
      const executions = yield* ExecSession.Service
      yield* tools.transform((editor) => {
        for (const name of ["exec_command", "poll_exec", "write_stdin", "terminate_exec"]) {
          editor.update(name, (tool) => {
            tool.options = {
              ...tool.options,
              codemode: {
                namespace: "$opencode",
                ...(name === "exec_command" ? {} : { concurrency: { group: "exec-session", limit: 1, inputKey: "exec_id" } }),
              },
            }
          })
        }
      })
      const location = yield* Location.Service
      const session = yield* sessions.create({
        location: { directory: location.directory },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      })
      expect((yield* tools.snapshot()).definitions.map((tool) => tool.name)).toEqual(["execute"])
      const run = (id: string, code: string) =>
        executeTool(tools, {
          ...toolIdentity,
          sessionID: session.id,
          call: { type: "tool-call", id, name: "execute", input: { code } },
        })
      const earlier = yield* run(
        "earlier",
        'return await tools.$opencode.exec_command({ cmd: "Start-Sleep -Seconds 30", lane_id: 1, yield_time_ms: 100 })',
      )
      const previous = Schema.decodeUnknownSync(Schema.Array(ChildCall))(earlier.metadata?.toolCalls)
      const previousExec = Schema.decodeUnknownSync(SessionExec.Metadata)(previous[0].metadata).execID!
      const failed = yield* run(
        "failed",
        'await tools.$opencode.exec_command({ cmd: "Start-Sleep -Seconds 30", yield_time_ms: 100 }); throw new Error("later failure")',
      )
      expect(failed.metadata?.error).toBe(true)
      const calls = Schema.decodeUnknownSync(Schema.Array(ChildCall))(failed.metadata?.toolCalls)
      const failedExec = Schema.decodeUnknownSync(SessionExec.Metadata)(calls[0].metadata).execID!
      const invocation: ExecSession.Invocation = {
        sessionID: session.id,
        messageID: toolIdentity.messageID,
        display: "poll",
        metadata: () => Effect.void,
      }
      expect((yield* executions.write({ execID: failedExec, invocation, yieldTimeMs: 0 })).running).toBe(false)
      expect((yield* executions.write({ execID: previousExec, invocation, yieldTimeMs: 0 })).running).toBe(true)
      yield* executions.terminate({ execID: previousExec, invocation, yieldTimeMs: 0 })
    }),
  { timeout: 20_000 },
)
