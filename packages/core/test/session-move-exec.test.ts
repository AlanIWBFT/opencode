import { expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Instance } from "@opencode/core/instance"
import { Plugin } from "@opencode/core/plugin"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionExec } from "@opencode/schema/session-exec"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Session.node, Instance.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
  ]).pipe(
    Layer.provide(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ OPENCODE_EXPERIMENTAL_CODE_MODE: false }),
      ),
    ),
  ),
)
const native = process.platform === "win32" && Bun.which("pwsh") ? it.live : it.live.skip

native(
  "move closes the source session's slots before destination execution and preserves child commands",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const source = AbsolutePath.make(path.join(tmp.path, "source"))
      const destination = AbsolutePath.make(path.join(tmp.path, "destination"))
      yield* Effect.promise(() => Promise.all([mkdir(source), mkdir(destination)]))
      const sessions = yield* Session.Service
      const instances = yield* Instance.Service
      const parent = yield* sessions.create({
        location: { directory: source },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      })
      const child = yield* sessions.create({ parentID: parent.id })
      yield* Effect.addFinalizer(() =>
        Effect.forEach([parent.id, child.id], (id) => sessions.stop(id).pipe(Effect.orDie), { discard: true }),
      )
      let nextCall = 0
      const executeAt = Effect.fnUntraced(function* (session: Session.Info, name: string, input: unknown) {
        return yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          const tools = yield* Tool.Service
          return yield* executeTool(tools, {
            ...toolIdentity,
            sessionID: session.id,
            call: { type: "tool-call", id: `move-${nextCall++}`, name, input },
          })
        }).pipe(instances.provide(session))
      })
      const execute = (sessionID: Session.Info["id"], name: string, input: unknown) =>
        sessions.get(sessionID).pipe(Effect.flatMap((session) => executeAt(session, name, input)))
      const before = yield* execute(parent.id, "exec_command", {
        cmd: "$retained = 'source-state'; Start-Sleep 30",
        yield_time_ms: 100,
      })
      const background = yield* execute(child.id, "exec_command", { cmd: "Start-Sleep 30", yield_time_ms: 100 })
      const decode = Schema.decodeUnknownSync(SessionExec.Metadata)
      const old = decode(before.metadata)
      const childCommand = decode(background.metadata)
      expect(old.processRunning).toBe(true)
      expect(childCommand.processRunning).toBe(true)
      yield* sessions.move({ sessionID: parent.id, directory: destination })
      yield* sessions.wait(parent.id)
      expect((yield* sessions.get(parent.id)).location.directory).toBe(destination)
      expect((yield* sessions.get(child.id)).location.directory).toBe(source)
      const sourceResult = decode(
        (yield* executeAt(parent, "poll_exec", { exec_id: old.execID, yield_time_ms: 0 })).metadata,
      )
      expect(sourceResult.processRunning).toBe(false)
      const after = decode(
        (yield* execute(parent.id, "exec_command", { cmd: "Write-Output ('fresh:' + $retained); (Get-Location).Path" }))
          .metadata,
      )
      expect(after.execError).toBeUndefined()
      expect(after.output).toContain("fresh:")
      expect(after.output).not.toContain("source-state")
      expect(after.cwd).toBe(destination)
      expect(after.execID).toBeGreaterThan(0)
      expect(after.execID).not.toBe(old.execID)
      expect(after.execID).not.toBe(childCommand.execID)
      const oldPoll = decode(
        (yield* execute(parent.id, "poll_exec", { exec_id: old.execID, yield_time_ms: 0 })).metadata,
      )
      expect(oldPoll.execError).toContain("execution not found")
      expect(
        decode((yield* execute(child.id, "poll_exec", { exec_id: childCommand.execID, yield_time_ms: 0 })).metadata)
          .processRunning,
      ).toBe(true)
      expect(yield* sessions.stop(child.id)).toEqual({ matched: 1, terminated: 1, failed: 0 })
    }),
  { timeout: 30_000 },
)
