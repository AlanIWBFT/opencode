export * as LocalDatabaseMigration from "./local-migration"

import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import { migrations } from "./local-migrations"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
  legacyBackfill?: true
  reconcile?: true
}

export function apply(db: Database) {
  return applyOnly(db, migrations)
}

export function applyOnly(db: Database, input: Migration[]) {
  return lock.withPermit(
    Effect.gen(function* () {
      yield* assertCanonicalSchema(db)
      yield* db.run(sql`
        CREATE TABLE IF NOT EXISTS local_migration (
          id text PRIMARY KEY,
          time_completed integer NOT NULL
        )
      `)
      const unique = input.filter((migration, index) => input.findIndex((item) => item.id === migration.id) === index)
      const completed = new Set(
        (yield* db.all<{ id: string }>(sql`SELECT id FROM local_migration`)).map((row) => row.id),
      )
      if (unique.every((migration) => completed.has(migration.id))) return

      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = new Set(
              (yield* tx.all<{ id: string }>(sql`SELECT id FROM local_migration`)).map((row) => row.id),
            )
            const pending = unique.filter((migration) => !current.has(migration.id))
            if (pending.length === 0) return

            yield* Effect.forEach(pending, (migration) => migration.up(tx), { discard: true })
            if (pending.some((migration) => migration.legacyBackfill)) {
              yield* repair(tx)
              yield* backfill(tx)
            }
            if (pending.some((migration) => migration.legacyBackfill || migration.reconcile)) {
              yield* reconcileTransaction(tx)
            }
            yield* Effect.forEach(
              pending,
              (migration) =>
                tx.run(sql`
                  INSERT INTO local_migration (id, time_completed)
                  VALUES (${migration.id}, ${Date.now()})
                `),
              { discard: true },
            )
          }),
        { behavior: "immediate" },
      )
    }),
  )
}

function assertCanonicalSchema(db: Database) {
  return Effect.gen(function* () {
    const expected = {
      message: ["id", "session_id", "time_created", "time_updated", "data"],
      part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
    }
    for (const [table, required] of Object.entries(expected)) {
      const columns = new Set(
        (yield* db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`))).map((row) => row.name),
      )
      const missing = required.filter((column) => !columns.has(column))
      if (missing.length > 0)
        return yield* Effect.die(`Canonical ${table} table is missing columns: ${missing.join(", ")}`)
    }
  })
}

export function checkMessageOrder(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      yield* assertCanonicalSchema(db)
      return yield* db.transaction(validationIssues)
    }),
  )
}

export function repairMessageOrder(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      yield* assertCanonicalSchema(db)
      yield* db.transaction(reconcileTransaction, { behavior: "immediate" })
    }),
  )
}

function reconcileTransaction(tx: Transaction) {
  return Effect.gen(function* () {
    yield* repair(tx)
    yield* tx.run(`
          DELETE FROM local_message_order
          WHERE NOT EXISTS (SELECT 1 FROM message WHERE message.id = local_message_order.message_id)
             OR NOT EXISTS (
               SELECT 1 FROM message
               WHERE message.id = local_message_order.message_id
                 AND message.session_id = local_message_order.session_id
             )
    `)
    yield* tx.run(`
          DELETE FROM local_part_order
          WHERE NOT EXISTS (SELECT 1 FROM part WHERE part.id = local_part_order.part_id)
             OR NOT EXISTS (
               SELECT 1 FROM part
               WHERE part.id = local_part_order.part_id
                 AND part.message_id = local_part_order.message_id
                 AND part.session_id = local_part_order.session_id
             )
    `)
    yield* tx.run(
      `DELETE FROM local_session_order WHERE NOT EXISTS (SELECT 1 FROM session WHERE session.id = session_id)`,
    )
    yield* tx.run(`
          INSERT OR IGNORE INTO local_session_order (session_id, message_seq, part_seq)
          SELECT id, 0, 0 FROM session
    `)
    yield* tx.run(`
          UPDATE local_session_order
          SET message_seq = max(
                message_seq,
                coalesce((
                  SELECT max(seq) + 1
                  FROM local_message_order
                  WHERE session_id = local_session_order.session_id AND seq >= 0
                ), 0)
              ),
              part_seq = max(
                part_seq,
                coalesce((
                  SELECT max(seq) + 1
                  FROM local_part_order
                  WHERE session_id = local_session_order.session_id AND seq >= 0
                ), 0)
              )
    `)
    yield* assignMissingMessages(tx)
    yield* assignMissingParts(tx)
    yield* reorderAssistants(tx)
    yield* validate(tx)
  })
}

function repair(tx: Transaction) {
  return Effect.gen(function* () {
    yield* tx.run(`DROP TABLE IF EXISTS temp._local_invalid_message`)
    yield* tx.run(`CREATE TEMP TABLE _local_invalid_message (id text PRIMARY KEY, reason text NOT NULL)`)
    yield* tx.run(`
      INSERT INTO _local_invalid_message (id, reason)
      SELECT child.id,
             CASE
               WHEN session.id IS NULL THEN 'message_session_missing'
               WHEN NOT json_valid(child.data) THEN 'invalid_message_json'
               WHEN json_extract(CASE WHEN json_valid(child.data) THEN child.data ELSE '{}' END, '$.role') IS NULL
                 OR json_extract(CASE WHEN json_valid(child.data) THEN child.data ELSE '{}' END, '$.role')
                   NOT IN ('user', 'assistant') THEN 'invalid_message_role'
               WHEN parent.id IS NULL THEN 'assistant_parent_missing'
               WHEN parent.session_id <> child.session_id THEN 'assistant_parent_session_mismatch'
               WHEN NOT json_valid(parent.data)
                 OR json_extract(CASE WHEN json_valid(parent.data) THEN parent.data ELSE '{}' END, '$.role') <> 'user'
                 THEN 'assistant_parent_not_user'
               ELSE 'assistant_parent_invalid'
             END
      FROM message child
      LEFT JOIN session ON session.id = child.session_id
      LEFT JOIN message parent ON parent.id = json_extract(
        CASE WHEN json_valid(child.data) THEN child.data ELSE '{}' END,
        '$.parentID'
      )
      WHERE session.id IS NULL
         OR NOT json_valid(child.data)
         OR json_extract(CASE WHEN json_valid(child.data) THEN child.data ELSE '{}' END, '$.role') IS NULL
         OR json_extract(CASE WHEN json_valid(child.data) THEN child.data ELSE '{}' END, '$.role')
           NOT IN ('user', 'assistant')
         OR (
           json_extract(CASE WHEN json_valid(child.data) THEN child.data ELSE '{}' END, '$.role') = 'assistant'
           AND (
             parent.id IS NULL
             OR parent.session_id <> child.session_id
             OR NOT json_valid(parent.data)
             OR json_extract(CASE WHEN json_valid(parent.data) THEN parent.data ELSE '{}' END, '$.role') <> 'user'
           )
          )
    `)
    yield* tx.run(`
      INSERT INTO local_message_repair_log (kind, reason, data, time_created)
      SELECT 'part', 'parent_message_deleted',
             json_object(
               'id', part.id,
               'message_id', part.message_id,
               'session_id', part.session_id,
               'time_created', part.time_created,
               'time_updated', part.time_updated,
               'data', part.data
             ),
             unixepoch('subsec') * 1000
      FROM part
      JOIN _local_invalid_message invalid ON invalid.id = part.message_id
    `)
    yield* tx.run(`
      INSERT INTO local_message_repair_log (kind, reason, data, time_created)
      SELECT 'message', invalid.reason,
             json_object(
               'id', message.id,
               'session_id', message.session_id,
               'time_created', message.time_created,
               'time_updated', message.time_updated,
               'data', message.data
             ),
             unixepoch('subsec') * 1000
      FROM message
      JOIN _local_invalid_message invalid ON invalid.id = message.id
    `)
    yield* tx.run(`DELETE FROM part WHERE message_id IN (SELECT id FROM _local_invalid_message)`)
    yield* tx.run(`DELETE FROM message WHERE id IN (SELECT id FROM _local_invalid_message)`)
    yield* tx.run(`DROP TABLE temp._local_invalid_message`)

    yield* tx.run(`
      INSERT INTO local_message_repair_log (kind, reason, data, time_created)
      SELECT 'part', 'message_missing',
             json_object(
               'id', part.id,
               'message_id', part.message_id,
               'session_id', part.session_id,
               'time_created', part.time_created,
               'time_updated', part.time_updated,
               'data', part.data
             ),
             unixepoch('subsec') * 1000
      FROM part
      LEFT JOIN message ON message.id = part.message_id
      WHERE message.id IS NULL
    `)
    yield* tx.run(`DELETE FROM part WHERE NOT EXISTS (SELECT 1 FROM message WHERE message.id = part.message_id)`)
    yield* tx.run(`
      INSERT INTO local_message_repair_log (kind, reason, data, time_created)
      SELECT 'part', 'session_corrected',
             json_object(
               'id', part.id,
               'message_id', part.message_id,
               'old_session_id', part.session_id,
               'session_id', message.session_id,
               'time_created', part.time_created,
               'time_updated', part.time_updated,
               'data', part.data
             ),
             unixepoch('subsec') * 1000
      FROM part
      JOIN message ON message.id = part.message_id
      WHERE part.session_id <> message.session_id
    `)
    yield* tx.run(`
      UPDATE part
      SET session_id = (SELECT message.session_id FROM message WHERE message.id = part.message_id)
      WHERE EXISTS (
        SELECT 1 FROM message
        WHERE message.id = part.message_id AND message.session_id <> part.session_id
      )
    `)
  })
}

function backfill(tx: Transaction) {
  return Effect.gen(function* () {
    yield* tx.run(`
      INSERT INTO local_session_order (session_id, message_seq, part_seq)
      SELECT id, 0, 0 FROM session
    `)
    yield* tx.run(`
      INSERT INTO local_message_order (message_id, session_id, seq)
      SELECT id,
             session_id,
             row_number() OVER (PARTITION BY session_id ORDER BY order_row, role_order, row_id, id)
               - count(*) OVER (PARTITION BY session_id) - 1
      FROM (
        SELECT child.id,
               child.session_id,
               child.rowid AS row_id,
               CASE
                 WHEN json_extract(child.data, '$.role') = 'assistant' THEN max(child.rowid, parent.rowid)
                 ELSE child.rowid
               END AS order_row,
               CASE WHEN json_extract(child.data, '$.role') = 'assistant' THEN 1 ELSE 0 END AS role_order
        FROM message child
        LEFT JOIN message parent ON parent.id = json_extract(child.data, '$.parentID')
      ) ordered
    `)
    yield* tx.run(`
      INSERT INTO local_part_order (part_id, message_id, session_id, seq)
      SELECT id,
             message_id,
             session_id,
             row_number() OVER (PARTITION BY session_id ORDER BY rowid, time_created, id)
               - count(*) OVER (PARTITION BY session_id) - 1
      FROM part
    `)
  })
}

function assignMissingMessages(tx: Transaction) {
  return Effect.gen(function* () {
    yield* tx.run(`DROP TABLE IF EXISTS temp._local_missing_message`)
    yield* tx.run(`
      CREATE TEMP TABLE _local_missing_message AS
      SELECT id,
             session_id,
             row_number() OVER (PARTITION BY session_id ORDER BY order_row, role_order, row_id, id) - 1 AS offset
      FROM (
        SELECT child.id,
               child.session_id,
               child.rowid AS row_id,
               CASE
                 WHEN json_extract(child.data, '$.role') = 'assistant' THEN max(child.rowid, parent.rowid)
                 ELSE child.rowid
               END AS order_row,
               CASE WHEN json_extract(child.data, '$.role') = 'assistant' THEN 1 ELSE 0 END AS role_order
        FROM message child
        LEFT JOIN message parent ON parent.id = json_extract(child.data, '$.parentID')
        WHERE NOT EXISTS (
          SELECT 1 FROM local_message_order WHERE local_message_order.message_id = child.id
        )
      ) ordered
    `)
    yield* tx.run(`
      INSERT INTO local_message_order (message_id, session_id, seq)
      SELECT missing.id, missing.session_id, state.message_seq + missing.offset
      FROM _local_missing_message missing
      JOIN local_session_order state ON state.session_id = missing.session_id
    `)
    yield* tx.run(`
      UPDATE local_session_order
      SET message_seq = message_seq + (
        SELECT count(*) FROM _local_missing_message WHERE session_id = local_session_order.session_id
      )
    `)
    yield* tx.run(`DROP TABLE temp._local_missing_message`)
  })
}

function assignMissingParts(tx: Transaction) {
  return Effect.gen(function* () {
    yield* tx.run(`DROP TABLE IF EXISTS temp._local_missing_part`)
    yield* tx.run(`
      CREATE TEMP TABLE _local_missing_part AS
      SELECT part.id,
             part.message_id,
             part.session_id,
             row_number() OVER (PARTITION BY part.session_id ORDER BY part.rowid, part.time_created, part.id) - 1 AS offset
      FROM part
      WHERE NOT EXISTS (SELECT 1 FROM local_part_order WHERE local_part_order.part_id = part.id)
    `)
    yield* tx.run(`
      INSERT INTO local_part_order (part_id, message_id, session_id, seq)
      SELECT missing.id, missing.message_id, missing.session_id, state.part_seq + missing.offset
      FROM _local_missing_part missing
      JOIN local_session_order state ON state.session_id = missing.session_id
    `)
    yield* tx.run(`
      UPDATE local_session_order
      SET part_seq = part_seq + (
        SELECT count(*) FROM _local_missing_part WHERE session_id = local_session_order.session_id
      )
    `)
    yield* tx.run(`DROP TABLE temp._local_missing_part`)
  })
}

function reorderAssistants(tx: Transaction) {
  return Effect.gen(function* () {
    yield* tx.run(`DROP TABLE IF EXISTS temp._local_reorder_message`)
    yield* tx.run(`
      CREATE TEMP TABLE _local_reorder_message AS
      SELECT child.id,
             child.session_id,
             row_number() OVER (PARTITION BY child.session_id ORDER BY child.rowid, child.id) - 1 AS offset
      FROM message child
      JOIN message parent ON parent.id = json_extract(child.data, '$.parentID')
      JOIN local_message_order child_order ON child_order.message_id = child.id
      JOIN local_message_order parent_order ON parent_order.message_id = parent.id
      WHERE json_extract(child.data, '$.role') = 'assistant'
        AND parent_order.seq >= child_order.seq
    `)
    yield* tx.run(`
      UPDATE local_message_order
      SET seq = (
        SELECT state.message_seq + reorder.offset
        FROM _local_reorder_message reorder
        JOIN local_session_order state ON state.session_id = reorder.session_id
        WHERE reorder.id = local_message_order.message_id
      )
      WHERE message_id IN (SELECT id FROM _local_reorder_message)
    `)
    yield* tx.run(`
      UPDATE local_session_order
      SET message_seq = message_seq + (
        SELECT count(*) FROM _local_reorder_message WHERE session_id = local_session_order.session_id
      )
    `)
    yield* tx.run(`DROP TABLE temp._local_reorder_message`)
  })
}

const validationChecks = [
  [
    "Message sidecar coverage is invalid",
    `
      SELECT 1
      FROM message
      LEFT JOIN local_message_order ON local_message_order.message_id = message.id
      WHERE local_message_order.message_id IS NULL
         OR local_message_order.session_id <> message.session_id
      LIMIT 1
    `,
  ],
  [
    "Part sidecar coverage is invalid",
    `
      SELECT 1
      FROM part
      LEFT JOIN local_part_order ON local_part_order.part_id = part.id
      WHERE local_part_order.part_id IS NULL
         OR local_part_order.message_id <> part.message_id
         OR local_part_order.session_id <> part.session_id
      LIMIT 1
    `,
  ],
  [
    "Message sidecar contains a stale row",
    `SELECT 1 FROM local_message_order WHERE NOT EXISTS (SELECT 1 FROM message WHERE message.id = message_id) LIMIT 1`,
  ],
  [
    "Part sidecar contains a stale row",
    `SELECT 1 FROM local_part_order WHERE NOT EXISTS (SELECT 1 FROM part WHERE part.id = part_id) LIMIT 1`,
  ],
  [
    "Session order state is invalid",
    `
      SELECT 1
      FROM session
      LEFT JOIN local_session_order state ON state.session_id = session.id
      WHERE state.session_id IS NULL
         OR state.message_seq < coalesce((
           SELECT max(seq) + 1 FROM local_message_order
           WHERE session_id = session.id AND seq >= 0
         ), 0)
         OR state.part_seq < coalesce((
           SELECT max(seq) + 1 FROM local_part_order
           WHERE session_id = session.id AND seq >= 0
         ), 0)
      LIMIT 1
    `,
  ],
  [
    "Session order contains a stale row",
    `SELECT 1 FROM local_session_order WHERE NOT EXISTS (SELECT 1 FROM session WHERE session.id = session_id) LIMIT 1`,
  ],
  [
    "Message session is invalid",
    `
      SELECT 1
      FROM message
      LEFT JOIN session ON session.id = message.session_id
      WHERE session.id IS NULL
      LIMIT 1
    `,
  ],
  [
    "Message data is invalid",
    `
      SELECT 1
      FROM message
      WHERE NOT json_valid(data)
         OR json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.role') IS NULL
         OR json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.role') NOT IN ('user', 'assistant')
      LIMIT 1
    `,
  ],
  [
    "Assistant parent relation is invalid",
    `
      SELECT 1
      FROM message child
      LEFT JOIN message parent ON parent.id = json_extract(
        CASE WHEN json_valid(child.data) THEN child.data ELSE '{}' END,
        '$.parentID'
      )
      WHERE json_extract(CASE WHEN json_valid(child.data) THEN child.data ELSE '{}' END, '$.role') = 'assistant'
        AND (
          parent.id IS NULL
          OR parent.session_id <> child.session_id
          OR NOT json_valid(parent.data)
          OR json_extract(CASE WHEN json_valid(parent.data) THEN parent.data ELSE '{}' END, '$.role') <> 'user'
        )
      LIMIT 1
    `,
  ],
  [
    "Assistant does not follow its parent",
    `
      SELECT 1
      FROM message child
      JOIN message parent ON parent.id = json_extract(
        CASE WHEN json_valid(child.data) THEN child.data ELSE '{}' END,
        '$.parentID'
      )
      JOIN local_message_order child_order ON child_order.message_id = child.id
      JOIN local_message_order parent_order ON parent_order.message_id = parent.id
      WHERE json_extract(CASE WHEN json_valid(child.data) THEN child.data ELSE '{}' END, '$.role') = 'assistant'
        AND parent_order.seq >= child_order.seq
      LIMIT 1
    `,
  ],
  [
    "Part ownership is invalid",
    `
      SELECT 1
      FROM part
      LEFT JOIN message ON message.id = part.message_id
      WHERE message.id IS NULL OR message.session_id <> part.session_id
      LIMIT 1
    `,
  ],
] as const

function validationIssues(db: Pick<Database, "get">) {
  return Effect.gen(function* () {
    const issues: string[] = []
    for (const [message, query] of validationChecks) {
      if (yield* db.get<{ invalid: number }>(query)) issues.push(message)
    }
    if (yield* db.get(`SELECT 1 FROM pragma_foreign_key_check('message') LIMIT 1`))
      issues.push("Message foreign key check failed")
    if (yield* db.get(`SELECT 1 FROM pragma_foreign_key_check('part') LIMIT 1`))
      issues.push("Part foreign key check failed")
    return issues
  })
}

function validate(tx: Transaction) {
  return Effect.gen(function* () {
    const issues = yield* validationIssues(tx)
    if (issues[0]) return yield* Effect.die(issues[0])
  })
}
