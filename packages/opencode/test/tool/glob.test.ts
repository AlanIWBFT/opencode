import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { provideInstance, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Git } from "@/git"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"

const toolLayer = () =>
  LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]))

const it = testEffect(toolLayer())
const rooted = testEffect(Layer.mergeAll(toolLayer(), testInstanceStoreLayer))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

describe("tool.glob", () => {
  it.instance("matches files from a directory path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "b.txt"), "hello\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const result = yield* glob.execute(
        {
          pattern: "*.ts",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain(path.join(test.directory, "a.ts"))
      expect(result.output).not.toContain(path.join(test.directory, "b.txt"))
    }),
  )

  it.instance("rejects exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "a.ts")
      yield* Effect.promise(() => Bun.write(file, "export const a = 1\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const exit = yield* glob
        .execute(
          {
            pattern: "*.ts",
            path: file,
          },
          ctx,
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err instanceof Error ? err.message : String(err)).toContain("glob path must be a directory")
      }
    }),
  )
  rooted.live("skips external_directory permission for external paths while keeping glob permission", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => Bun.write(path.join(outer, "a.ts"), "export const a = 1\n"))

      const { items, next } = asks()
      const info = yield* GlobTool
      const glob = yield* info.init()
      const result = yield* provideInstance(dir)(
        glob.execute(
          {
            pattern: "*.ts",
            path: outer,
          },
          next,
        ),
      )

      expect(result.output).toContain(path.join(outer, "a.ts"))
      expect(items.find((item) => item.permission === "external_directory")).toBeUndefined()
      expect(items.find((item) => item.permission === "glob")).toBeDefined()
    }),
  )
})
