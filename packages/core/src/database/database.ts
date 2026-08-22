export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { DatabaseMigration } from "./migration"
import { LocalDatabaseMigration } from "./local-migration"
import { makeGlobalNode } from "../effect/app-node"
import { DatabaseFile } from "./database-file"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

const reportMigrationState = (state: "started" | "completed" | "failed") =>
  process.env.OPENCODE_STARTUP_PROTOCOL === "1"
    ? Effect.sync(() =>
        console.log(
          `opencode lifecycle ${JSON.stringify({ version: 1, type: "database-migration", state })}`,
        ),
      )
    : Effect.void

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    let migrationStarted = false
    const reportMigrationStarted = Effect.suspend(() => {
      if (migrationStarted) return Effect.void
      migrationStarted = true
      return reportMigrationState("started")
    })
    yield* Effect.gen(function* () {
      yield* DatabaseMigration.apply(db, { onStart: reportMigrationStarted })
      yield* LocalDatabaseMigration.apply(db, { onStart: reportMigrationStarted })
    }).pipe(
      Effect.tap(() => (migrationStarted ? reportMigrationState("completed") : Effect.void)),
      Effect.onError(() => reportMigrationState("failed")),
    )

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

export function path() {
  return DatabaseFile.resolve()
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
