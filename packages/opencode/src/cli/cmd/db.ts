import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@opencode-ai/core/database/database"
import { LocalDatabaseMigration } from "@opencode-ai/core/database/local-migration"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd, fail } from "../effect-cmd"

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

const CheckMessageOrderCommand = effectCmd({
  command: "check-message-order",
  describe: "check message and part order consistency",
  instance: false,
  handler: Effect.fn("Cli.db.checkMessageOrder")(function* () {
    const { db } = yield* Database.Service
    const issues = yield* LocalDatabaseMigration.checkMessageOrder(db).pipe(Effect.orDie)
    if (issues.length > 0) return yield* fail(`Message order check failed:\n- ${issues.join("\n- ")}`)
    console.log("Message order is consistent")
  }),
})

const RepairMessageOrderCommand = effectCmd({
  command: "repair-message-order",
  describe: "repair message and part order consistency",
  instance: false,
  handler: Effect.fn("Cli.db.repairMessageOrder")(function* () {
    const { db } = yield* Database.Service
    yield* LocalDatabaseMigration.repairMessageOrder(db).pipe(Effect.orDie)
    console.log("Message order repaired")
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .command(PathCommand)
      .command(CheckMessageOrderCommand)
      .command(RepairMessageOrderCommand)
      .command(QueryCommand)
      .demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
