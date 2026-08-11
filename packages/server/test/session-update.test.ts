import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })

it.live("explicit stop accepts an idle session and rejects an unknown session", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Stop test" }),
        }),
      ),
    )
    expect(response.status).toBe(200)
    const created = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => response.json()))
    const stopped = yield* Effect.promise(() =>
      handler(new Request(`http://opencode.local/api/session/${created.data.id}/stop`, { method: "POST" })),
    )
    expect(stopped.status).toBe(200)
    expect(yield* Effect.promise(() => stopped.json())).toEqual({ matched: 0, terminated: 0, failed: 0 })
    const missing = yield* Effect.promise(() =>
      handler(new Request(`http://opencode.local/api/session/${Session.ID.create()}/stop`, { method: "POST" })),
    )
    expect(missing.status).toBe(404)
  }).pipe(Effect.scoped),
)

it.live("updates session metadata through PATCH", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (path: string, method: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        expect(response.status).toBe(method === "PATCH" ? 204 : 200)
        return response.status === 204 ? undefined : response.json()
      })

    const created = Schema.decodeUnknownSync(SessionResponse)(
      yield* request("/api/session", "POST", { metadata: { source: "create", stale: true } }),
    )
    yield* request(`/api/session/${created.data.id}`, "PATCH", { metadata: { source: "patch" } })
    const updated = Schema.decodeUnknownSync(SessionResponse)(yield* request(`/api/session/${created.data.id}`, "GET"))

    expect(updated.data.metadata).toEqual({ source: "patch" })
  }).pipe(Effect.scoped),
)

it.live("archives and restores the backend session through PATCH", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (path: string, method: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ),
      )
    const response = yield* request("/api/session", "POST", { title: "Archive test" })
    expect(response.status).toBe(200)
    const created = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => response.json()))
    const path = `/api/session/${created.data.id}`
    expect((yield* request(path, "PATCH", { archivedAt: 12345 })).status).toBe(204)
    const archivedResponse = yield* request(path, "GET")
    const archived = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => archivedResponse.json()))
    expect(archived.data.time.archived).toBe(12345)
    expect((yield* request(path, "PATCH", { archivedAt: null })).status).toBe(204)
    const restoredResponse = yield* request(path, "GET")
    const restored = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => restoredResponse.json()))
    expect(restored.data.time.archived).toBeUndefined()
    expect((yield* request(path, "PATCH", { archivedAt: -1 })).status).toBe(400)
  }).pipe(Effect.scoped),
)
