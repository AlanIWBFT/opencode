import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import fs from "node:fs/promises"
import path from "node:path"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const SessionsResponse = Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.Info)) })

const makeRequest = Effect.fn(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
    models: { fetch: false },
  })
  return (path: string, method: string, body?: unknown, status = method === "PATCH" ? 204 : 200) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      expect(response.status).toBe(status)
      return response.status === 204 ? undefined : response.json()
    })
})

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
    const request = yield* makeRequest()
    const created = Schema.decodeUnknownSync(SessionResponse)(
      yield* request("/api/session", "POST", { metadata: { source: "create", stale: true } }),
    )
    yield* request(`/api/session/${created.data.id}`, "PATCH", { metadata: { source: "patch" } })
    const updated = Schema.decodeUnknownSync(SessionResponse)(yield* request(`/api/session/${created.data.id}`, "GET"))

    expect(updated.data.metadata).toEqual({ source: "patch" })
  }).pipe(Effect.scoped),
)

it.live("archives and unarchives a session through PATCH", () =>
  Effect.gen(function* () {
    const request = yield* makeRequest()
    const created = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", "POST", {}))
    const get = () =>
      request(`/api/session/${created.data.id}`, "GET").pipe(
        Effect.map((body) => Schema.decodeUnknownSync(SessionResponse)(body).data),
      )
    const listed = (archived: boolean) =>
      request(`/api/session?archived=${archived}`, "GET").pipe(
        Effect.map((body) => Schema.decodeUnknownSync(SessionsResponse)(body).data.map((item) => item.id)),
      )

    yield* request(`/api/session/${created.data.id}`, "PATCH", { archived: true })
    expect((yield* get()).time.archived).toBeNumber()
    expect(yield* listed(true)).toContain(created.data.id)
    expect(yield* listed(false)).not.toContain(created.data.id)

    yield* request(`/api/session/${created.data.id}`, "PATCH", { archived: false })
    expect((yield* get()).time.archived).toBeUndefined()
    expect(yield* listed(false)).toContain(created.data.id)
  }).pipe(Effect.scoped),
)

it.live("updates ordinary properties after the session directory disappears, while automatic naming requires it", () =>
  Effect.gen(function* () {
    const temporary = yield* tmpdirScoped()
    const directory = path.join(temporary.path, "workspace")
    yield* Effect.promise(() => fs.mkdir(directory))
    const request = yield* makeRequest()
    const created = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", "POST", {
      location: { directory }, title: "Before removal",
    }))
    yield* request(`/api/debug/location?directory=${encodeURIComponent(directory)}`, "DELETE", undefined, 204)
    yield* Effect.promise(() => fs.rename(directory, path.join(temporary.path, "removed-workspace")))
    const url = `/api/session/${created.data.id}`
    yield* request(url, "PATCH", {
      archived: true, title: "After removal", metadata: { retained: true }, permissions: [],
    })
    const archived = Schema.decodeUnknownSync(SessionResponse)(yield* request(url, "GET")).data
    expect(archived.time.archived).toBeNumber()
    expect(archived.title).toBe("After removal")
    expect(archived.metadata).toEqual({ retained: true })
    expect(archived.location.directory).toBe(directory)
    yield* request(url, "PATCH", { archived: false })
    expect(Schema.decodeUnknownSync(SessionResponse)(yield* request(url, "GET")).data.time.archived).toBeUndefined()
    yield* request(url, "PATCH", { title: "" }, 404)
    yield* request(url, "PATCH", { archived: true })
    expect(Schema.decodeUnknownSync(SessionResponse)(yield* request(url, "GET")).data.time.archived).toBeNumber()
  }).pipe(Effect.scoped),
)
