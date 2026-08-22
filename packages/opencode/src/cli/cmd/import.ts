import type { Session as SDKSession, Message, Part } from "@opencode-ai/sdk/v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { MessageV2 } from "../../session/message-v2"
import { CliError, effectCmd } from "../effect-cmd"
import { Database } from "@opencode-ai/core/database/database"
import {
  LocalMessageOrder,
  MessageOrderTable,
  PartOrderTable,
  SessionOrderTable,
} from "@opencode-ai/core/database/local-message-order"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { ShareNext } from "@/share/share-next"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Schema } from "effect"
import { eq, inArray, sql } from "drizzle-orm"
import type { InstanceContext } from "@/project/instance-context"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

/** Discriminated union returned by the ShareNext API (GET /api/shares/:id/data) */
export type ShareData =
  | { type: "session"; data: SDKSession }
  | { type: "message"; data: Message }
  | { type: "part"; data: Part }
  | { type: "session_diff"; data: unknown }
  | { type: "model"; data: unknown }

/** Extract share ID from a share URL like https://opncd.ai/share/abc123 */
export function parseShareUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/share\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1] : null
}

export function shouldAttachShareAuthHeaders(shareUrl: string, accountBaseUrl: string): boolean {
  try {
    return new URL(shareUrl).origin === new URL(accountBaseUrl).origin
  } catch {
    return false
  }
}

export function formatImportFileError(file: string, error: FSUtil.Error) {
  if (error._tag === "PlatformError") {
    if (error.reason._tag === "NotFound") return `File not found: ${file}`
    if (error.reason._tag === "PermissionDenied") return `Failed to read file: Permission denied`
    return `Failed to read file: ${error.message}`
  }

  const detail = error.cause instanceof Error ? error.cause.message : error.message
  return `Invalid JSON in ${file}: ${detail}`
}

/**
 * Transform ShareNext API response (flat array) into the nested structure for local file storage.
 *
 * The API returns a flat array: [session, message, message, part, part, ...]
 * Local storage expects: { info: session, messages: [{ info: message, parts: [part, ...] }, ...] }
 *
 * This groups parts by their messageID to reconstruct the hierarchy before writing to disk.
 */
export function transformShareData(shareData: ShareData[]): {
  info: SDKSession
  messages: Array<{ info: Message; parts: Part[] }>
} | null {
  const sessionItem = shareData.find((d) => d.type === "session")
  if (!sessionItem) return null

  const messageMap = new Map<string, Message>()
  const partMap = new Map<string, Part[]>()

  for (const item of shareData) {
    if (item.type === "message") {
      messageMap.set(item.data.id, item.data)
    } else if (item.type === "part") {
      if (!partMap.has(item.data.messageID)) {
        partMap.set(item.data.messageID, [])
      }
      partMap.get(item.data.messageID)!.push(item.data)
    }
  }

  if (messageMap.size === 0) return null

  return {
    info: sessionItem.data,
    messages: Array.from(messageMap.values()).map((msg) => ({
      info: msg,
      parts: partMap.get(msg.id) ?? [],
    })),
  }
}

type ExportData = { info: SDKSession; messages: Array<{ info: Message; parts: Part[] }> }

const batch = <T>(items: readonly T[]) => {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += 100) result.push(items.slice(index, index + 100))
  return result
}

export const persistImportedSession = Effect.fn("Cli.import.persist")(function* (
  db: Database.Interface["db"],
  row: typeof SessionTable.$inferInsert,
  messages: ExportData["messages"],
) {
  const preparedMessages: Array<{
    info: SessionV1.Info
    row: typeof MessageTable.$inferInsert
  }> = []
  const preparedParts: Array<{
    info: SessionV1.Part
    row: typeof PartTable.$inferInsert
  }> = []
  const messageIDs = new Set<string>()
  const partIDs = new Set<string>()

  for (const message of messages) {
    const info = decodeMessageInfo(message.info) as SessionV1.Info
    if (info.sessionID !== row.id) {
      return yield* new CliError({ message: `Message ${info.id} belongs to session ${info.sessionID}, not ${row.id}` })
    }
    if (messageIDs.has(info.id)) return yield* new CliError({ message: `Duplicate message ID in import: ${info.id}` })
    messageIDs.add(info.id)

    const { id, sessionID: _, ...data } = info
    preparedMessages.push({
      info,
      row: {
        id,
        session_id: row.id,
        time_created: info.time?.created ?? Date.now(),
        data: data as never,
      },
    })

    for (const part of message.parts) {
      const partInfo = decodePart(part) as SessionV1.Part
      if (partInfo.sessionID !== row.id || partInfo.messageID !== info.id) {
        return yield* new CliError({ message: `Part ${partInfo.id} does not belong to message ${info.id}` })
      }
      if (partIDs.has(partInfo.id))
        return yield* new CliError({ message: `Duplicate part ID in import: ${partInfo.id}` })
      partIDs.add(partInfo.id)

      const { id, sessionID: _sessionID, messageID, ...data } = partInfo
      preparedParts.push({
        info: partInfo,
        row: {
          id,
          message_id: messageID,
          session_id: row.id,
          data,
        },
      })
    }
  }

  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          yield* db
            .insert(SessionTable)
            .values(row)
            .onConflictDoUpdate({
              target: SessionTable.id,
              set: { project_id: row.project_id, directory: row.directory, path: row.path },
            })
            .run()

          for (const values of batch(preparedMessages.map((item) => item.row))) {
            yield* db.insert(MessageTable).values(values).onConflictDoNothing().run()
          }
          for (const values of batch(preparedParts.map((item) => item.row))) {
            yield* db.insert(PartTable).values(values).onConflictDoNothing().run()
          }

          const messageState = [] as Array<{
            id: SessionV1.MessageID
            sessionID: typeof MessageTable.$inferSelect.session_id
            data: typeof MessageTable.$inferSelect.data
            orderSessionID: typeof MessageOrderTable.$inferSelect.session_id | null
          }>
          for (const ids of batch(preparedMessages.map((item) => item.info.id))) {
            messageState.push(
              ...(yield* db
                .select({
                  id: MessageTable.id,
                  sessionID: MessageTable.session_id,
                  data: MessageTable.data,
                  orderSessionID: MessageOrderTable.session_id,
                })
                .from(MessageTable)
                .leftJoin(MessageOrderTable, eq(MessageOrderTable.message_id, MessageTable.id))
                .where(inArray(MessageTable.id, ids))
                .all()),
            )
          }

          const expectedMessages = new Map(preparedMessages.map((item) => [item.info.id, item]))
          const missingMessageOrder = new Set<string>()
          for (const state of messageState) {
            const expected = expectedMessages.get(state.id)
            if (
              !expected ||
              state.sessionID !== row.id ||
              state.data.role !== expected.info.role ||
              (state.data.role === "assistant" &&
                expected.info.role === "assistant" &&
                (!("parentID" in state.data) || state.data.parentID !== expected.info.parentID))
            ) {
              return yield* Effect.die(
                new CliError({ message: `Message ID conflicts with existing data: ${state.id}` }),
              )
            }
            if (state.orderSessionID === null) missingMessageOrder.add(state.id)
            else if (state.orderSessionID !== row.id) {
              return yield* Effect.die(
                new CliError({ message: `Message order conflicts with existing data: ${state.id}` }),
              )
            }
          }
          if (messageState.length !== preparedMessages.length) {
            return yield* Effect.die(new CliError({ message: "Failed to persist all imported messages" }))
          }

          const partState = [] as Array<{
            id: SessionV1.PartID
            messageID: SessionV1.MessageID
            sessionID: typeof PartTable.$inferSelect.session_id
            orderMessageID: typeof PartOrderTable.$inferSelect.message_id | null
            orderSessionID: typeof PartOrderTable.$inferSelect.session_id | null
          }>
          for (const ids of batch(preparedParts.map((item) => item.info.id))) {
            partState.push(
              ...(yield* db
                .select({
                  id: PartTable.id,
                  messageID: PartTable.message_id,
                  sessionID: PartTable.session_id,
                  orderMessageID: PartOrderTable.message_id,
                  orderSessionID: PartOrderTable.session_id,
                })
                .from(PartTable)
                .leftJoin(PartOrderTable, eq(PartOrderTable.part_id, PartTable.id))
                .where(inArray(PartTable.id, ids))
                .all()),
            )
          }

          const expectedParts = new Map(preparedParts.map((item) => [item.info.id, item]))
          const missingPartOrder = new Set<string>()
          for (const state of partState) {
            const expected = expectedParts.get(state.id)
            if (!expected || state.sessionID !== row.id || state.messageID !== expected.info.messageID) {
              return yield* Effect.die(new CliError({ message: `Part ID conflicts with existing data: ${state.id}` }))
            }
            if (state.orderSessionID === null) missingPartOrder.add(state.id)
            else if (state.orderSessionID !== row.id || state.orderMessageID !== state.messageID) {
              return yield* Effect.die(
                new CliError({ message: `Part order conflicts with existing data: ${state.id}` }),
              )
            }
          }
          if (partState.length !== preparedParts.length) {
            return yield* Effect.die(new CliError({ message: "Failed to persist all imported parts" }))
          }

          const parentIDs = Array.from(
            new Set(preparedMessages.flatMap((item) => (item.info.role === "assistant" ? [item.info.parentID] : []))),
          )
          const parentState = [] as Array<{
            id: SessionV1.MessageID
            sessionID: typeof MessageTable.$inferSelect.session_id
            data: typeof MessageTable.$inferSelect.data
            orderSessionID: typeof MessageOrderTable.$inferSelect.session_id | null
          }>
          for (const ids of batch(parentIDs)) {
            parentState.push(
              ...(yield* db
                .select({
                  id: MessageTable.id,
                  sessionID: MessageTable.session_id,
                  data: MessageTable.data,
                  orderSessionID: MessageOrderTable.session_id,
                })
                .from(MessageTable)
                .leftJoin(MessageOrderTable, eq(MessageOrderTable.message_id, MessageTable.id))
                .where(inArray(MessageTable.id, ids))
                .all()),
            )
          }
          if (
            parentState.length !== parentIDs.length ||
            parentState.some(
              (parent) =>
                parent.sessionID !== row.id ||
                parent.data.role !== "user" ||
                (parent.orderSessionID !== null && parent.orderSessionID !== row.id),
            )
          ) {
            return yield* Effect.die(new CliError({ message: "Imported assistant message has an invalid parent" }))
          }

          yield* db
            .insert(SessionOrderTable)
            .values({ session_id: row.id, message_seq: 0, part_seq: 0 })
            .onConflictDoNothing()
            .run()
          yield* db
            .update(SessionOrderTable)
            .set({
              message_seq: sql`max(${SessionOrderTable.message_seq}, coalesce((select max(${MessageOrderTable.seq}) + 1 from ${MessageOrderTable} where ${MessageOrderTable.session_id} = ${row.id}), 0))`,
              part_seq: sql`max(${SessionOrderTable.part_seq}, coalesce((select max(${PartOrderTable.seq}) + 1 from ${PartOrderTable} where ${PartOrderTable.session_id} = ${row.id}), 0))`,
            })
            .where(eq(SessionOrderTable.session_id, row.id))
            .run()

          const reserved = yield* LocalMessageOrder.reserveSequences(db, row.id, {
            messages: missingMessageOrder.size,
            parts: missingPartOrder.size,
          })
          const availableParents = new Set(
            parentState.filter((parent) => parent.orderSessionID === row.id).map((parent) => parent.id),
          )
          const pendingMessages = preparedMessages.filter((item) => missingMessageOrder.has(item.info.id))
          const orderedMessages: typeof pendingMessages = []
          while (pendingMessages.length > 0) {
            const index = pendingMessages.findIndex(
              (item) => item.info.role === "user" || availableParents.has(item.info.parentID),
            )
            if (index === -1) {
              return yield* Effect.die(
                new CliError({ message: "Imported messages cannot be ordered after their parents" }),
              )
            }
            const [item] = pendingMessages.splice(index, 1)
            orderedMessages.push(item)
            availableParents.add(item.info.id)
          }

          for (const values of batch(
            orderedMessages.map((item, index) => ({
              message_id: item.info.id,
              session_id: row.id,
              seq: reserved.message + index,
            })),
          )) {
            yield* db.insert(MessageOrderTable).values(values).run()
          }

          const assistantsToMove = yield* db.all<{ id: SessionV1.MessageID }>(sql`
            SELECT child.id AS id
            FROM ${MessageTable} AS child
            JOIN ${MessageTable} AS parent
              ON parent.id = json_extract(child.data, '$.parentID')
            JOIN ${MessageOrderTable} AS child_order
              ON child_order.message_id = child.id
             AND child_order.session_id = child.session_id
            JOIN ${MessageOrderTable} AS parent_order
              ON parent_order.message_id = parent.id
             AND parent_order.session_id = parent.session_id
            WHERE child.session_id = ${row.id}
              AND json_extract(child.data, '$.role') = 'assistant'
              AND parent_order.seq >= child_order.seq
            ORDER BY child.rowid, child.id
          `)
          const moved = yield* LocalMessageOrder.reserveSequences(db, row.id, {
            messages: assistantsToMove.length,
            parts: 0,
          })
          for (const [index, assistant] of assistantsToMove.entries()) {
            yield* db
              .update(MessageOrderTable)
              .set({ seq: moved.message + index })
              .where(eq(MessageOrderTable.message_id, assistant.id))
              .run()
          }

          for (const values of batch(
            preparedParts
              .filter((item) => missingPartOrder.has(item.info.id))
              .map((item, index) => ({
                part_id: item.info.id,
                message_id: item.info.messageID,
                session_id: row.id,
                seq: reserved.part + index,
              })),
          )) {
            yield* db.insert(PartOrderTable).values(values).run()
          }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import session data from JSON file or URL",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "path to JSON file or share URL",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* runImport(args.file, ctx)
  }),
})

const runImport = Effect.fn("Cli.import.body")(function* (file: string, ctx: InstanceContext) {
  const share = yield* ShareNext.Service
  const fs = yield* FSUtil.Service
  const { db } = yield* Database.Service

  let exportData: ExportData | undefined

  const isUrl = file.startsWith("http://") || file.startsWith("https://")

  if (isUrl) {
    const slug = parseShareUrl(file)
    if (!slug) {
      const baseUrl = yield* Effect.orDie(share.url())
      process.stdout.write(`Invalid URL format. Expected: ${baseUrl}/share/<slug>`)
      process.stdout.write(EOL)
      return
    }

    const baseUrl = new URL(file).origin
    const req = yield* Effect.orDie(share.request())
    const headers = shouldAttachShareAuthHeaders(file, req.baseUrl) ? req.headers : {}

    const tryFetch = (url: string) =>
      Effect.tryPromise({
        try: () => fetch(url, { headers }),
        catch: (e) =>
          new CliError({
            message: `Failed to fetch share data: ${e instanceof Error ? e.message : String(e)}`,
          }),
      })

    const dataPath = req.api.data(slug)
    let response = yield* tryFetch(`${baseUrl}${dataPath}`)

    if (!response.ok && dataPath !== `/api/share/${slug}/data`) {
      response = yield* tryFetch(`${baseUrl}/api/share/${slug}/data`)
    }

    if (!response.ok) {
      process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
      process.stdout.write(EOL)
      return
    }

    const shareData = yield* Effect.tryPromise({
      try: () => response.json() as Promise<ShareData[]>,
      catch: () => new CliError({ message: "Share data was not valid JSON" }),
    })
    const transformed = transformShareData(shareData)

    if (!transformed) {
      process.stdout.write(`Share not found or empty: ${slug}`)
      process.stdout.write(EOL)
      return
    }

    exportData = transformed
  } else {
    exportData = (yield* fs
      .readJson(file)
      .pipe(Effect.mapError((error) => new CliError({ message: formatImportFileError(file, error) })))) as ExportData
  }

  if (!exportData) {
    process.stdout.write(`Failed to read session data`)
    process.stdout.write(EOL)
    return
  }

  const info = Schema.decodeUnknownSync(Session.Info)({
    ...exportData.info,
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
  }) as Session.Info
  const row = Session.toRow(info)
  yield* persistImportedSession(db, row, exportData.messages)

  process.stdout.write(`Imported session: ${exportData.info.id}`)
  process.stdout.write(EOL)
})
