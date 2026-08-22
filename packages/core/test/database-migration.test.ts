import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { eq, inArray, sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import workspaceNameMigration from "@opencode-ai/core/database/migration/20260410174513_workspace-name"
import sessionUsageMigration from "@opencode-ai/core/database/migration/20260510033149_session_usage"
import normalizeStoragePathsMigration from "@opencode-ai/core/database/migration/20260601010001_normalize_storage_paths"
import sessionMessageProjectionOrderMigration from "@opencode-ai/core/database/migration/20260603040000_session_message_projection_order"
import eventSourcedSessionInputMigration from "@opencode-ai/core/database/migration/20260604172448_event_sourced_session_input"
import contextEpochAgentMigration from "@opencode-ai/core/database/migration/20260605042240_add_context_epoch_agent"
import simplifyIntegrationCredentialsMigration from "@opencode-ai/core/database/migration/20260611192811_lush_chimera"
import simplifySessionInputMigration from "@opencode-ai/core/database/migration/20260622202450_simplify_session_input"
import { LocalDatabaseMigration } from "@opencode-ai/core/database/local-migration"
import messageOrderMigration from "@opencode-ai/core/database/local-migration/0001_message_order"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import sessionMetadataMigration from "@opencode-ai/core/database/migration/20260511173437_session-metadata"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("DatabaseMigration", () => {
  test("defaults missing workspace names while preserving legacy workspace data", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE workspace (
            id text PRIMARY KEY,
            type text NOT NULL,
            branch text,
            directory text,
            extra text,
            project_id text NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO workspace (id, type, branch, directory, extra, project_id)
          VALUES ('wrk_legacy', 'remote', 'main', '/repo', '{}', 'proj_legacy')
        `)

        yield* DatabaseMigration.applyOnly(db, [workspaceNameMigration])

        expect(yield* db.get(sql`SELECT id, name, branch, directory, extra FROM workspace`)).toEqual({
          id: "wrk_legacy",
          name: "",
          branch: "main",
          directory: "/repo",
          extra: "{}",
        })
      }),
    )
  })

  test("imports unnamed legacy Drizzle journal entries by their actual migration timestamps", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text, created_at integer)`)
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at)
          VALUES ('', ${Date.UTC(2026, 3, 10, 17, 45, 13)})
        `)

        yield* DatabaseMigration.applyOnly(db, [workspaceNameMigration])

        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "20260410174513_workspace-name" }])
      }),
    )
  })

  test("rejects unknown legacy Drizzle journal timestamps instead of guessing completed migrations", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text, created_at integer)`)
          yield* db.run(sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', 1234567890000)`)
          yield* DatabaseMigration.applyOnly(db, [workspaceNameMigration])
        }),
      ),
    ).rejects.toThrow("does not match any known migration")
  })

  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")
    const layers = [Database.layerFromPath(filename), Database.layerFromPath(filename)]

    await Effect.runPromise(
      Effect.all(
        layers.map((layer) => Effect.scoped(Layer.build(layer))),
        { concurrency: "unbounded" },
      ),
    )
  })
  if (process.platform === "linux") {
    test("declared schema has no ungenerated migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)
  }

  test("applies tracked migrations to an empty database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)).toEqual({
          name: "session",
        })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_input'`),
        ).toEqual({ name: "session_input" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_context_epoch'`),
        ).toEqual({ name: "session_context_epoch" })
        expect(
          yield* db.get(
            sql`SELECT name FROM pragma_table_info('session_context_epoch') WHERE name IN ('agent', 'replacement_seq', 'revision')`,
          ),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual({ count: migrations.length })
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('event_aggregate_seq_idx', 'event_aggregate_type_seq_idx', 'session_input_session_pending_seq_idx', 'session_input_session_pending_delivery_seq_idx', 'session_input_session_admitted_seq_idx', 'session_input_session_promoted_seq_idx', 'session_message_session_idx', 'session_message_session_type_idx', 'session_message_session_seq_idx', 'session_message_session_type_seq_idx', 'session_message_session_time_created_id_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "event_aggregate_seq_idx" },
          { name: "event_aggregate_type_seq_idx" },
          { name: "session_input_session_admitted_seq_idx" },
          { name: "session_input_session_pending_delivery_seq_idx" },
          { name: "session_input_session_promoted_seq_idx" },
          { name: "session_message_session_seq_idx" },
          { name: "session_message_session_time_created_id_idx" },
          { name: "session_message_session_type_seq_idx" },
        ])
      }),
    )
  })

  test("rejects a non-empty database without a session table", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE unrelated (id text PRIMARY KEY)`)
          yield* DatabaseMigration.apply(db)
        }),
      ),
    ).rejects.toThrow("Database is not empty and has no session table")
  })

  test("repairs and backfills local legacy message and part order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL REFERENCES message(id) ON DELETE CASCADE, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_a'), ('ses_b')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_a1', 'ses_a', 3, 3, '{"role":"assistant","parentID":"msg_a2"}'), ('msg_b1', 'ses_b', 1, 1, '{"role":"user"}'), ('msg_a2', 'ses_a', 2, 2, '{"role":"user"}'), ('msg_orphan', 'ses_a', 4, 4, '{"role":"assistant","parentID":"msg_missing"}'), ('msg_invalid_json', 'ses_a', 5, 5, '{'), ('msg_invalid_role', 'ses_a', 6, 6, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part_a1', 'msg_a1', 'ses_a', 3, 3, '{}'), ('part_b1', 'msg_b1', 'ses_b', 1, 1, '{}'), ('part_a2', 'msg_a2', 'ses_b', 2, 2, '{}'), ('part_orphan', 'msg_missing', 'ses_a', 4, 4, '{}'), ('part_deleted', 'msg_orphan', 'ses_a', 4, 4, '{}')`,
        )
        yield* db.run(sql`PRAGMA foreign_keys = ON`)

        yield* LocalDatabaseMigration.apply(db)

        expect(
          yield* db.all(sql`SELECT message_id AS id, seq FROM local_message_order ORDER BY session_id, seq`),
        ).toEqual([
          { id: "msg_a2", seq: -2 },
          { id: "msg_a1", seq: -1 },
          { id: "msg_b1", seq: -1 },
        ])
        expect(yield* db.all(sql`SELECT part_id AS id, seq FROM local_part_order ORDER BY session_id, seq`)).toEqual([
          { id: "part_a1", seq: -2 },
          { id: "part_a2", seq: -1 },
          { id: "part_b1", seq: -1 },
        ])
        expect(yield* db.all(sql`SELECT id, session_id FROM part ORDER BY id`)).toEqual([
          { id: "part_a1", session_id: "ses_a" },
          { id: "part_a2", session_id: "ses_a" },
          { id: "part_b1", session_id: "ses_b" },
        ])
        expect(yield* db.all(sql`SELECT reason FROM local_message_repair_log ORDER BY id`)).toEqual([
          { reason: "parent_message_deleted" },
          { reason: "assistant_parent_missing" },
          { reason: "invalid_message_json" },
          { reason: "invalid_message_role" },
          { reason: "message_missing" },
          { reason: "session_corrected" },
        ])
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
        expect(yield* db.all(sql`PRAGMA foreign_key_list(part)`)).toEqual([
          expect.objectContaining({ table: "message", from: "message_id", to: "id", on_delete: "CASCADE" }),
        ])
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_a3', 'ses_a', 4, 4, '{"role":"user"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part_a3', 'msg_a3', 'ses_a', 4, 4, '{}')`,
        )
        yield* LocalDatabaseMigration.apply(db)
        expect(
          yield* db.get(sql`SELECT message_id FROM local_message_order WHERE message_id = 'msg_a3'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT part_id FROM local_part_order WHERE part_id = 'part_a3'`)).toBeUndefined()
        expect(yield* LocalDatabaseMigration.checkMessageOrder(db)).toEqual([
          "Message sidecar coverage is invalid",
          "Part sidecar coverage is invalid",
        ])

        yield* LocalDatabaseMigration.repairMessageOrder(db)
        expect(
          yield* db.all(
            sql`SELECT message_id AS id, seq FROM local_message_order WHERE session_id = 'ses_a' ORDER BY seq`,
          ),
        ).toEqual([
          { id: "msg_a2", seq: -2 },
          { id: "msg_a1", seq: -1 },
          { id: "msg_a3", seq: 0 },
        ])
        expect(yield* db.get(sql`SELECT seq FROM local_part_order WHERE part_id = 'part_a3'`)).toEqual({ seq: 0 })
        expect(yield* LocalDatabaseMigration.checkMessageOrder(db)).toEqual([])
        expect(yield* db.get(sql`SELECT count(*) AS count FROM local_migration`)).toEqual({ count: 2 })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'`),
        ).toBeUndefined()

        yield* db.run(sql`DELETE FROM part WHERE id = 'part_a3'`)
        yield* db.run(sql`DELETE FROM message WHERE id = 'msg_a3'`)
        yield* LocalDatabaseMigration.apply(db)
        expect(yield* db.get(sql`SELECT part_id FROM local_part_order WHERE part_id = 'part_a3'`)).toEqual({
          part_id: "part_a3",
        })
        expect(yield* db.get(sql`SELECT message_id FROM local_message_order WHERE message_id = 'msg_a3'`)).toEqual({
          message_id: "msg_a3",
        })

        yield* LocalDatabaseMigration.repairMessageOrder(db)
        expect(yield* db.get(sql`SELECT part_id FROM local_part_order WHERE part_id = 'part_a3'`)).toBeUndefined()
        expect(
          yield* db.get(sql`SELECT message_id FROM local_message_order WHERE message_id = 'msg_a3'`),
        ).toBeUndefined()
      }),
    )
  })

  test("uses row insertion order and removes invalid assistant parents", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL REFERENCES message(id) ON DELETE CASCADE, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_z', 'session', 1, 1, '{"role":"user"}'), ('msg_a', 'session', 1, 1, '{"role":"user"}'), ('msg_orphan', 'session', 2, 2, '{"role":"assistant","parentID":"msg_removed"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part_z', 'msg_a', 'session', 1, 1, '{}'), ('part_a', 'msg_a', 'session', 1, 1, '{}')`,
        )

        yield* LocalDatabaseMigration.apply(db)

        expect(yield* db.all(sql`SELECT message_id AS id, seq FROM local_message_order ORDER BY seq`)).toEqual([
          { id: "msg_z", seq: -2 },
          { id: "msg_a", seq: -1 },
        ])
        expect(yield* db.all(sql`SELECT part_id AS id, seq FROM local_part_order ORDER BY seq`)).toEqual([
          { id: "part_z", seq: -2 },
          { id: "part_a", seq: -1 },
        ])
        expect(yield* db.get(sql`SELECT id FROM message WHERE id = 'msg_orphan'`)).toBeUndefined()
      }),
    )
  })

  test("checks message order corruption without modifying it", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* LocalDatabaseMigration.apply(db)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('invalid', 'session', 1, 1, '{')`,
        )
        yield* db.run(sql`DELETE FROM local_session_order WHERE session_id = 'session'`)

        expect(yield* LocalDatabaseMigration.checkMessageOrder(db)).toEqual([
          "Message sidecar coverage is invalid",
          "Session order state is invalid",
          "Message data is invalid",
        ])
        expect(yield* db.get(sql`SELECT id FROM message WHERE id = 'invalid'`)).toEqual({ id: "invalid" })
        expect(
          yield* db.get(sql`SELECT session_id FROM local_session_order WHERE session_id = 'session'`),
        ).toBeUndefined()

        yield* LocalDatabaseMigration.repairMessageOrder(db)

        expect(yield* LocalDatabaseMigration.checkMessageOrder(db)).toEqual([])
        expect(yield* db.get(sql`SELECT id FROM message WHERE id = 'invalid'`)).toBeUndefined()
        expect(yield* db.get(sql`SELECT reason FROM local_message_repair_log ORDER BY id DESC LIMIT 1`)).toEqual({
          reason: "invalid_message_json",
        })
      }),
    )
  })

  test("removes cross-session, invalid-role, and cyclic assistant parents", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_a'), ('ses_b')`)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
            ('user_a', 'ses_a', 1, 1, '{"role":"user"}'),
            ('cross_session', 'ses_b', 2, 2, '{"role":"assistant","parentID":"user_a"}'),
            ('cycle_a', 'ses_a', 3, 3, '{"role":"assistant","parentID":"cycle_b"}'),
            ('cycle_b', 'ses_a', 4, 4, '{"role":"assistant","parentID":"cycle_a"}')
        `)

        yield* LocalDatabaseMigration.apply(db)

        expect(yield* db.all(sql`SELECT id FROM message ORDER BY id`)).toEqual([{ id: "user_a" }])
        expect(yield* db.all(sql`SELECT reason FROM local_message_repair_log ORDER BY id`)).toEqual([
          { reason: "assistant_parent_session_mismatch" },
          { reason: "assistant_parent_not_user" },
          { reason: "assistant_parent_not_user" },
        ])
      }),
    )
  })

  test("moves a legacy assistant after its parent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('child', 'session', 1, 1, '{"role":"assistant","parentID":"parent"}'), ('parent', 'session', 2, 2, '{"role":"user"}')`,
        )

        yield* LocalDatabaseMigration.apply(db)
        expect(yield* db.all(sql`SELECT message_id AS id, seq FROM local_message_order ORDER BY seq`)).toEqual([
          { id: "parent", seq: -2 },
          { id: "child", seq: -1 },
        ])
      }),
    )
  })

  test("runs the 0002 message order reconcile only once", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('parent', 'session', 1, 1, '{"role":"user"}'), ('child', 'session', 2, 2, '{"role":"assistant","parentID":"parent"}')`,
        )
        yield* LocalDatabaseMigration.applyOnly(db, [messageOrderMigration])
        yield* db.run(sql`DELETE FROM local_message_order WHERE message_id = 'parent'`)

        yield* LocalDatabaseMigration.apply(db)

        expect(yield* db.all(sql`SELECT message_id AS id, seq FROM local_message_order ORDER BY seq`)).toEqual([
          { id: "parent", seq: 0 },
          { id: "child", seq: 1 },
        ])

        yield* db.run(sql`DELETE FROM local_message_order WHERE message_id = 'parent'`)
        yield* LocalDatabaseMigration.apply(db)
        expect(yield* db.all(sql`SELECT message_id AS id, seq FROM local_message_order ORDER BY seq`)).toEqual([
          { id: "child", seq: 1 },
        ])
      }),
    )
  })

  test("reconciles a fresh local migration batch only once", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)

        const first = {
          ...messageOrderMigration,
          up: (tx: Parameters<LocalDatabaseMigration.Migration["up"]>[0]) =>
            Effect.gen(function* () {
              yield* messageOrderMigration.up(tx)
              yield* tx.run(`CREATE TABLE local_reconcile_probe (id integer PRIMARY KEY AUTOINCREMENT)`)
              yield* tx.run(`
                CREATE TRIGGER local_reconcile_probe_update
                AFTER UPDATE ON local_session_order
                BEGIN
                  INSERT INTO local_reconcile_probe (id) VALUES (NULL);
                END
              `)
            }),
        } satisfies LocalDatabaseMigration.Migration
        const second = {
          id: "0002_reconcile_probe",
          reconcile: true,
          up: () => Effect.void,
        } satisfies LocalDatabaseMigration.Migration

        yield* LocalDatabaseMigration.applyOnly(db, [first, second])

        expect(yield* db.get(sql`SELECT count(*) AS count FROM local_reconcile_probe`)).toEqual({ count: 4 })
        expect(yield* db.all(sql`SELECT id FROM local_migration ORDER BY id`)).toEqual([
          { id: "0001_message_order" },
          { id: "0002_reconcile_probe" },
        ])
      }),
    )
  })

  test("rolls back local tables when final validation fails", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = OFF`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE owner (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, owner_id text REFERENCES owner(id), time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, owner_id, time_created, time_updated, data) VALUES ('message', 'session', 'missing', 1, 1, '{"role":"user"}')`,
        )
        yield* db.run(sql`PRAGMA foreign_keys = ON`)

        const exit = yield* LocalDatabaseMigration.apply(db).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_message_order'`),
        ).toBeUndefined()
        expect(yield* db.all(sql`SELECT id FROM local_migration`)).toEqual([])
      }),
    )
  })

  test("backfills legacy order independently of concurrent durable event order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('first_message', 'session', 1, 1, '{"role":"user"}'), ('second_message', 'session', 2, 2, '{"role":"user"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('first', 'first_message', 'session', 1, 1, '{}'), ('second', 'first_message', 'session', 2, 2, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('event_second_message', 'session', 1, 'message.updated.1', '{"info":{"id":"second_message"}}'), ('event_first_message', 'session', 2, 'message.updated.1', '{"info":{"id":"first_message"}}'), ('event_second_part', 'session', 3, 'message.part.updated.1', '{"part":{"id":"second"}}'), ('event_first_part', 'session', 4, 'message.part.updated.1', '{"part":{"id":"first"}}')`,
        )

        yield* LocalDatabaseMigration.apply(db)

        expect(yield* db.all(sql`SELECT message_id AS id, seq FROM local_message_order ORDER BY seq`)).toEqual([
          { id: "first_message", seq: -2 },
          { id: "second_message", seq: -1 },
        ])
        expect(yield* db.all(sql`SELECT part_id AS id, seq FROM local_part_order ORDER BY seq`)).toEqual([
          { id: "first", seq: -2 },
          { id: "second", seq: -1 },
        ])
      }),
    )
  })

  test("applies later local migrations without replaying legacy backfill", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('message', 'session', 1, 1, '{"role":"user"}')`,
        )
        yield* LocalDatabaseMigration.apply(db)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('upstream', 'session', 2, 2, '{"role":"user"}')`,
        )

        const next = {
          id: "0002_test",
          reconcile: true,
          up: (tx: Parameters<LocalDatabaseMigration.Migration["up"]>[0]) =>
            tx.run(`CREATE TABLE local_test (id text PRIMARY KEY)`).pipe(Effect.asVoid),
        } satisfies LocalDatabaseMigration.Migration
        yield* LocalDatabaseMigration.applyOnly(db, [next, next])

        expect(yield* db.all(sql`SELECT id FROM local_migration ORDER BY id`)).toEqual([
          { id: "0001_message_order" },
          { id: "0002_message_order_reconcile_once" },
          { id: "0002_test" },
        ])
        expect(yield* db.all(sql`SELECT message_id, seq FROM local_message_order ORDER BY seq`)).toEqual([
          { message_id: "message", seq: -1 },
          { message_id: "upstream", seq: 0 },
        ])
      }),
    )
  })

  test("preserves mixed-era Session usage while repairing messages and parts", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE session (
            id text PRIMARY KEY,
            cost real NOT NULL,
            tokens_input integer NOT NULL,
            tokens_output integer NOT NULL,
            tokens_reasoning integer NOT NULL,
            tokens_cache_read integer NOT NULL,
            tokens_cache_write integer NOT NULL
          )
        `)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`
          INSERT INTO session (
            id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
          ) VALUES
            ('ses_a', 3, 20, 10, 4, 2, 1),
            ('ses_b', 2, 5, 3, 1, 1, 0)
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
            ('user_a', 'ses_a', 1, 1, '{"role":"user"}'),
            ('assistant_a', 'ses_a', 2, 2, '{"role":"assistant","parentID":"user_a","cost":3,"tokens":{"input":20,"output":10,"reasoning":4,"cache":{"read":2,"write":1}}}'),
            ('invalid', 'ses_a', 3, 3, '{}'),
            ('user_b', 'ses_b', 4, 4, '{"role":"user"}'),
            ('assistant_b', 'ses_b', 5, 5, '{"role":"assistant","parentID":"user_b","cost":2,"tokens":{"input":5,"output":3,"reasoning":1,"cache":{"read":1,"write":0}}}')
        `)
        const firstStep = JSON.stringify({
          type: "step-finish",
          reason: "tool-calls",
          cost: 1,
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
        })
        const secondStep = JSON.stringify({
          type: "step-finish",
          reason: "stop",
          cost: 2,
          tokens: { input: 20, output: 10, reasoning: 4, cache: { read: 2, write: 1 } },
        })
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
            ('first_step', 'assistant_a', 'ses_a', 1, 1, ${firstStep}),
            ('second_step', 'assistant_a', 'ses_a', 2, 2, ${secondStep}),
            ('moved', 'assistant_b', 'ses_a', 3, 3, '{"type":"text","text":"hello"}'),
            ('deleted', 'invalid', 'ses_a', 4, 4, '{}')
        `)

        yield* LocalDatabaseMigration.apply(db)

        expect(
          yield* db.all(
            sql`SELECT id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session ORDER BY id`,
          ),
        ).toEqual([
          {
            id: "ses_a",
            cost: 3,
            tokens_input: 20,
            tokens_output: 10,
            tokens_reasoning: 4,
            tokens_cache_read: 2,
            tokens_cache_write: 1,
          },
          {
            id: "ses_b",
            cost: 2,
            tokens_input: 5,
            tokens_output: 3,
            tokens_reasoning: 1,
            tokens_cache_read: 1,
            tokens_cache_write: 0,
          },
        ])
        expect(yield* db.get(sql`SELECT session_id FROM part WHERE id = 'moved'`)).toEqual({ session_id: "ses_b" })
        expect(yield* db.get(sql`SELECT id FROM message WHERE id = 'invalid'`)).toBeUndefined()
      }),
    )
  })

  test("backfills existing Context Epoch rows to the build agent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE session_context_epoch (session_id text PRIMARY KEY, baseline text NOT NULL, snapshot text NOT NULL, baseline_seq integer NOT NULL, replacement_seq integer, revision integer DEFAULT 0 NOT NULL)`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('ses_existing', 'baseline', '{}', 0)`,
        )

        yield* DatabaseMigration.applyOnly(db, [contextEpochAgentMigration])

        expect(yield* db.get(sql`SELECT agent FROM session_context_epoch WHERE session_id = 'ses_existing'`)).toEqual({
          agent: "build",
        })
      }),
    )
  })

  test("keeps legacy credential fields nullable", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE credential (id text PRIMARY KEY, connector_id text NOT NULL, method_id text NOT NULL, label text NOT NULL, value text NOT NULL, active integer DEFAULT false NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE UNIQUE INDEX credential_connector_active_idx ON credential (connector_id) WHERE active = 1`,
        )
        yield* DatabaseMigration.applyOnly(db, [simplifyIntegrationCredentialsMigration])

        yield* db.run(
          sql`INSERT INTO credential (id, connector_id, method_id, label, value, active, time_created, time_updated) VALUES ('legacy', 'openai', 'oauth', 'Legacy', '{}', 1, 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('current', 'anthropic', 'Current', '{}', 2, 2)`,
        )
        expect(yield* db.get(sql`SELECT connector_id, method_id, active FROM credential WHERE id = 'current'`)).toEqual(
          { connector_id: null, method_id: null, active: null },
        )
      }),
    )
  })

  test("resets beta history and rebuilds event-sourced Session input storage", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, workspace_id text)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE part (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq)`)
        yield* db.run(sql`CREATE INDEX event_aggregate_type_seq_idx ON event (aggregate_id, type, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_input (seq integer PRIMARY KEY AUTOINCREMENT, id text NOT NULL UNIQUE, session_id text NOT NULL, prompt text NOT NULL, delivery text NOT NULL, promoted_seq integer, time_created integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_input_session_pending_delivery_seq_idx ON session_input (session_id, promoted_seq, delivery, seq)`,
        )
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('session', 'wrk_old')`)
        yield* db.run(sql`INSERT INTO workspace (id) VALUES ('wrk_old')`)
        yield* db.run(sql`INSERT INTO message (id) VALUES ('message')`)
        yield* db.run(sql`INSERT INTO part (id) VALUES ('part')`)
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 0)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_old', 'session', 0, 'old.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_old', 'session', 'user', 0, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, time_created) VALUES ('msg_pending', 'session', '{}', 'steer', 1)`,
        )

        yield* DatabaseMigration.applyOnly(db, [eventSourcedSessionInputMigration])

        expect(yield* db.all(sql`SELECT id, workspace_id FROM session`)).toEqual([
          { id: "session", workspace_id: null },
        ])
        expect(yield* db.all(sql`SELECT id FROM workspace`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM message`)).toEqual([{ id: "message" }])
        expect(yield* db.all(sql`SELECT id FROM part`)).toEqual([{ id: "part" }])
        expect(yield* db.all(sql`SELECT id FROM event`)).toEqual([])
        expect(yield* db.all(sql`SELECT aggregate_id FROM event_sequence`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_input`)).toEqual([])
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session_input)`)).map((column) => column.name),
        ).toEqual(["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_message)`)).find(
            (index) => index.name === "session_message_session_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(event)`)).find(
            (index) => index.name === "event_aggregate_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_input)`)).filter((index) =>
            ["session_input_session_admitted_seq_idx", "session_input_session_promoted_seq_idx"].includes(index.name),
          ),
        ).toEqual([
          expect.objectContaining({ name: "session_input_session_promoted_seq_idx", unique: 1 }),
          expect.objectContaining({ name: "session_input_session_admitted_seq_idx", unique: 1 }),
        ])
      }),
    )
  })

  test("preserves canonical V1 state and restarts its event stream", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO workspace (id, type, project_id, time_used) VALUES ('workspace', 'local', 'global', 1)`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, workspace_id, slug, directory, title, version, time_created, time_updated) VALUES ('session', 'global', 'workspace', 'session', '/project', 'Before', 'test', 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('message', 'session', 1, 1, '{"role":"user"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part', 'message', 'session', 1, 1, '{}')`,
        )
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 9)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('event', 'session', 9, 'session.updated.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created) VALUES ('input', 'session', '{}', 'steer', 9, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('projected', 'session', 'user', 9, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('session', 'baseline', '{}', 9)`,
        )
        yield* LocalDatabaseMigration.apply(db)
        yield* db.run(sql`DELETE FROM migration WHERE id = ${simplifySessionInputMigration.id}`)
        yield* DatabaseMigration.applyOnly(db, [simplifySessionInputMigration])

        const database = Layer.succeed(Database.Service, { db })
        yield* EventV2.Service.use((service) =>
          service.publish(SessionV1.Event.Updated, {
            sessionID: SessionSchema.ID.make("session"),
            info: {
              id: SessionSchema.ID.make("session"),
              slug: "session",
              projectID: ProjectV2.ID.global,
              directory: "/project",
              title: "After",
              version: "test",
              time: { created: 1, updated: 2 },
            },
          }),
        ).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([EventV2.node, SessionProjector.node]), [[Database.node, database]]),
          ),
        )

        expect(
          yield* db.get(sql`
            SELECT
              (SELECT title FROM session WHERE id = 'session') AS title,
              (SELECT workspace_id FROM session WHERE id = 'session') AS workspaceID,
              (SELECT COUNT(*) FROM message WHERE id = 'message') AS messages,
              (SELECT COUNT(*) FROM part WHERE id = 'part') AS parts,
              (SELECT COUNT(*) FROM workspace) AS workspaces,
              (SELECT COUNT(*) FROM session_input) AS sessionInputs,
              (SELECT COUNT(*) FROM session_message) AS sessionMessages,
              (SELECT COUNT(*) FROM session_context_epoch) AS contextEpochs,
              (SELECT seq FROM event_sequence WHERE aggregate_id = 'session') AS seq,
              (SELECT type FROM event WHERE aggregate_id = 'session') AS eventType
          `),
        ).toEqual({
          title: "After",
          workspaceID: null,
          messages: 1,
          parts: 1,
          workspaces: 0,
          sessionInputs: 0,
          sessionMessages: 0,
          contextEpochs: 0,
          seq: 0,
          eventType: "session.updated.1",
        })
      }),
    )
  })

  test("resets incompatible projected Session messages before adding sequence order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE TABLE event (id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_type_time_created_id_idx ON session_message (session_id, type, time_created, id)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('legacy_message', 'session', 1, 1, '{"role":"user"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('legacy_part', 'legacy_message', 'session', 1, 1, '{"type":"text","text":"hello"}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES ('stale_projection', 'session', 'user', 1, 1, '{}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionMessageProjectionOrderMigration])

        expect(yield* db.all(sql`SELECT id, session_id, data FROM message`)).toEqual([
          { id: "legacy_message", session_id: "session", data: '{"role":"user"}' },
        ])
        expect(yield* db.all(sql`SELECT id, message_id, session_id, data FROM part`)).toEqual([
          {
            id: "legacy_part",
            message_id: "legacy_message",
            session_id: "session",
            data: '{"type":"text","text":"hello"}',
          },
        ])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])

        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('fresh_projection', 'session', 'user', 7, 2, 2, '{}')`,
        )
        expect(yield* db.get(sql`SELECT id, seq FROM session_message`)).toEqual({ id: "fresh_projection", seq: 7 })
      }),
    )
  })

  test("runs session usage backfill in order with schema changes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, data text NOT NULL)`)
        yield* db.run(sql`INSERT INTO session (id, time_updated) VALUES ('session_1', 1)`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES ('message_1', 'session_1', '{"role":"assistant","cost":1.25,"tokens":{"input":2,"output":3,"reasoning":4,"cache":{"read":5,"write":6}}}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionUsageMigration])

        expect(
          yield* db.get(
            sql`SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = 'session_1'`,
          ),
        ).toEqual({
          cost: 1.25,
          tokens_input: 2,
          tokens_output: 3,
          tokens_reasoning: 4,
          tokens_cache_read: 5,
          tokens_cache_write: 6,
        })
      }),
    )
  })

  test("normalizes Windows storage paths and leaves POSIX paths untouched", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, path text)`)
        // Windows-shaped rows (drive + backslash) must be normalized.
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"win"}, ${"C:\\Repo\\Thing"}, ${JSON.stringify([
            "C:\\Repo\\Thing\\sandbox",
          ])})`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"win"}, ${"C:\\Repo\\Thing\\packages\\api"}, ${"packages\\api"})`,
        )
        // UNC worktrees and their sandboxes must normalize too (not just drive paths).
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"unc"}, ${"\\\\server\\share"}, ${JSON.stringify([
            "\\\\server\\share\\sandbox",
          ])})`,
        )
        // The "/" worktree sentinel and POSIX paths (including a pathological
        // backslash in a POSIX filename) must survive byte-for-byte.
        yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"global"}, ${"/"}, ${"[]"})`)
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"posix"}, ${"/home/me/we\\ird"}, ${"src\\weird"})`,
        )

        yield* DatabaseMigration.applyOnly(db, [normalizeStoragePathsMigration])

        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'win'`)).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'win'`)).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })
        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'unc'`)).toEqual({
          worktree: "//server/share",
          sandboxes: JSON.stringify(["//server/share/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT worktree FROM project WHERE id = 'global'`)).toEqual({ worktree: "/" })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'posix'`)).toEqual({
          directory: "/home/me/we\\ird",
          path: "src\\weird",
        })
      }),
    )
  })

  test("maps native Windows paths through database columns", async () => {
    if (process.platform !== "win32") return
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const projectID = ProjectV2.ID.make("codec_project")
        const worktree = AbsolutePath.make("C:\\Repo\\Thing")
        const sandbox = AbsolutePath.make("C:\\Repo\\Thing\\sandbox")
        const directory = "C:\\Repo\\Thing\\packages\\api"
        const sessionID = SessionSchema.ID.make("ses_codec")

        expect(() =>
          Effect.runSync(
            db
              .insert(ProjectTable)
              .values({
                id: ProjectV2.ID.make("invalid_path"),
                worktree: AbsolutePath.make("not-absolute"),
                sandboxes: [],
                time_created: 1,
                time_updated: 1,
              })
              .run(),
          ),
        ).toThrow()

        yield* db
          .insert(ProjectTable)
          .values({
            id: projectID,
            worktree,
            sandboxes: [sandbox],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "codec",
            directory,
            path: "packages\\api",
            title: "Codec",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()

        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(
          yield* db.get<{ directory: string; path: string }>(
            sql`SELECT directory, path FROM session WHERE id = ${sessionID}`,
          ),
        ).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })

        const project = yield* db.select().from(ProjectTable).where(eq(ProjectTable.worktree, worktree)).get()
        const session = yield* db.select().from(SessionTable).where(eq(SessionTable.directory, directory)).get()
        expect(project?.worktree).toBe(worktree)
        expect(project?.sandboxes).toEqual([sandbox])
        expect(session?.directory).toBe(directory)
        expect(session?.path).toBe("packages/api")

        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.path, "packages\\api")).get())?.id).toBe(
          sessionID,
        )

        const moved = AbsolutePath.make("D:\\Moved\\Thing")
        const updated = yield* db
          .update(ProjectTable)
          .set({ worktree: moved, sandboxes: [moved] })
          .where(eq(ProjectTable.id, projectID))
          .returning()
          .get()
        expect(updated?.worktree).toBe(moved)
        expect(updated?.sandboxes).toEqual([moved])
        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({ worktree: "D:/Moved/Thing", sandboxes: JSON.stringify(["D:/Moved/Thing"]) })
        expect(
          (yield* db
            .select()
            .from(ProjectTable)
            .where(inArray(ProjectTable.worktree, [moved]))
            .get())?.id,
        ).toBe(projectID)

        yield* db.run(sql`UPDATE project SET worktree = ${"not-absolute"} WHERE id = ${projectID}`)
        expect(() =>
          Effect.runSync(db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()),
        ).toThrow()
      }),
    )
  })

  test("imports existing drizzle migration state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.get(sql`SELECT id FROM migration`)).toEqual({ id: "20260127222353_familiar_lady_ursula" })
      }),
    )
  })

  test("does not replay a migrated session metadata column", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260511173437_session-metadata', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "20260511173437_session-metadata" }])
      }),
    )
  })

  test("accepts the temporary replacement session metadata migration id", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('20260530232709_lovely_romulus', 1)`)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([
          { id: "20260511173437_session-metadata" },
          { id: "20260530232709_lovely_romulus" },
        ])
      }),
    )
  })

  test("skips drizzle import when migration table already has state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('existing', 1)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([{ id: "existing" }])
      }),
    )
  })
})
