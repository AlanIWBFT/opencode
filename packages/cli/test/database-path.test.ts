import { expect, test } from "bun:test"
import path from "node:path"

test("dev channel keeps its database while explicit database settings retain precedence", () => {
  const data = path.resolve("example-data")
  const module = new URL("../src/database-path.ts", import.meta.url).href
  const run = (env: Record<string, string> = {}) => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--define",
        'OPENCODE_CHANNEL:"dev"',
        "--eval",
        `const { databasePath } = await import(${JSON.stringify(module)}); console.log(databasePath(${JSON.stringify(data)}))`,
      ],
      {
        env: { ...process.env, OPENCODE_DB: undefined, OPENCODE_DISABLE_CHANNEL_DB: undefined, ...env },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    )
    expect(result.exitCode).toBe(0)
    return result.stdout.toString().trim()
  }
  expect(run()).toBe(path.join(data, "opencode-dev.db"))
  expect(run({ OPENCODE_DB: ":memory:" })).toBe(":memory:")
  expect(run({ OPENCODE_DB: "chosen.db" })).toBe(path.join(data, "chosen.db"))
  expect(run({ OPENCODE_DB: path.resolve("absolute.db") })).toBe(path.resolve("absolute.db"))
  expect(run({ OPENCODE_DISABLE_CHANNEL_DB: "1" })).toBe(path.join(data, "opencode.db"))
  expect(run({ OPENCODE_DISABLE_CHANNEL_DB: "true", OPENCODE_DB: "explicit.db" })).toBe(path.join(data, "explicit.db"))
})
