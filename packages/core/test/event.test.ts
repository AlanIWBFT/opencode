import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Event } from "@opencode-ai/schema/event"
import { Session } from "@opencode-ai/schema/session"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location({ directory: AbsolutePath.make("project"), workspaceID: WorkspaceV2.ID.make("wrk_test") }),
  ),
)
const Message = EventV2.define({
  type: "test.message",
  schema: {
    text: Schema.String,
  },
})

const SyncMessage = EventV2.define({
  type: "test.sync",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const SyncSent = EventV2.define({
  type: "test.sent",
  durable: {
    version: 1,
    aggregate: "messageID",
  },
  schema: {
    messageID: Schema.String,
    text: Schema.String,
  },
})

const GlobalMessage = EventV2.define({
  type: "test.global",
  schema: {
    text: Schema.String,
  },
})

const VersionedMessage = EventV2.define({
  type: "test.versioned",
  durable: {
    version: 2,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const DurableMessage = SessionV1.Event.MessageRemoved
const durableData = (sessionID: Session.ID, text: string) => ({
  sessionID,
  messageID: SessionV1.MessageID.ascending(`msg_${text}`),
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, Location.node]), [[Location.node, locationLayer]]),
)
const itWithoutLocation = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

describe("EventV2", () => {
  it.effect("publishes events with the current location", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const fiber = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })
      const received = Array.from(yield* Fiber.join(fiber))

      expect(received).toEqual([event])
      expect(event.type).toBe("test.message")
      expect(event).not.toHaveProperty("version")
      expect(event.data).toEqual({ text: "hello" })
      expect(event.location).toEqual({
        directory: AbsolutePath.make("project"),
        workspaceID: WorkspaceV2.ID.make("wrk_test"),
      })
    }),
  )

  itWithoutLocation.effect("omits location when no location is available", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const event = yield* events.publish(GlobalMessage, { text: "hello" })

      expect(event).not.toHaveProperty("location")
      expect(event.type).toBe("test.global")
    }),
  )

  it.effect("publishes definition version", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const event = yield* events.publish(VersionedMessage, { id: "one", text: "hello" })

      expect(event.type).toBe("test.versioned")
      expect(event.durable?.version).toBe(2)
    }),
  )

  it.effect("selects the latest durable definition independent of declaration order", () =>
    Effect.sync(() => {
      const latest = EventV2.define({
        type: "test.out-of-order",
        durable: { version: 2, aggregate: "id" },
        schema: { id: Schema.String },
      })
      const historical = EventV2.define({
        type: "test.out-of-order",
        durable: { version: 1, aggregate: "id" },
        schema: { id: Schema.String },
      })

      expect(Event.latest([latest, historical]).get("test.out-of-order")).toBe(latest)
      expect(Event.latest([historical, latest]).get("test.out-of-order")).toBe(latest)
    }),
  )

  it.effect("publishes to typed and wildcard subscriptions", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const typed = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const wildcard = yield* events.all().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })

      expect(Array.from(yield* Fiber.join(typed))).toEqual([event])
      expect(Array.from(yield* Fiber.join(wildcard))).toEqual([event])
    }),
  )

  it.effect("runs projectors inline", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      const event = yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* events.publish(SyncMessage, { id: "one", text: "after unsubscribe" })

      expect(received[0]).toEqual(event)
      expect(received[1]?.data).toEqual({ id: "one", text: "after unsubscribe" })
    }),
  )

  it.effect("commits local operational state inside a new durable event transaction", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const aggregateID = EventV2.ID.create()
      yield* events.project(SyncMessage, () => Effect.sync(() => received.push("projector")))

      yield* events.publish(
        SyncMessage,
        { id: aggregateID, text: "hello" },
        { commit: (seq) => Effect.sync(() => received.push(`commit:${seq}`)) },
      )

      expect(received).toEqual(["projector", "commit:0"])
    }),
  )

  it.effect("rolls back the durable event and projector when the local commit fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      yield* db.run("CREATE TABLE IF NOT EXISTS event_commit_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_commit_probe")
      yield* events.project(SyncMessage, () =>
        db.run("INSERT INTO event_commit_probe (value) VALUES ('projected')").pipe(Effect.orDie, Effect.asVoid),
      )

      const exit = yield* events
        .publish(SyncMessage, { id: aggregateID, text: "hello" }, { commit: () => Effect.die("commit failed") })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("commit failed")
      expect(yield* db.all("SELECT value FROM event_commit_probe")).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
    }),
  )

  it.effect("rejects local commit hooks on live-only events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events.publish(Message, { text: "hello" }, { commit: () => Effect.void }).pipe(Effect.exit)

      expect(String(exit)).toContain("Local commit hooks require a durable event")
    }),
  )

  it.effect("runs projectors before publishing to streams", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const fiber = yield* events.all().pipe(
        Stream.take(1),
        Stream.runForEach(() => Effect.sync(() => received.push("stream"))),
        Effect.forkScoped,
      )
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      yield* Effect.yieldNow
      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* Fiber.join(fiber)

      expect(received).toEqual([SyncMessage.type, "stream"])
    }),
  )

  it.effect("runs listeners inline after projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.project(SyncMessage, () =>
        Effect.sync(() => {
          received.push("projector")
        }),
      )
      const unsubscribe = yield* events.listen(() =>
        Effect.sync(() => {
          received.push("listener")
        }),
      )

      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* unsubscribe
      yield* events.publish(SyncMessage, { id: "one", text: "after unsubscribe" })

      expect(received).toEqual(["projector", "listener", "projector"])
    }),
  )

  it.effect("isolates observer defects after durable events commit", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.listen(() => {
        throw new Error("listener defect")
      })
      yield* events.listen((event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      const event = yield* events.publish(SyncMessage, { id: "one", text: "hello" })

      expect(received).toEqual([SyncMessage.type])
      expect(event.durable?.seq).toBeNumber()
    }),
  )

  it.effect("notifies global listeners only after a durable event is committed", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const observed = new Array<{ id: string; seq: number }>()
      yield* events.listen((event) =>
        event.type !== SyncMessage.type
          ? Effect.void
          : db
              .select({ id: EventTable.id, seq: EventTable.seq })
              .from(EventTable)
              .where(eq(EventTable.id, event.id))
              .get()
              .pipe(
                Effect.orDie,
                Effect.tap((row) =>
                  Effect.sync(() => {
                    if (row) observed.push(row)
                  }),
                ),
                Effect.asVoid,
              ),
      )

      const event = yield* events.publish(SyncMessage, { id: aggregateID, text: "committed" })
      if (!event.durable) throw new Error("Expected durable event metadata")

      expect(observed).toEqual([{ id: event.id, seq: event.durable.seq }])
    }),
  )

  it.effect("ends only an overflowing bounded subscriber without blocking other listeners", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const consuming = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const slowStream = yield* EventV2.allBounded(events, 1)
      const fastStream = yield* EventV2.allBounded(events, 8)
      const slow = yield* slowStream.pipe(
        Stream.runForEach(() => Deferred.succeed(consuming, undefined).pipe(Effect.andThen(Deferred.await(release)))),
        Effect.forkScoped,
      )
      const fast = yield* fastStream.pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)

      yield* events.publish(Message, { text: "one" })
      yield* Deferred.await(consuming)
      yield* events.publish(Message, { text: "two" })
      yield* events.publish(Message, { text: "overflow" })
      const last = yield* events.publish(Message, { text: "still delivered" })
      yield* Deferred.succeed(release, undefined)

      const slowExit = yield* Fiber.await(slow)
      expect(Exit.findErrorOption(slowExit).pipe(Option.getOrUndefined)).toBeInstanceOf(EventV2.SubscriberOverflowError)
      expect(Array.from(yield* Fiber.join(fast))).toEqual([
        expect.objectContaining({ data: { text: "one" } }),
        expect.objectContaining({ data: { text: "two" } }),
        expect.objectContaining({ data: { text: "overflow" } }),
        last,
      ])
    }),
  )

  it.effect("preserves observer interruption", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.listen(() => Effect.interrupt)

      const exit = yield* events.publish(SyncMessage, { id: "interrupted", text: "hello" }).pipe(Effect.exit)
      const committed = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, "interrupted"))
        .get()
        .pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBeTrue()
      expect(committed).toBeDefined()
    }),
  )

  it.effect("keeps live-only listener defects fail-fast", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const defect = new Error("listener defect")
      yield* events.listen(() => Effect.die(defect))

      expect(yield* events.publish(Message, { text: "hello" }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("inserts durable event rows on publish", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.type).toBe(EventV2.versionedType(SyncMessage.type, 1))
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("increments durable event seq per aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      yield* events.publish(SyncMessage, { id: aggregateID, text: "second" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
    }),
  )

  it.effect("publishes a durable batch atomically in input order", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const observed = new Array<{ text: string; rows: number }>()
      const typed = yield* events.subscribe(SyncMessage).pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
      const all = yield* events.all().pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* events.listen((event) =>
        event.type !== SyncMessage.type
          ? Effect.void
          : db
              .select({ id: EventTable.id })
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, aggregateID))
              .all()
              .pipe(
                Effect.orDie,
                Effect.tap((rows) =>
                  Effect.sync(() =>
                    observed.push({ text: (event.data as typeof SyncMessage.data.Type).text, rows: rows.length }),
                  ),
                ),
                Effect.asVoid,
              ),
      )

      const committed = yield* events.publishBatch([
        EventV2.publishItem(SyncMessage, { id: aggregateID, text: "one" }),
        EventV2.publishItem(SyncMessage, { id: aggregateID, text: "two" }),
        EventV2.publishItem(SyncMessage, { id: aggregateID, text: "three" }),
      ])

      expect(committed.map((event) => [event.durable?.seq, (event.data as typeof SyncMessage.data.Type).text])).toEqual([
        [0, "one"],
        [1, "two"],
        [2, "three"],
      ])
      expect(observed).toEqual([
        { text: "one", rows: 3 },
        { text: "two", rows: 3 },
        { text: "three", rows: 3 },
      ])
      expect(Array.from(yield* Fiber.join(typed)).map((event) => event.data.text)).toEqual(["one", "two", "three"])
      expect(
        Array.from(yield* Fiber.join(all)).map((event) => (event.data as typeof SyncMessage.data.Type).text),
      ).toEqual(["one", "two", "three"])
    }),
  )

  it.effect("uses an explicitly selected batch projector and otherwise preserves ordinary projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const projected = new Array<string>()
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => projected.push(`single:${event.data.text}`)),
      )
      yield* events.projectBatch("test.batch", [SyncMessage], {
        accepts: () => true,
        project: (batch) =>
          Effect.sync(() => {
            projected.push(...batch.map((event) => `batch:${(event.data as typeof SyncMessage.data.Type).text}`))
          }),
      })

      yield* events.publishBatch(
        [
          EventV2.publishItem(SyncMessage, { id: aggregateID, text: "one" }),
          EventV2.publishItem(SyncMessage, { id: aggregateID, text: "two" }),
        ],
        { projector: "test.batch" },
      )
      yield* events.publishBatch([
        EventV2.publishItem(SyncMessage, { id: aggregateID, text: "three" }),
        EventV2.publishItem(SyncMessage, { id: aggregateID, text: "four" }),
      ])

      expect(projected).toEqual(["batch:one", "batch:two", "single:three", "single:four"])
    }),
  )

  it.effect("falls back from a selected batch projector when another projector is registered", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const projected = new Array<string>()
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => projected.push(`original:${event.data.text}`)),
      )
      yield* events.projectBatch("test.batch", [SyncMessage], {
        accepts: () => true,
        project: () => Effect.sync(() => void projected.push("batch")),
      })
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => projected.push(`additional:${event.data.text}`)),
      )

      yield* events.publishBatch(
        [EventV2.publishItem(SyncMessage, { id: aggregateID, text: "one" })],
        { projector: "test.batch" },
      )

      expect(projected).toEqual(["original:one", "additional:one"])
    }),
  )

  it.effect("finishes batch notifications after external interruption", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const notified = new Array<string>()
      yield* events.project(SyncMessage, (event) =>
        event.data.id === aggregateID && event.data.text === "one"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      )
      yield* events.listen((event) => {
        if (event.type !== SyncMessage.type) return Effect.void
        const data = event.data as typeof SyncMessage.data.Type
        if (data.id === aggregateID) notified.push(data.text)
        return Effect.void
      })
      const fiber = yield* events
        .publishBatch([
          EventV2.publishItem(SyncMessage, { id: aggregateID, text: "one" }),
          EventV2.publishItem(SyncMessage, { id: aggregateID, text: "two" }),
        ])
        .pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(entered)
      fiber.interruptUnsafe()
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.await(fiber)
      const rows = yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBeTrue()
      expect(rows.map((row) => row.seq)).toEqual([0, 1])
      expect(notified).toEqual(["one", "two"])
    }),
  )

  it.effect("preserves batch options and runs projectors before commit hooks", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const order = new Array<string>()
      const id = EventV2.ID.create()
      const explicit = Location.Ref.make({ directory: AbsolutePath.make("explicit") })
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => order.push(`project:${event.data.text}`)),
      )

      const [event] = yield* events.publishBatch([
        EventV2.publishItem(
          SyncMessage,
          { id: aggregateID, text: "one" },
          {
            id,
            metadata: { source: "batch" },
            location: explicit,
            commit: (seq) => Effect.sync(() => order.push(`commit:${seq}`)),
          },
        ),
      ])

      expect(event).toMatchObject({ id, metadata: { source: "batch" }, location: explicit })
      expect(order).toEqual(["project:one", "commit:0"])
    }),
  )

  it.effect("rolls back a complete batch when a projector fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const notified = new Array<EventV2.Payload>()
      yield* db.run("CREATE TABLE IF NOT EXISTS event_batch_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_batch_probe")
      yield* events.project(SyncMessage, (event) =>
        event.data.text === "fail"
          ? Effect.die("projector failed")
          : db
              .run(`INSERT INTO event_batch_probe (value) VALUES ('${event.data.text}')`)
              .pipe(Effect.orDie, Effect.asVoid),
      )
      yield* events.listen((event) => Effect.sync(() => notified.push(event)))

      const exit = yield* events
        .publishBatch([
          EventV2.publishItem(SyncMessage, { id: aggregateID, text: "one" }),
          EventV2.publishItem(SyncMessage, { id: aggregateID, text: "fail" }),
        ])
        .pipe(Effect.exit)

      expect(String(exit)).toContain("projector failed")
      expect(yield* db.all("SELECT value FROM event_batch_probe")).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
      expect(notified).toEqual([])
    }),
  )

  it.effect("rolls back a complete batch when a commit hook fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const exit = yield* events
        .publishBatch([
          EventV2.publishItem(SyncMessage, { id: aggregateID, text: "one" }),
          EventV2.publishItem(SyncMessage, { id: aggregateID, text: "two" }, { commit: () => Effect.die("failed") }),
        ])
        .pipe(Effect.exit)

      expect(String(exit)).toContain("failed")
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
    }),
  )

  it.effect("rejects invalid batches before writes", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const one = EventV2.ID.create()
      const two = EventV2.ID.create()
      const duplicate = EventV2.ID.create()
      const live = yield* events.publishBatch([EventV2.publishItem(Message, { text: "live" })]).pipe(Effect.exit)
      const mixed = yield* events
        .publishBatch([
          EventV2.publishItem(SyncMessage, { id: one, text: "one" }),
          EventV2.publishItem(SyncMessage, { id: two, text: "two" }),
        ])
        .pipe(Effect.exit)
      const repeated = yield* events
        .publishBatch([
          EventV2.publishItem(SyncMessage, { id: one, text: "one" }, { id: duplicate }),
          EventV2.publishItem(SyncMessage, { id: one, text: "two" }, { id: duplicate }),
        ])
        .pipe(Effect.exit)
      const empty = yield* events.publishBatch([])

      expect(String(live)).toContain("Batch publish requires durable events")
      expect(String(mixed)).toContain("same aggregate")
      expect(String(repeated)).toContain("Duplicate event ID")
      expect(empty).toEqual([])
      expect(yield* db.select().from(EventTable).all()).toEqual([])
    }),
  )

  it.effect("serializes concurrent single and batch publishes", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* Effect.all(
        [
          events.publish(SyncMessage, { id: aggregateID, text: "single" }),
          events.publishBatch([
            EventV2.publishItem(SyncMessage, { id: aggregateID, text: "batch-one" }),
            EventV2.publishItem(SyncMessage, { id: aggregateID, text: "batch-two" }),
          ]),
        ],
        { concurrency: "unbounded" },
      )
      const rows = yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2])
    }),
  )

  it.effect("advances the aggregate sequence once for a complete batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      yield* db.run("CREATE TABLE event_sequence_write_probe (aggregate_id text NOT NULL)")
      yield* db.run(`
        CREATE TRIGGER event_sequence_insert_probe
        AFTER INSERT ON event_sequence
        BEGIN
          INSERT INTO event_sequence_write_probe (aggregate_id) VALUES (NEW.aggregate_id);
        END
      `)
      yield* db.run(`
        CREATE TRIGGER event_sequence_update_probe
        AFTER UPDATE OF seq ON event_sequence
        BEGIN
          INSERT INTO event_sequence_write_probe (aggregate_id) VALUES (NEW.aggregate_id);
        END
      `)

      yield* events.publishBatch([
        EventV2.publishItem(SyncMessage, { id: aggregateID, text: "one" }),
        EventV2.publishItem(SyncMessage, { id: aggregateID, text: "two" }),
        EventV2.publishItem(SyncMessage, { id: aggregateID, text: "three" }),
      ])
      const writes = yield* db.all<{ aggregate_id: string }>(
        `SELECT aggregate_id FROM event_sequence_write_probe WHERE aggregate_id = '${aggregateID}'`,
      )
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(writes).toEqual([{ aggregate_id: aggregateID }])
      expect(sequence).toEqual({ seq: 2 })
    }),
  )

  it.effect("wakes a durable subscriber once for a complete batch", () =>
    Effect.gen(function* () {
      let reads = 0
      const eventLayer = EventV2.layerWith({
        beforeAggregateRead: () =>
          Effect.sync(() => {
            reads++
          }),
      }).pipe(Layer.provide(LayerNode.compile(Database.node)))

      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const aggregateID = Session.ID.create()
        const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
        yield* Effect.yieldNow

        yield* events.publishBatch([
          EventV2.publishItem(DurableMessage, durableData(aggregateID, "one")),
          EventV2.publishItem(DurableMessage, durableData(aggregateID, "two")),
          EventV2.publishItem(DurableMessage, durableData(aggregateID, "three")),
        ])

        expect(Array.from(yield* Fiber.join(fiber)).map((event) => event.durable?.seq)).toEqual([0, 1, 2])
        expect(reads).toBe(2)
      }).pipe(Effect.provide(Layer.merge(LayerNode.compile(Database.node), eventLayer)))
    }),
  )

  it.effect("publishes batches larger than one event ID lookup chunk", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const count = 501

      const committed = yield* events.publishBatch(
        Array.from({ length: count }, (_, index) =>
          EventV2.publishItem(DurableMessage, durableData(aggregateID, `large_${index}`)),
        ),
      )

      expect(committed).toHaveLength(count)
      expect(committed[0]?.durable?.seq).toBe(0)
      expect(committed.at(-1)?.durable?.seq).toBe(count - 1)
    }),
  )

  it.effect("rejects an existing event ID in a later lookup chunk", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const existingAggregateID = Session.ID.create()
      const aggregateID = Session.ID.create()
      const existingID = EventV2.ID.create()
      yield* events.publish(DurableMessage, durableData(existingAggregateID, "existing"), { id: existingID })

      const exit = yield* events
        .publishBatch(
          Array.from({ length: 201 }, (_, index) =>
            EventV2.publishItem(DurableMessage, durableData(aggregateID, `large_${index}`), {
              ...(index === 150 ? { id: existingID } : {}),
            }),
          ),
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain(`Event ${existingID} already exists`)
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
    }),
  )

  it.effect("replays durable aggregate events after a sequence and tails new events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "zero"))
      yield* events.publish(DurableMessage, durableData(aggregateID, "one"))
      const fiber = yield* events
        .durable({ aggregateID, after: 0 })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(DurableMessage, durableData(aggregateID, "two"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [1, durableData(aggregateID, "one")],
        [2, durableData(aggregateID, "two")],
      ])
    }),
  )

  it.effect("catches durable aggregate events published during replay handoff", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "zero"))
      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)

      yield* events.publish(DurableMessage, durableData(aggregateID, "one"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [0, durableData(aggregateID, "zero")],
        [1, durableData(aggregateID, "one")],
      ])
    }),
  )

  it.effect("retains a durable wake committed while historical replay is paused", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>()
      const continueRead = yield* Deferred.make<void>()
      let pause = true
      const eventLayer = EventV2.layerWith({
        beforeAggregateRead: () =>
          pause
            ? Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(continueRead)))
            : Effect.void,
      }).pipe(Layer.provide(LayerNode.compile(Database.node)))

      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const aggregateID = Session.ID.create()
        const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Deferred.await(readStarted)

        pause = false
        yield* events.publish(DurableMessage, durableData(aggregateID, "during handoff"))
        yield* Deferred.succeed(continueRead, undefined)

        expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
          [0, durableData(aggregateID, "during handoff")],
        ])
      }).pipe(Effect.provide(Layer.merge(LayerNode.compile(Database.node), eventLayer)))
    }),
  )

  it.effect("coalesces durable aggregate wakes while draining every committed event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const count = 64
      const fiber = yield* events
        .durable({ aggregateID })
        .pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      for (let index = 0; index < count; index++) {
        yield* events.publish(DurableMessage, durableData(aggregateID, String(index)))
      }

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual(
        Array.from({ length: count }, (_, index) => [index, durableData(aggregateID, String(index))]),
      )
    }),
  )

  it.effect("omits live-only events from durable aggregate streams", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(Message, { text: "live only" })
      yield* events.publish(DurableMessage, durableData(aggregateID, "durable"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => event.type)).toEqual([DurableMessage.type])
    }),
  )

  it.effect("uses custom sync aggregate field", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncSent, { messageID: aggregateID, text: "sent" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("replays durable events through projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "hello"),
      })

      expect(received[0]?.type).toBe(DurableMessage.type)
      expect(received[0]?.data).toEqual(durableData(aggregateID, "hello"))
    }),
  )

  it.effect("replay inserts external event rows", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect(
    "replay rejects an envelope aggregate that differs from its payload without mutating the payload aggregate",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const envelopeAggregateID = Session.ID.create()
        const payloadAggregateID = Session.ID.create()
        const received = new Array<EventV2.Payload>()
        yield* events.publish(DurableMessage, durableData(payloadAggregateID, "seed"))
        yield* events.project(DurableMessage, (event) =>
          Effect.sync(() => {
            received.push(event)
          }),
        )

        const exit = yield* events
          .replay({
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID: envelopeAggregateID,
            data: durableData(payloadAggregateID, "replayed"),
          })
          .pipe(Effect.exit)
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, payloadAggregateID))
          .all()
          .pipe(Effect.orDie)
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, payloadAggregateID))
          .get()
          .pipe(Effect.orDie)

        expect(String(exit)).toContain("Aggregate mismatch")
        expect(received).toHaveLength(0)
        expect(rows).toHaveLength(1)
        expect(sequence).toEqual({ seq: 0 })
      }),
  )

  it.effect("replay defects on sequence mismatch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "first"),
      })
      const exit = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 5,
          aggregateID,
          data: durableData(aggregateID, "bad"),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Sequence mismatch")
    }),
  )

  it.effect("replay decodes synchronized transformed values before projection", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const received = new Array<typeof SessionEvent.ContextUpdated.Type>()
      yield* events.project(SessionEvent.ContextUpdated, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SessionEvent.ContextUpdated.type, 1),
        seq: 0,
        aggregateID,
        data: { sessionID: aggregateID, messageID: "msg_context", timestamp: 0, text: "context" },
      })

      expect(received[0]?.data.timestamp).toEqual(DateTime.makeUnsafe(0))
    }),
  )

  it.effect("replay defects on unknown event type", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: "unknown.event.1",
          seq: 0,
          aggregateID: EventV2.ID.create(),
          data: {},
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Unknown durable event type")
    }),
  )

  it.effect("replayAll validates contiguous aggregate events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const source = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "one"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "two"),
        },
      ])

      expect(source).toBe(aggregateID)
    }),
  )

  it.effect("replayAll accepts later chunks after the first batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      const one = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "one"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "two"),
        },
      ])
      const two = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 2,
          aggregateID,
          data: durableData(aggregateID, "three"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 3,
          aggregateID,
          data: durableData(aggregateID, "four"),
        },
      ])
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(one).toBe(aggregateID)
      expect(two).toBe(aggregateID)
      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
    }),
  )

  it.effect("claim fences replay owners", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "seed"))
      yield* events.claim(aggregateID, "owner-a")
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "ignored"),
        },
        { ownerID: "owner-b" },
      )

      expect(received).toHaveLength(0)
    }),
  )

  it.effect("strict owner fences exact replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const id = EventV2.ID.create()
      const replayed = {
        id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "owned"),
      }
      yield* events.replay(replayed, { ownerID: "owner-a" })

      const exit = yield* events.replay(replayed, { ownerID: "owner-b", strictOwner: true }).pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("exact replay claims an unowned aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const published = yield* events.publish(DurableMessage, durableData(aggregateID, "owned"))
      const replayed = {
        id: published.id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: published.durable!.seq,
        aggregateID,
        data: published.data,
      }

      yield* events.replay(replayed, { ownerID: "owner-a", strictOwner: true })
      const row = yield* db
        .select({ ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row?.ownerID).toBe("owner-a")
      const exit = yield* events
        .replay(
          { ...replayed, id: EventV2.ID.create(), seq: 1, data: durableData(aggregateID, "conflict") },
          { ownerID: "owner-b", strictOwner: true },
        )
        .pipe(Effect.exit)
      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("replay with owner claims an unowned sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "owned"),
        },
        { ownerID: "owner-1" },
      )
      const row = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-1" })
    }),
  )

  it.effect("replay claims an existing unowned sequence before fencing a different owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "local"))

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "claimed"),
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 2,
          aggregateID,
          data: durableData(aggregateID, "fenced"),
        },
        { ownerID: "owner-2" },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
      expect(sequence).toEqual({ seq: 1, ownerID: "owner-1" })
    }),
  )

  it.effect("strict replay rejects an owner conflict instead of silently skipping it", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "claimed"),
        },
        { ownerID: "owner-1" },
      )

      const exit = yield* events
        .replay(
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID,
            data: durableData(aggregateID, "conflict"),
          },
          { ownerID: "owner-2", strictOwner: true },
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("publishes accepted replay with its durable sequence and suppresses stale replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      const replayed = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      }

      yield* events.replay(replayed, { publish: true })
      yield* events.replay(replayed, { publish: true })

      expect(received).toMatchObject([{ id: replayed.id, durable: { seq: 0, version: 1 }, data: replayed.data }])
    }),
  )

  it.effect("rejects divergent stale replay without publishing it", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      const replayed = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "original"),
      }
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      yield* events.replay(replayed, { publish: true })

      const exit = yield* events
        .replay({ ...replayed, data: durableData(aggregateID, "divergent") }, { publish: true })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay diverged")
      expect(received).toHaveLength(1)
    }),
  )

  it.effect("rejects an event ID reused at another aggregate position", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const id = EventV2.ID.create()
      yield* events.replay({
        id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "first"),
      })

      const exit = yield* events
        .replay({
          id,
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "second"),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain(`Event ${id} already exists`)
    }),
  )

  it.effect("replay from a different owner leaves claimed sequence unchanged", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const received = new Array<EventV2.Payload>()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "first"),
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "ignored"),
        },
        { ownerID: "owner-2", publish: true },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(sequence).toEqual({ seq: 0, ownerID: "owner-1" })
      expect(received).toHaveLength(0)
    }),
  )

  it.effect("claim updates the event sequence owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "claimed" })
      yield* events.claim(aggregateID, "owner-1")
      yield* events.claim(aggregateID, "owner-2")
      const row = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-2" })
    }),
  )

  it.effect("remove clears durable event sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "seed"))
      yield* events.remove(aggregateID)
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      })

      expect(received[0]?.data).toEqual(durableData(aggregateID, "replayed"))
    }),
  )
})
