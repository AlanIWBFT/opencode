import { expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { ExecSessionControl } from "@opencode/core/tool/exec-session/control"
import { AbsolutePath } from "@opencode/schema/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Session.node, ExecSessionControl.node]), [
    SessionExecution.node.replace(SessionExecution.noopLayer),
  ]),
)

it.effect("archive persists before stopping existing owners and restore waits for cleanup", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const control = yield* ExecSessionControl.Service
    const session = yield* sessions.create({ location: { directory: AbsolutePath.make(process.cwd()) } })
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let stops = 0
    yield* control.register((targets) =>
      Effect.gen(function* () {
        expect(targets).toEqual([{ sessionID: session.id }])
        expect(DateTime.toEpochMillis((yield* sessions.get(session.id).pipe(Effect.orDie)).time.archived!)).toBe(12345)
        stops++
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return { matched: 1, terminated: 1, failed: 0 }
      }),
    )
    const archive = yield* sessions
      .setArchived({ sessionID: session.id, archivedAt: 12345 })
      .pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(started)
    const restore = yield* sessions
      .setArchived({ sessionID: session.id, archivedAt: null })
      .pipe(Effect.forkScoped({ startImmediately: true }))
    expect(DateTime.toEpochMillis((yield* sessions.get(session.id)).time.archived!)).toBe(12345)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(archive)
    yield* Fiber.join(restore)
    expect((yield* sessions.get(session.id)).time.archived).toBeUndefined()
    expect(stops).toBe(1)
  }),
)
