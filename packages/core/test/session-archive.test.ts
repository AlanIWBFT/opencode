import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Deferred, Effect, Fiber } from "effect"
import { ExecSessionControl } from "@opencode/core/tool/exec-session/control"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node, ExecSessionControl.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("Session.archive", () => {
  it.effect("archives and unarchives through one durable event each", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      expect(created.time.archived).toBeUndefined()

      yield* session.archive(created.id)
      yield* session.archive(created.id)
      expect((yield* session.get(created.id)).time.archived).toBeDefined()

      yield* session.unarchive(created.id)
      yield* session.unarchive(created.id)
      expect((yield* session.get(created.id)).time.archived).toBeUndefined()

      const types = (yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .all()).map((event) => event.type)
      expect(types.filter((type) => type === Bus.versionedType(SessionEvent.Archived.type, 1))).toHaveLength(1)
      expect(types.filter((type) => type === Bus.versionedType(SessionEvent.Unarchived.type, 1))).toHaveLength(1)
    }),
  )

  it.effect("filters listed sessions by archive state", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const active = yield* session.create({ location })
      const archived = yield* session.create({ location })
      yield* session.archive(archived.id)

      const ids = (input?: Session.ListInput) =>
        session.list(input).pipe(Effect.map((page) => page.data.map((item) => item.id).toSorted()))
      expect(yield* ids()).toEqual([active.id, archived.id].toSorted())
      expect(yield* ids({ archived: false })).toEqual([active.id])
      expect(yield* ids({ archived: true })).toEqual([archived.id])
    }),
  )

  it.effect("rejects an unknown session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sessionID = Session.ID.make("ses_missing_archive")
      expect(yield* Effect.flip(session.archive(sessionID))).toEqual(new Session.NotFoundError({ sessionID }))
      expect(yield* Effect.flip(session.unarchive(sessionID))).toEqual(new Session.NotFoundError({ sessionID }))
    }),
  )
})
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
        expect((yield* sessions.get(session.id).pipe(Effect.orDie)).time.archived).toBeDefined()
        stops++
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return { matched: 1, terminated: 1, failed: 0 }
      }),
    )
    const archive = yield* sessions
      .archive(session.id)
      .pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(started)
    const restore = yield* sessions
      .unarchive(session.id)
      .pipe(Effect.forkScoped({ startImmediately: true }))
    expect((yield* sessions.get(session.id)).time.archived).toBeDefined()
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(archive)
    yield* Fiber.join(restore)
    expect((yield* sessions.get(session.id)).time.archived).toBeUndefined()
    expect(stops).toBe(1)
  }),
)
