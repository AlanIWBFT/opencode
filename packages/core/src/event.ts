export * as EventV2 from "./event"

import { Cause, Context, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect"
import { Event } from "@opencode-ai/schema/event"
import type { Data, Definition, Payload } from "@opencode-ai/schema/event"
import { and, asc, eq, gt, inArray } from "drizzle-orm"
import { Database } from "./database/database"
import { EventSequenceTable, EventTable } from "./event/sql"
import { Location } from "./location"
import { makeGlobalNode } from "./effect/app-node"
import { isDeepStrictEqual } from "node:util"
import { Durable } from "@opencode-ai/schema/durable-event-manifest"

// SQLite may scan the complete event table for larger parameterized IN lists despite the primary key.
const eventIDLookupChunkSize = 100

export const ID = Event.ID
export type ID = import("@opencode-ai/schema/event").ID
export type { Data, Definition, Payload } from "@opencode-ai/schema/event"

export type Subscriber<D extends Definition = Definition> = (event: Payload<D>) => Effect.Effect<void>
export type BatchSubscriber = (events: readonly Payload[]) => Effect.Effect<void>
export type Unsubscribe = Effect.Effect<void>
export type BatchProjector = {
  readonly accepts: (events: readonly Payload[]) => boolean
  readonly project: BatchSubscriber
}

export const latestSequence = Effect.fn("EventV2.latestSequence")(function* (
  db: Database.Interface["db"],
  aggregateID: string,
) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})

export type SerializedEvent = {
  readonly id: ID
  readonly type: string
  readonly seq: number
  readonly aggregateID: string
  readonly data: Record<string, unknown>
}

export class InvalidDurableEventError extends Schema.TaggedErrorClass<InvalidDurableEventError>()(
  "EventV2.InvalidDurableEvent",
  {
    type: Schema.String,
    message: Schema.String,
  },
) {}

const decodeSerializedEvent = (event: SerializedEvent): Payload => {
  const definition = Durable.get(event.type)
  if (!definition?.durable) {
    throw new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` })
  }
  return {
    id: event.id,
    type: definition.type,
    durable: { aggregateID: event.aggregateID, seq: event.seq, version: definition.durable.version },
    data: Schema.decodeUnknownSync(definition.data)(event.data),
  }
}

export const readAggregate = Effect.fn("EventV2.readAggregate")(function* <A>(
  db: Database.Interface["db"],
  input: {
    readonly aggregateID: string
    readonly after?: number
    readonly limit: number
    readonly manifest: {
      readonly definitions: ReadonlyMap<string, Definition>
      readonly schema: Schema.Decoder<A, never>
    }
  },
) {
  const after = input.after ?? -1
  const rows = yield* db
    .select()
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, input.aggregateID),
        gt(EventTable.seq, after),
        inArray(EventTable.type, Array.from(input.manifest.definitions.keys())),
      ),
    )
    .orderBy(asc(EventTable.seq))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  const page = rows.slice(0, input.limit)
  const decode = Schema.decodeUnknownSync(input.manifest.schema)
  const events = page.map((event) =>
    decode({
      id: event.id,
      type: input.manifest.definitions.get(event.type)?.type ?? event.type,
      durable: {
        aggregateID: event.aggregate_id,
        seq: event.seq,
        version: input.manifest.definitions.get(event.type)?.durable?.version,
      },
      data: event.data,
    }),
  )
  return {
    events,
    hasMore: rows.length > input.limit,
  }
})

export class SubscriberOverflowError extends Schema.TaggedErrorClass<SubscriberOverflowError>()(
  "EventV2.SubscriberOverflow",
  { capacity: Schema.Int },
) {}

export const define = Event.define
export const versionedType = Event.versionedType

export interface PublishOptions {
  readonly id?: ID
  readonly metadata?: Record<string, unknown>
  readonly location?: Location.Ref
  /** Local operational projection committed atomically with a new durable event. Not replayed or serialized. */
  readonly commit?: (seq: number) => Effect.Effect<void>
}

export type PublishItem = {
  readonly definition: Definition
  readonly data: unknown
  readonly options?: PublishOptions
}

export type PublishBatchOptions = {
  readonly projector?: string
}

export function publishItem<D extends Definition>(definition: D, data: Data<D>, options?: PublishOptions): PublishItem {
  return { definition, data, options }
}

export interface Interface {
  readonly publish: <D extends Definition>(
    definition: D,
    data: Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<D>>
  readonly publishBatch: (
    items: readonly PublishItem[],
    options?: PublishBatchOptions,
  ) => Effect.Effect<readonly Payload[]>
  readonly subscribe: <D extends Definition>(definition: D) => Stream.Stream<Payload<D>>
  readonly all: () => Stream.Stream<Payload>
  readonly durable: (input: { readonly aggregateID: string; readonly after?: number }) => Stream.Stream<Payload>
  /** @deprecated Use `all()` and consume the returned stream. */
  readonly listen: (listener: Subscriber) => Effect.Effect<Unsubscribe>
  readonly project: <D extends Definition>(definition: D, projector: Subscriber<D>) => Effect.Effect<void>
  readonly projectBatch: (
    id: string,
    definitions: readonly Definition[],
    projector: BatchProjector,
  ) => Effect.Effect<void>
  readonly replay: (
    event: SerializedEvent,
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<void>
  readonly replayAll: (
    events: SerializedEvent[],
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<string | undefined>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Event") {}

export const allBounded = (events: Interface, capacity: number) =>
  Effect.gen(function* () {
    const queue = yield* Queue.dropping<Payload, SubscriberOverflowError>(capacity)
    const unsubscribe = yield* events.listen((event) =>
      Queue.offer(queue, event).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Effect.void : Queue.fail(queue, new SubscriberOverflowError({ capacity })).pipe(Effect.asVoid),
        ),
      ),
    )
    yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid))
    return Stream.fromQueue(queue)
  })

export interface LayerOptions {
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const pubsub = {
        all: yield* PubSub.unbounded<Payload>(),
        durable: new Map<string, Set<PubSub.PubSub<void>>>(),
        typed: new Map<string, PubSub.PubSub<Payload>>(),
      }
      const projectors = new Map<string, Subscriber[]>()
      const batchProjectors = new Array<{
        readonly id: string
        readonly projections: ReadonlyMap<string, Subscriber>
        readonly projector: BatchProjector
      }>()
      // TODO: Bind durable projectors to exact type+version before supporting incompatible historical payloads.
      const listeners = new Array<Subscriber>()
      const { db } = yield* Database.Service

      type PreparedPublish = {
        readonly definition: Definition
        readonly version: number
        readonly event: Payload
        readonly encoded: Record<string, unknown>
        readonly aggregateID: string
        readonly commit?: PublishOptions["commit"]
      }

      const getOrCreate = (definition: Definition) =>
        Effect.gen(function* () {
          const existing = pubsub.typed.get(definition.type)
          if (existing) return existing
          const created = yield* PubSub.unbounded<Payload>()
          pubsub.typed.set(definition.type, created)
          return created
        })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* PubSub.shutdown(pubsub.all)
          yield* Effect.forEach(
            pubsub.durable.values(),
            (pubsubs) => Effect.forEach(pubsubs, PubSub.shutdown, { discard: true }),
            { discard: true },
          )
          yield* Effect.forEach(pubsub.typed.values(), PubSub.shutdown, { discard: true })
        }),
      )

      function commitDurableEvent(
        definition: Definition,
        event: Payload,
        input?: {
          readonly seq: number
          readonly aggregateID: string
          readonly ownerID?: string
          readonly strictOwner?: boolean
        },
        commit?: (seq: number) => Effect.Effect<void>,
      ) {
        return Effect.gen(function* () {
          const durable = definition?.durable
          if (durable) {
            const aggregateID = (event.data as Record<string, unknown>)[durable.aggregate]
            if (typeof aggregateID !== "string") {
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Expected string aggregate field ${durable.aggregate}`,
                }),
              )
            } else {
              if (input && input.aggregateID !== aggregateID) {
                yield* Effect.die(
                  new InvalidDurableEventError({
                    type: event.type,
                    message: `Aggregate mismatch: expected ${input.aggregateID}, got ${aggregateID}`,
                  }),
                )
              }
              const list = projectors.get(event.type) ?? []
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const committed = yield* db
                    .transaction(
                      () =>
                        Effect.gen(function* () {
                          const row = yield* db
                            .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
                            .from(EventSequenceTable)
                            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                            .get()
                            .pipe(Effect.orDie)
                          const latest = row?.seq ?? -1
                          const encoded = Schema.encodeUnknownSync(definition.data)(event.data) as Record<
                            string,
                            unknown
                          >
                          if (input?.strictOwner && row?.ownerID && row.ownerID !== input.ownerID) {
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.ownerID ?? "none"}`,
                              }),
                            )
                          }
                          if (input && input.seq <= latest) {
                            const stored = yield* db
                              .select()
                              .from(EventTable)
                              .where(and(eq(EventTable.aggregate_id, aggregateID), eq(EventTable.seq, input.seq)))
                              .get()
                              .pipe(Effect.orDie)
                            if (
                              stored?.id === event.id &&
                              stored.type === versionedType(definition.type, durable.version) &&
                              isDeepStrictEqual(stored.data, encoded)
                            ) {
                              if (input.ownerID && row?.ownerID == null) {
                                yield* db
                                  .update(EventSequenceTable)
                                  .set({ owner_id: input.ownerID })
                                  .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                                  .run()
                                  .pipe(Effect.orDie)
                              }
                              return
                            }
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Replay diverged at aggregate ${aggregateID} sequence ${input.seq}`,
                              }),
                            )
                          }
                          if (input && row?.ownerID && row.ownerID !== input.ownerID) {
                            return
                          }
                          const seq = input?.seq ?? latest + 1
                          if (input && seq !== latest + 1) {
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Sequence mismatch for aggregate ${aggregateID}: expected ${latest + 1}, got ${seq}`,
                              }),
                            )
                          }
                          const stored = yield* db
                            .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
                            .from(EventTable)
                            .where(eq(EventTable.id, event.id))
                            .get()
                            .pipe(Effect.orDie)
                          if (stored)
                            yield* Effect.die(
                              new InvalidDurableEventError({
                                type: event.type,
                                message: `Event ${event.id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
                              }),
                            )
                          const committed = {
                            ...event,
                            durable: { aggregateID, seq, version: durable.version },
                          } as Payload
                          for (const projector of list) {
                            yield* projector(committed)
                          }
                          if (commit) yield* commit(seq)
                          yield* db
                            .insert(EventSequenceTable)
                            .values([{ aggregate_id: aggregateID, seq, owner_id: input?.ownerID }])
                            .onConflictDoUpdate({
                              target: EventSequenceTable.aggregate_id,
                              set: {
                                seq,
                                ...(input?.ownerID && row?.ownerID == null ? { owner_id: input.ownerID } : {}),
                              },
                            })
                            .run()
                            .pipe(Effect.orDie)
                          yield* db
                            .insert(EventTable)
                            .values([
                              {
                                id: event.id,
                                aggregate_id: aggregateID,
                                seq,
                                type: versionedType(definition.type, durable.version),
                                data: encoded,
                              },
                            ])
                            .run()
                            .pipe(Effect.orDie)
                          return { aggregateID, seq }
                        }),
                      { behavior: "immediate" },
                    )
                    .pipe(Effect.orDie)
                  if (committed) {
                    yield* Effect.forEach(
                      pubsub.durable.get(committed.aggregateID) ?? [],
                      (wake) => PubSub.publish(wake, undefined),
                      { discard: true },
                    )
                  }
                  return committed
                }),
              )
            }
          }
        })
      }

      function publishLiveEvent<D extends Definition>(definition: D, event: Payload<D>, commit?: PublishOptions["commit"]) {
        return Effect.gen(function* () {
          if (commit)
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: "Local commit hooks require a durable event",
              }),
            )
          yield* notify(event as Payload, false)
          return event
        })
      }

      function commitDurableBatch(items: readonly PreparedPublish[], batchProjectorID?: string) {
        return Effect.uninterruptible(
          Effect.gen(function* () {
            const first = items[0]
            if (!first)
              return {
                events: [],
                transactionMs: 0,
                projector: undefined,
              }
            const aggregateID = first.aggregateID
            const transactionStarted = performance.now()
            const committed = yield* db
              .transaction(
                () =>
                  Effect.gen(function* () {
                    const row = yield* db
                      .select({ seq: EventSequenceTable.seq })
                      .from(EventSequenceTable)
                      .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                      .get()
                      .pipe(Effect.orDie)
                    const start = (row?.seq ?? -1) + 1
                    const stored = (
                      yield* Effect.forEach(
                        Array.from({ length: Math.ceil(items.length / eventIDLookupChunkSize) }, (_, index) =>
                          items
                            .slice(index * eventIDLookupChunkSize, (index + 1) * eventIDLookupChunkSize)
                            .map((item) => item.event.id),
                        ),
                        (ids) =>
                          db
                            .select({ id: EventTable.id, aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
                            .from(EventTable)
                            .where(inArray(EventTable.id, ids))
                            .all()
                            .pipe(Effect.orDie),
                      )
                    ).flat()
                    if (stored[0]) {
                      yield* Effect.die(
                        new InvalidDurableEventError({
                          type: items.find((item) => item.event.id === stored[0]?.id)?.event.type ?? "unknown",
                          message: `Event ${stored[0].id} already exists at aggregate ${stored[0].aggregateID} sequence ${stored[0].seq}`,
                        }),
                      )
                    }
                    const result = new Array<Payload>()
                    const rows = new Array<typeof EventTable.$inferInsert>()
                    for (const [index, item] of items.entries()) {
                      const seq = start + index
                      const event = {
                        ...item.event,
                        durable: {
                          aggregateID,
                          seq,
                          version: item.version,
                        },
                      } as Payload
                      rows.push({
                        id: event.id,
                        aggregate_id: aggregateID,
                        seq,
                        type: versionedType(item.definition.type, item.version),
                        data: item.encoded,
                      })
                      result.push(event)
                    }
                    const batchProjector = items.some((item) => item.commit)
                      ? undefined
                      : batchProjectors.find(
                          (candidate) =>
                            candidate.id === batchProjectorID &&
                            result.every((event) => candidate.projections.has(event.type)) &&
                            candidate.projector.accepts(result) &&
                            Array.from(candidate.projections).every(([type, projector]) => {
                              const registered = projectors.get(type) ?? []
                              return registered.length === 1 && registered[0] === projector
                            }),
                        )
                    yield* Effect.gen(function* () {
                      if (batchProjector) return yield* batchProjector.projector.project(result)
                      for (const [index, event] of result.entries()) {
                        for (const projector of projectors.get(event.type) ?? []) {
                          yield* projector(event)
                        }
                        const commit = items[index]?.commit
                        if (commit) yield* commit(event.durable?.seq ?? start + index)
                      }
                    })
                    yield* db
                      .insert(EventSequenceTable)
                      .values([{ aggregate_id: aggregateID, seq: start + items.length - 1 }])
                      .onConflictDoUpdate({
                        target: EventSequenceTable.aggregate_id,
                        set: { seq: start + items.length - 1 },
                      })
                      .run()
                      .pipe(Effect.orDie)
                    yield* Effect.forEach(
                      Array.from({ length: Math.ceil(rows.length / 100) }, (_, index) =>
                        rows.slice(index * 100, (index + 1) * 100),
                      ),
                      (chunk) => db.insert(EventTable).values(chunk).run().pipe(Effect.orDie),
                      { discard: true },
                    )
                    return {
                      events: result,
                      projector: batchProjector?.id,
                    }
                  }),
                { behavior: "immediate" },
              )
              .pipe(Effect.orDie)
            const transactionCompleted = performance.now()
            yield* Effect.forEach(
              pubsub.durable.get(aggregateID) ?? [],
              (wake) => PubSub.publish(wake, undefined),
              { discard: true },
            )
            return {
              events: committed.events,
              transactionMs: transactionCompleted - transactionStarted,
              projector: committed.projector,
            }
          }),
        )
      }

      const observe = (event: Payload, observer: (event: Payload) => Effect.Effect<void>) =>
        Effect.suspend(() => observer(event)).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logError("Event listener failed", { eventID: event.id, eventType: event.type, cause }),
          ),
        )

      function notify(event: Payload, isolateListeners: boolean) {
        return Effect.gen(function* () {
          yield* Effect.forEach(
            listeners,
            (listener) => (isolateListeners ? observe(event, listener) : listener(event)),
            { discard: true },
          )
          const typed = pubsub.typed.get(event.type)
          if (typed) yield* PubSub.publish(typed, event)
          yield* PubSub.publish(pubsub.all, event)
        })
      }

      function publish<D extends Definition>(definition: D, data: Data<D>, options?: PublishOptions) {
        return Effect.gen(function* () {
          const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
          const location =
            options?.location ??
            (serviceLocation
              ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
              : undefined)
          const event = {
            id: options?.id ?? ID.create(),
            ...(options?.metadata ? { metadata: options.metadata } : {}),
            type: definition.type,
            ...(location ? { location } : {}),
            data,
          } as Payload<D>
          if (!definition.durable) return yield* publishLiveEvent(definition, event, options?.commit)
          return (yield* publishPreparedBatch([
            {
              definition,
              version: definition.durable.version,
              event,
              encoded: Schema.encodeUnknownSync(definition.data)(data) as Record<string, unknown>,
              aggregateID: requireAggregate(definition, event),
              commit: options?.commit,
            },
          ]))[0] as Payload<D>
        })
      }

      function requireAggregate(definition: Definition, event: Payload) {
        const durable = definition.durable
        if (!durable) {
          throw new InvalidDurableEventError({
            type: event.type,
            message: "Batch publish requires durable events",
          })
        }
        const aggregateID = (event.data as Record<string, unknown>)[durable.aggregate]
        if (typeof aggregateID !== "string") {
          throw new InvalidDurableEventError({
            type: event.type,
            message: `Expected string aggregate field ${durable.aggregate}`,
          })
        }
        return aggregateID
      }

      function publishPreparedBatch(
        items: readonly PreparedPublish[],
        batchProjectorID?: string,
        started?: number,
      ) {
        return Effect.gen(function* () {
          if (items.length === 0) return []
          const first = items[0]
          if (!first) return []
          const aggregateID = first.aggregateID
          if (items.some((item) => item.aggregateID !== aggregateID)) {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: first.event.type,
                message: "Batch events must belong to the same aggregate",
              }),
            )
          }
          const ids = new Set<ID>()
          for (const item of items) {
            if (ids.has(item.event.id)) {
              return yield* Effect.die(
                new InvalidDurableEventError({
                  type: item.event.type,
                  message: `Duplicate event ID ${item.event.id} in batch`,
                }),
              )
            }
            ids.add(item.event.id)
          }
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const committed = yield* commitDurableBatch(items, batchProjectorID)
              const notifyStarted = performance.now()
              for (const event of committed.events) {
                yield* notify(event, true)
              }
              const completed = performance.now()
              if (started !== undefined) {
                yield* Effect.logInfo("event batch published", {
                  aggregateID,
                  events: items.length,
                  transactionMs: Math.round(committed.transactionMs),
                  notifyMs: Math.round(completed - notifyStarted),
                  totalMs: Math.round(completed - started),
                  ...(committed.projector ? { projector: committed.projector } : {}),
                })
              }
              return committed.events
            }),
          )
        })
      }

      function publishBatch(items: readonly PublishItem[], options?: PublishBatchOptions) {
        return Effect.gen(function* () {
          if (items.length === 0) return []
          const started = performance.now()
          const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
          const prepared = items.map((item) => {
            const location =
              item.options?.location ??
              (serviceLocation
                ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
                : undefined)
            const event = {
              id: item.options?.id ?? ID.create(),
              ...(item.options?.metadata ? { metadata: item.options.metadata } : {}),
              type: item.definition.type,
              ...(location ? { location } : {}),
              data: item.data,
            } as Payload
            return {
              definition: item.definition,
              version: item.definition.durable?.version ?? 0,
              event,
              encoded: Schema.encodeUnknownSync(item.definition.data)(item.data) as Record<string, unknown>,
              aggregateID: requireAggregate(item.definition, event),
              commit: item.options?.commit,
            }
          })
          return yield* publishPreparedBatch(prepared, options?.projector, started)
        })
      }

      function replay(
        event: SerializedEvent,
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const definition = Durable.get(event.type)
          if (!definition?.durable) {
            yield* Effect.die(
              new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` }),
            )
          } else {
            const payload = {
              id: event.id,
              type: definition.type,
              data: Schema.decodeUnknownSync(definition.data)(event.data),
            } as Payload
            const committed = yield* commitDurableEvent(definition, payload, {
              seq: event.seq,
              aggregateID: event.aggregateID,
              ownerID: options?.ownerID,
              strictOwner: options?.strictOwner,
            })
            if (committed && options?.publish) {
              yield* notify(
                {
                  ...payload,
                  durable: {
                    aggregateID: committed.aggregateID,
                    seq: committed.seq,
                    version: definition.durable.version,
                  },
                },
                true,
              )
            }
          }
        })
      }

      function replayAll(
        events: SerializedEvent[],
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const source = events[0]?.aggregateID
          if (!source) return undefined
          if (events.some((event) => event.aggregateID !== source)) {
            yield* Effect.die(
              new InvalidDurableEventError({
                type: events[0]?.type ?? "unknown",
                message: "Replay events must belong to the same aggregate",
              }),
            )
          }
          const start = events[0]?.seq ?? 0
          for (const [index, event] of events.entries()) {
            const seq = start + index
            if (event.seq !== seq) {
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Replay sequence mismatch at index ${index}: expected ${seq}, got ${event.seq}`,
                }),
              )
            }
          }
          for (const event of events) {
            yield* replay(event, options)
          }
          return source
        })
      }

      function remove(aggregateID: string) {
        return db
          .transaction(() =>
            Effect.gen(function* () {
              yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
              yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
            }),
          )
          .pipe(Effect.orDie)
      }

      function claim(aggregateID: string, ownerID: string) {
        return db
          .update(EventSequenceTable)
          .set({ owner_id: ownerID })
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .run()
          .pipe(Effect.orDie)
      }

      const subscribe = <D extends Definition>(definition: D): Stream.Stream<Payload<D>> =>
        Stream.unwrap(getOrCreate(definition).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub)))).pipe(
          Stream.map((event) => event as Payload<D>),
        )

      const streamAll = (): Stream.Stream<Payload> => Stream.fromPubSub(pubsub.all)

      const readAfter = (aggregateID: string, after: number) =>
        (options?.beforeAggregateRead?.(aggregateID) ?? Effect.void).pipe(
          Effect.andThen(
            db
              .select()
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, aggregateID), gt(EventTable.seq, after)))
              .orderBy(asc(EventTable.seq))
              .all(),
          ),
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((event) =>
              decodeSerializedEvent({
                id: event.id,
                aggregateID: event.aggregate_id,
                seq: event.seq,
                type: event.type,
                data: event.data,
              }),
            ),
          ),
        )

      const subscribeDurable = (aggregateID: string) =>
        Effect.gen(function* () {
          const wake = yield* PubSub.sliding<void>(1)
          const subscription = yield* PubSub.subscribe(wake)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const wakes = pubsub.durable.get(aggregateID) ?? new Set()
              wakes.add(wake)
              pubsub.durable.set(aggregateID, wakes)
            }),
            () =>
              Effect.sync(() => {
                const wakes = pubsub.durable.get(aggregateID)
                wakes?.delete(wake)
                if (wakes?.size === 0) pubsub.durable.delete(aggregateID)
              }).pipe(Effect.andThen(PubSub.shutdown(wake))),
          )
          return subscription
        })

      const durable = (input: { readonly aggregateID: string; readonly after?: number }): Stream.Stream<Payload> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const wakes = yield* subscribeDurable(input.aggregateID)
            let sequence = input.after ?? -1
            const read = Effect.suspend(() => readAfter(input.aggregateID, sequence)).pipe(
              Effect.tap((events) =>
                Effect.sync(() => {
                  sequence = events.at(-1)?.durable?.seq ?? sequence
                }),
              ),
            )
            const historical = yield* read
            const live = Stream.fromSubscription(wakes).pipe(
              Stream.mapEffect(() => read),
              Stream.flattenIterable,
            )
            return Stream.concat(Stream.fromIterable(historical), live)
          }),
        )

      const listen = (listener: Subscriber): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          listeners.push(listener)
          return Effect.sync(() => {
            const index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          })
        })

      const project = <D extends Definition>(definition: D, projector: Subscriber<D>): Effect.Effect<void> =>
        Effect.sync(() => {
          const list = projectors.get(definition.type) ?? []
          const registered = (event: Payload) => projector(event as Payload<D>)
          list.push(registered)
          projectors.set(definition.type, list)
        })

      const projectBatch = (
        id: string,
        definitions: readonly Definition[],
        projector: BatchProjector,
      ): Effect.Effect<void> =>
        Effect.sync(() => {
          const entries = new Map<string, Subscriber>()
          for (const definition of definitions) {
            if (entries.has(definition.type)) throw new Error(`Duplicate batch projector type ${definition.type}`)
            const registered = projectors.get(definition.type) ?? []
            if (registered.length !== 1) throw new Error(`Batch projector ${id} requires one projector for ${definition.type}`)
            entries.set(definition.type, registered[0]!)
          }
          if (entries.size === 0) throw new Error("Batch projector requires at least one projection")
          if (batchProjectors.some((candidate) => candidate.id === id)) throw new Error(`Duplicate batch projector ${id}`)
          batchProjectors.push({ id, projections: entries, projector })
        })

      return Service.of({
        publish,
        publishBatch,
        subscribe,
        all: streamAll,
        durable,
        listen,
        project,
        projectBatch,
        replay,
        replayAll,
        remove,
        claim,
      })
    }),
  )

const layer = layerWith()
export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Database.node] })
