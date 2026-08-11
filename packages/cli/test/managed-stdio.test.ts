import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Option, Schema } from "effect"
import path from "node:path"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"

const address = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ url: Schema.String })))

it.live(
  "upstream stdio EOF closes the owned server and finalizes its SQLite database",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(async () => {
        const database = path.join(tmp.path, "stdio.db")
        const config = path.join(tmp.path, "opencode.json")
        await Bun.write(config, "{}")
        const module = new URL("../src/server-process.ts", import.meta.url).href
        const child = Bun.spawn(
          [
            process.execPath,
            "--eval",
            `import { Effect } from "effect"; const { ServerProcess } = await import(${JSON.stringify(module)}); await Effect.runPromise(ServerProcess.run({ mode: "stdio", hostname: "127.0.0.1", port: 0 }));`,
          ],
          {
            cwd: path.resolve(import.meta.dir, ".."),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              XDG_DATA_HOME: path.join(tmp.path, "data"),
              XDG_STATE_HOME: path.join(tmp.path, "state"),
              XDG_CACHE_HOME: path.join(tmp.path, "cache"),
              XDG_CONFIG_HOME: path.join(tmp.path, "config"),
              OPENCODE_DB: database,
              OPENCODE_CONFIG: config,
              OPENCODE_CONFIG_DIR: path.join(tmp.path, "config"),
              OPENCODE_CONFIG_CONTENT: "{}",
              OPENCODE_CONFIG_PROJECT_DISABLE: "1",
              OPENCODE_DISABLE_MODELS_FETCH: "1",
              OPENCODE_FILEWATCHER_DISABLE: "1",
              OPENCODE_PASSWORD: "stdio-test-password",
            },
          },
        )
        const ready = Promise.withResolvers<string>()
        const stderr = new Response(child.stderr).text()
        const output = (async () => {
          let pending = ""
          for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
            pending += chunk
            const lines = pending.split("\n")
            pending = lines.pop()!
            for (const line of lines) {
              const decoded = address(line)
              if (Option.isSome(decoded)) ready.resolve(decoded.value.url)
            }
          }
        })()
        const exitedEarly = child.exited.then(async (code) => {
          ready.reject(new Error(`Server exited before the stdio handshake (${code}): ${await stderr}`))
        })
        try {
          const url = await deadline(ready.promise)
          const response = await fetch(`${url}/api/session`, {
            method: "POST",
            headers: {
              authorization: `Basic ${Buffer.from("opencode:stdio-test-password").toString("base64")}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ title: "stdio lifecycle", location: { directory: tmp.path } }),
            signal: AbortSignal.timeout(5000),
          })
          expect(response.status).toBe(200)
          await response.arrayBuffer()
          await child.stdin.end()
          expect(await deadline(child.exited)).toBe(0)
          await output
          expect(await Bun.file(`${database}-wal`).exists()).toBe(false)
          using db = new Database(database, { readonly: true })
          expect(db.query("SELECT title FROM session_v2").get()).toEqual({ title: "stdio lifecycle" })
          expect(db.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" })
        } finally {
          if (child.exitCode === null) child.kill()
          await child.exited
          await Promise.all([output, stderr, exitedEarly])
        }
      })
    }),
  { timeout: 40_000 },
)

async function deadline<T>(work: Promise<T>): Promise<T> {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => expired.reject(new Error("Timed out waiting for stdio server")), 15_000)
  try {
    return await Promise.race([work, expired.promise])
  } finally {
    clearTimeout(timer)
  }
}
