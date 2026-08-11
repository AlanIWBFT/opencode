import { Effect } from "effect"
import type { LocalDatabaseMigration } from "../local-migration"

export default {
  id: "0001_message_order",
  legacyBackfill: true,
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE local_session_order (
          session_id text PRIMARY KEY,
          message_seq integer NOT NULL,
          part_seq integer NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE TABLE local_message_order (
          message_id text PRIMARY KEY,
          session_id text NOT NULL,
          seq integer NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE TABLE local_part_order (
          part_id text PRIMARY KEY,
          message_id text NOT NULL,
          session_id text NOT NULL,
          seq integer NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE TABLE local_message_repair_log (
          id integer PRIMARY KEY AUTOINCREMENT,
          kind text NOT NULL,
          reason text NOT NULL,
          data text NOT NULL,
          time_created integer NOT NULL
        )
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX local_message_order_session_seq_idx ON local_message_order (session_id, seq)`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX local_part_order_session_seq_idx ON local_part_order (session_id, seq)`)
      yield* tx.run(`CREATE INDEX local_part_order_message_seq_idx ON local_part_order (message_id, seq)`)
    })
  },
} satisfies LocalDatabaseMigration.Migration
