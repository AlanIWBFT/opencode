export * as LocalMessageOrder from "./local-message-order"

import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import type { MessageID, PartID } from "../v1/session"
import type { SessionSchema } from "../session/schema"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Client = Pick<Database, "get" | "run">
type Range = { readonly message: number; readonly part: number }

export const SessionOrderTable = sqliteTable("local_session_order", {
  session_id: text().$type<SessionSchema.ID>().primaryKey(),
  message_seq: integer().notNull(),
  part_seq: integer().notNull(),
})

export const MessageOrderTable = sqliteTable(
  "local_message_order",
  {
    message_id: text().$type<MessageID>().primaryKey(),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    seq: integer().notNull(),
  },
  (table) => [uniqueIndex("local_message_order_session_seq_idx").on(table.session_id, table.seq)],
)

export const PartOrderTable = sqliteTable(
  "local_part_order",
  {
    part_id: text().$type<PartID>().primaryKey(),
    message_id: text().$type<MessageID>().notNull(),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    seq: integer().notNull(),
  },
  (table) => [
    uniqueIndex("local_part_order_session_seq_idx").on(table.session_id, table.seq),
    index("local_part_order_message_seq_idx").on(table.message_id, table.seq),
  ],
)

export const nextMessageSequence = Effect.fnUntraced(function* (db: Client, sessionID: SessionSchema.ID) {
  yield* db.run(sql`
    INSERT OR IGNORE INTO local_session_order (session_id, message_seq, part_seq)
    VALUES (${sessionID}, 0, 0)
  `)
  const row = yield* db.get<{ seq: number }>(sql`
    UPDATE local_session_order
    SET message_seq = message_seq + 1
    WHERE session_id = ${sessionID}
    RETURNING message_seq - 1 AS seq
  `)
  if (!row) return yield* Effect.die(`Failed to allocate Message sequence for Session ${sessionID}`)
  return row.seq
})

export const nextPartSequence = Effect.fnUntraced(function* (db: Client, sessionID: SessionSchema.ID) {
  yield* db.run(sql`
    INSERT OR IGNORE INTO local_session_order (session_id, message_seq, part_seq)
    VALUES (${sessionID}, 0, 0)
  `)
  const row = yield* db.get<{ seq: number }>(sql`
    UPDATE local_session_order
    SET part_seq = part_seq + 1
    WHERE session_id = ${sessionID}
    RETURNING part_seq - 1 AS seq
  `)
  if (!row) return yield* Effect.die(`Failed to allocate Part sequence for Session ${sessionID}`)
  return row.seq
})

export const reserveSequences = Effect.fnUntraced(function* (
  db: Client,
  sessionID: SessionSchema.ID,
  input: { readonly messages: number; readonly parts: number },
) {
  yield* db.run(sql`
    INSERT OR IGNORE INTO local_session_order (session_id, message_seq, part_seq)
    VALUES (${sessionID}, 0, 0)
  `)
  const row = yield* db.get<Range>(sql`
    UPDATE local_session_order
    SET
      message_seq = message_seq + ${input.messages},
      part_seq = part_seq + ${input.parts}
    WHERE session_id = ${sessionID}
    RETURNING
      message_seq - ${input.messages} AS message,
      part_seq - ${input.parts} AS part
  `)
  if (!row) return yield* Effect.die(`Failed to reserve sequences for Session ${sessionID}`)
  return row
})
