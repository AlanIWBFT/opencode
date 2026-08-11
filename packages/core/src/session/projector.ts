export * as SessionProjector from "./projector"

import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { WorkspaceV2 } from "../workspace"
import { MessageTable, PartTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import type { DeepMutable } from "../schema"
import { LocalMessageOrder } from "../database/local-message-order"

type DatabaseService = Database.Interface["db"]
const projectedSequences = new WeakMap<object, number>()

export function projectedSequence(event: { data: unknown }) {
  if (typeof event.data !== "object" || event.data === null) throw new Error("Projected event data is not an object")
  const seq = projectedSequences.get(event.data)
  if (seq === undefined) throw new Error("Projected event sequence is missing")
  return seq
}

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], tokens: value.tokens as Usage["tokens"] }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessage.ID.make(info.revert.messageID) } : null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

function chunks<A>(items: readonly A[], size = 100) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
}

function projectForkBatch(db: DatabaseService, events: readonly EventV2.Payload[]) {
  return Effect.gen(function* () {
    const first = events[0]
    const sessionID = first?.type === SessionV1.Event.MessageUpdated.type
      ? (first.data as typeof SessionV1.Event.MessageUpdated.data.Type).sessionID
      : first?.type === SessionV1.Event.PartUpdated.type
        ? (first.data as typeof SessionV1.Event.PartUpdated.data.Type).sessionID
        : undefined
    if (!sessionID) return yield* Effect.die("Fork batch is missing a Session ID")
    const messageEvents = events.filter(
      (event): event is EventV2.Payload<typeof SessionV1.Event.MessageUpdated> =>
        event.type === SessionV1.Event.MessageUpdated.type,
    )
    const partEvents = events.filter(
      (event): event is EventV2.Payload<typeof SessionV1.Event.PartUpdated> =>
        event.type === SessionV1.Event.PartUpdated.type,
    )
    const messageIDs = new Set<SessionV1.MessageID>()
    const partIDs = new Set<SessionV1.PartID>()
    const roles = new Map<SessionV1.MessageID, SessionV1.Info["role"]>()
    const seenMessages = new Set<SessionV1.MessageID>()
    for (const event of events) {
      if (event.durable?.aggregateID !== sessionID)
        return yield* Effect.die(`Fork event aggregate does not match Session ${sessionID}`)
      if (event.type === SessionV1.Event.MessageUpdated.type) {
        const data = event.data as typeof SessionV1.Event.MessageUpdated.data.Type
        if (data.sessionID !== sessionID || data.info.sessionID !== sessionID)
          return yield* Effect.die(`Fork Message ${data.info.id} belongs to another Session`)
        if (messageIDs.has(data.info.id)) return yield* Effect.die(`Duplicate fork Message ${data.info.id}`)
        if (data.info.role === "assistant" && roles.get(data.info.parentID) !== "user")
          return yield* Effect.die(`Assistant Message ${data.info.id} has invalid parent ${data.info.parentID}`)
        messageIDs.add(data.info.id)
        roles.set(data.info.id, data.info.role)
        seenMessages.add(data.info.id)
        continue
      }
      const data = event.data as typeof SessionV1.Event.PartUpdated.data.Type
      if (data.sessionID !== sessionID || data.part.sessionID !== sessionID)
        return yield* Effect.die(`Fork Part ${data.part.id} belongs to another Session`)
      if (!seenMessages.has(data.part.messageID))
        return yield* Effect.die(`Part ${data.part.id} has invalid Message ${data.part.messageID} in Session ${sessionID}`)
      if (partIDs.has(data.part.id)) return yield* Effect.die(`Duplicate fork Part ${data.part.id}`)
      partIDs.add(data.part.id)
    }

    const existingMessages = (
      yield* Effect.forEach(chunks(Array.from(messageIDs), 500), (ids) =>
        db
          .select({ id: MessageTable.id, sessionID: MessageTable.session_id })
          .from(MessageTable)
          .where(inArray(MessageTable.id, ids))
          .all()
          .pipe(Effect.orDie),
      )
    ).flat()
    if (existingMessages[0])
      return yield* Effect.die(
        `Message ${existingMessages[0].id} already belongs to Session ${existingMessages[0].sessionID}`,
      )
    const existingParts = (
      yield* Effect.forEach(chunks(Array.from(partIDs), 500), (ids) =>
        db
          .select({ id: PartTable.id, messageID: PartTable.message_id, sessionID: PartTable.session_id })
          .from(PartTable)
          .where(inArray(PartTable.id, ids))
          .all()
          .pipe(Effect.orDie),
      )
    ).flat()
    if (existingParts[0])
      return yield* Effect.die(
        `Part ${existingParts[0].id} already belongs to Message ${existingParts[0].messageID} in Session ${existingParts[0].sessionID}`,
      )
    const existingMessageOrder = (
      yield* Effect.forEach(chunks(Array.from(messageIDs), 500), (ids) =>
        db
          .select({ id: LocalMessageOrder.MessageOrderTable.message_id })
          .from(LocalMessageOrder.MessageOrderTable)
          .where(inArray(LocalMessageOrder.MessageOrderTable.message_id, ids))
          .all()
          .pipe(Effect.orDie),
      )
    ).flat()
    if (existingMessageOrder[0]) return yield* Effect.die(`Message ${existingMessageOrder[0].id} has stale local order`)
    const existingPartOrder = (
      yield* Effect.forEach(chunks(Array.from(partIDs), 500), (ids) =>
        db
          .select({ id: LocalMessageOrder.PartOrderTable.part_id })
          .from(LocalMessageOrder.PartOrderTable)
          .where(inArray(LocalMessageOrder.PartOrderTable.part_id, ids))
          .all()
          .pipe(Effect.orDie),
      )
    ).flat()
    if (existingPartOrder[0]) return yield* Effect.die(`Part ${existingPartOrder[0].id} has stale local order`)

    const reserved = yield* LocalMessageOrder.reserveSequences(db, sessionID, {
      messages: messageEvents.length,
      parts: partEvents.length,
    }).pipe(Effect.orDie)
    const messageRows = messageEvents.map((event, index) => {
      const info = event.data.info
      const seq = reserved.message + index
      projectedSequences.set(event.data, seq)
      return { id: info.id, session_id: sessionID, time_created: info.time.created, data: messageData(info) }
    })
    const messageOrderRows = messageEvents.map((event, index) => ({
      message_id: event.data.info.id,
      session_id: sessionID,
      seq: reserved.message + index,
    }))
    const partRows = partEvents.map((event, index) => {
      const part = event.data.part
      const seq = reserved.part + index
      projectedSequences.set(event.data, seq)
      return {
        id: part.id,
        message_id: part.messageID,
        session_id: sessionID,
        time_created: event.data.time,
        data: partData(part),
      }
    })
    const partOrderRows = partEvents.map((event, index) => ({
      part_id: event.data.part.id,
      message_id: event.data.part.messageID,
      session_id: sessionID,
      seq: reserved.part + index,
    }))
    yield* Effect.forEach(chunks(messageRows), (rows) => db.insert(MessageTable).values(rows).run().pipe(Effect.orDie), {
      discard: true,
    })
    yield* Effect.forEach(
      chunks(messageOrderRows),
      (rows) => db.insert(LocalMessageOrder.MessageOrderTable).values(rows).run().pipe(Effect.orDie),
      { discard: true },
    )
    yield* Effect.forEach(chunks(partRows), (rows) => db.insert(PartTable).values(rows).run().pipe(Effect.orDie), {
      discard: true,
    })
    yield* Effect.forEach(
      chunks(partOrderRows),
      (rows) => db.insert(LocalMessageOrder.PartOrderTable).values(rows).run().pipe(Effect.orDie),
      { discard: true },
    )
    const total = partEvents.reduce(
      (sum, event) => {
        const value = usage(event.data.part)
        if (!value) return sum
        sum.cost += value.cost
        sum.input += value.tokens.input
        sum.output += value.tokens.output
        sum.reasoning += value.tokens.reasoning
        sum.read += value.tokens.cache.read
        sum.write += value.tokens.cache.write
        return sum
      },
      { cost: 0, input: 0, output: 0, reasoning: 0, read: 0, write: 0 },
    )
    if (total.cost || total.input || total.output || total.reasoning || total.read || total.write) {
      yield* db
        .update(SessionTable)
        .set({
          cost: sql`${SessionTable.cost} + ${total.cost}`,
          tokens_input: sql`${SessionTable.tokens_input} + ${total.input}`,
          tokens_output: sql`${SessionTable.tokens_output} + ${total.output}`,
          tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${total.reasoning}`,
          tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${total.read}`,
          tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${total.write}`,
          time_updated: sql`${SessionTable.time_updated}`,
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
    }
  })
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) =>
      db
        .update(SessionTable)
        .set(sessionRow(event.data.info))
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      Effect.gen(function* () {
        yield* db
          .delete(LocalMessageOrder.PartOrderTable)
          .where(eq(LocalMessageOrder.PartOrderTable.session_id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(LocalMessageOrder.MessageOrderTable)
          .where(eq(LocalMessageOrder.MessageOrderTable.session_id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(LocalMessageOrder.SessionOrderTable)
          .where(eq(LocalMessageOrder.SessionOrderTable.session_id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        if (event.data.info.role === "assistant") {
          const parent = yield* db
            .select({ sessionID: MessageTable.session_id, data: MessageTable.data, seq: LocalMessageOrder.MessageOrderTable.seq })
            .from(MessageTable)
            .leftJoin(
              LocalMessageOrder.MessageOrderTable,
              eq(LocalMessageOrder.MessageOrderTable.message_id, MessageTable.id),
            )
            .where(eq(MessageTable.id, event.data.info.parentID))
            .get()
            .pipe(Effect.orDie)
          if (!parent || parent.sessionID !== sessionID || parent.data.role !== "user" || parent.seq === null)
            return yield* Effect.die(`Assistant Message ${id} has invalid parent ${event.data.info.parentID}`)
        }
        const order = yield* db
          .select()
          .from(LocalMessageOrder.MessageOrderTable)
          .where(eq(LocalMessageOrder.MessageOrderTable.message_id, id))
          .get()
          .pipe(Effect.orDie)
        const existing = yield* db
          .select({ sessionID: MessageTable.session_id, seq: LocalMessageOrder.MessageOrderTable.seq })
          .from(MessageTable)
          .leftJoin(
            LocalMessageOrder.MessageOrderTable,
            eq(LocalMessageOrder.MessageOrderTable.message_id, MessageTable.id),
          )
          .where(eq(MessageTable.id, id))
          .get()
          .pipe(Effect.orDie)
        if (existing && existing.sessionID !== sessionID)
          return yield* Effect.die(`Message ${id} already belongs to Session ${existing.sessionID}`)
        if (existing && existing.seq === null) return yield* Effect.die(`Message ${id} is missing local order`)
        if (!existing && order) return yield* Effect.die(`Message ${id} has stale local order`)
        const seq = existing?.seq ?? (yield* LocalMessageOrder.nextMessageSequence(db, sessionID).pipe(Effect.orDie))
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(LocalMessageOrder.MessageOrderTable)
          .values({ message_id: id, session_id: sessionID, seq })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        projectedSequences.set(event.data, seq)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const child = yield* db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(
            and(
              eq(MessageTable.session_id, event.data.sessionID),
              sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
              sql`json_extract(${MessageTable.data}, '$.parentID') = ${event.data.messageID}`,
            ),
          )
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (child)
          return yield* Effect.die(`Message ${event.data.messageID} still has assistant child ${child.id}`)
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.message_id, event.data.messageID))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          if (row.session_id !== event.data.sessionID)
            return yield* Effect.die(`Part ${row.id} belongs to Session ${row.session_id}`)
          const previous = usage(row.data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        yield* db
          .delete(LocalMessageOrder.PartOrderTable)
          .where(
            and(
              eq(LocalMessageOrder.PartOrderTable.message_id, event.data.messageID),
              eq(LocalMessageOrder.PartOrderTable.session_id, event.data.sessionID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(LocalMessageOrder.MessageOrderTable)
          .where(
            and(
              eq(LocalMessageOrder.MessageOrderTable.message_id, event.data.messageID),
              eq(LocalMessageOrder.MessageOrderTable.session_id, event.data.sessionID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (row && row.message_id !== event.data.messageID)
          return yield* Effect.die(`Part ${event.data.partID} belongs to Message ${row.message_id}`)
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(LocalMessageOrder.PartOrderTable)
          .where(
            and(
              eq(LocalMessageOrder.PartOrderTable.part_id, event.data.partID),
              eq(LocalMessageOrder.PartOrderTable.session_id, event.data.sessionID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const message = yield* db
          .select({ sessionID: MessageTable.session_id, seq: LocalMessageOrder.MessageOrderTable.seq })
          .from(MessageTable)
          .leftJoin(
            LocalMessageOrder.MessageOrderTable,
            eq(LocalMessageOrder.MessageOrderTable.message_id, MessageTable.id),
          )
          .where(eq(MessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        if (!message || message.sessionID !== sessionID || message.seq === null)
          return yield* Effect.die(`Part ${id} has invalid Message ${messageID} in Session ${sessionID}`)
        const order = yield* db
          .select()
          .from(LocalMessageOrder.PartOrderTable)
          .where(eq(LocalMessageOrder.PartOrderTable.part_id, id))
          .get()
          .pipe(Effect.orDie)
        const row = yield* db
          .select({ part: PartTable, seq: LocalMessageOrder.PartOrderTable.seq })
          .from(PartTable)
          .leftJoin(LocalMessageOrder.PartOrderTable, eq(LocalMessageOrder.PartOrderTable.part_id, PartTable.id))
          .where(eq(PartTable.id, id))
          .get()
          .pipe(Effect.orDie)
        if (row && (row.part.session_id !== sessionID || row.part.message_id !== messageID))
          return yield* Effect.die(
            `Part ${id} already belongs to Message ${row.part.message_id} in Session ${row.part.session_id}`,
          )
        if (row && row.seq === null) return yield* Effect.die(`Part ${id} is missing local order`)
        if (!row && order) return yield* Effect.die(`Part ${id} has stale local order`)
        const seq = row?.seq ?? (yield* LocalMessageOrder.nextPartSequence(db, sessionID).pipe(Effect.orDie))
        yield* db
          .insert(PartTable)
          .values({
            id,
            message_id: messageID,
            session_id: sessionID,
            time_created: event.data.time,
            data,
          })
          .onConflictDoUpdate({ target: PartTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(LocalMessageOrder.PartOrderTable)
          .values({ part_id: id, message_id: messageID, session_id: sessionID, seq })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        projectedSequences.set(event.data, seq)
        const previous = row && usage(row.part.data)
        const next = usage(event.data.part)
        if (previous) yield* applyUsage(db, row.part.session_id, previous, -1)
        if (next) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* events.projectBatch("session.fork", [SessionV1.Event.MessageUpdated, SessionV1.Event.PartUpdated], {
      accepts: (batch) =>
        batch.length > 0 &&
        batch.every(
          (event) =>
            event.type === SessionV1.Event.MessageUpdated.type || event.type === SessionV1.Event.PartUpdated.type,
        ),
      project: (batch) => projectForkBatch(db, batch),
    })
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // yield* events.project(SessionEvent.Retried, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: { ...event.data.revert, files: event.data.revert.files ? [...event.data.revert.files] : undefined },
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.id, event.data.messageID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!boundary) return yield* Effect.die(`Revert boundary message not found: ${event.data.messageID}`)
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, event.data.sessionID),
              or(gt(SessionInputTable.admitted_seq, boundary.seq), gt(SessionInputTable.promoted_seq, boundary.seq)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })
