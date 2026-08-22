import { describe, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../../lib/cli-process"

describe("opencode db (subprocess)", () => {
  cliIt.live("reports database migration lifecycle when requested", ({ home, opencode }) =>
    Effect.gen(function* () {
      const filename = path.join(home, "migration-lifecycle.db")
      const result = yield* opencode.spawn(["db", "path"], {
        env: { OPENCODE_DB: filename, OPENCODE_STARTUP_PROTOCOL: "1" },
      })

      expect(result.exitCode, result.stderr).toBe(0)
      const events = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("opencode lifecycle "))
        .map((line) => JSON.parse(line.slice("opencode lifecycle ".length)))
      expect(events).toEqual([
        { version: 1, type: "database-migration", state: "started" },
        { version: 1, type: "database-migration", state: "completed" },
      ])

      const completed = yield* opencode.spawn(["db", "path"], {
        env: { OPENCODE_DB: filename, OPENCODE_STARTUP_PROTOCOL: "1" },
      })
      expect(completed.exitCode, completed.stderr).toBe(0)
      expect(completed.stdout).not.toContain("opencode lifecycle ")

      const ordinary = yield* opencode.spawn(["db", "path"], {
        env: { OPENCODE_DB: filename, OPENCODE_STARTUP_PROTOCOL: "0" },
      })
      expect(ordinary.exitCode, ordinary.stderr).toBe(0)
      expect(ordinary.stdout).not.toContain("opencode lifecycle ")
    }),
    30_000,
  )

  cliIt.live("reports migration preflight failure before work starts", ({ home, opencode }) =>
    Effect.gen(function* () {
      const filename = path.join(home, "invalid-migration.db")
      yield* Effect.sync(() => {
        const db = new Database(filename)
        db.run("CREATE TABLE unrelated (id text PRIMARY KEY)")
        db.close()
      })

      const result = yield* opencode.spawn(["db", "path"], {
        env: { OPENCODE_DB: filename, OPENCODE_STARTUP_PROTOCOL: "1" },
      })
      expect(result.exitCode).toBe(1)
      const events = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("opencode lifecycle "))
        .map((line) => JSON.parse(line.slice("opencode lifecycle ".length)))
      expect(events).toEqual([{ version: 1, type: "database-migration", state: "failed" }])
    }),
    15_000,
  )
})
