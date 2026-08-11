import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { PublicStoredSessionMessage } from "@opencode/protocol/groups/message"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const MessagesResponse = Schema.Struct({
  data: Schema.Array(Schema.toEncoded(PublicStoredSessionMessage)),
  cursor: Schema.Record(Schema.String, Schema.String),
})
const MessageResponse = Schema.Struct({ data: Schema.toEncoded(PublicStoredSessionMessage) })
const ExportResponse = Schema.Struct({
  data: Schema.Struct({ messages: Schema.Array(Schema.toEncoded(PublicStoredSessionMessage)) }),
})

it.live("list, individual reads and exports expose database order while import ignores supplied sequence", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (path: string, method = "GET", body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        expect(response.status).toBe(200)
        return response.json()
      })
    const seed = Schema.decodeUnknownSync(SessionResponse)(
      yield* request("/api/session", "POST", { title: "Message order" }),
    )
    const sessionID = Session.ID.create()
    yield* request("/api/experimental/session/import", "POST", {
      info: { ...seed.data, id: sessionID },
      messages: [
        { id: "msg_z_first", type: "user", text: "first", seq: 900, time: { created: 200 } },
        { id: "msg_a_second", type: "synthetic", text: "second", seq: 3, time: { created: 100 } },
      ],
    })
    const root = `/api/session/${sessionID}`
    const first = Schema.decodeUnknownSync(MessagesResponse)(yield* request(`${root}/message?order=asc&limit=1`))
    expect(first.data.map((message) => [message.id, message.seq])).toEqual([["msg_z_first", 1]])
    const second = Schema.decodeUnknownSync(MessagesResponse)(
      yield* request(`${root}/message?cursor=${encodeURIComponent(first.cursor.next)}`),
    )
    expect(second.data.map((message) => [message.id, message.seq])).toEqual([["msg_a_second", 2]])
    const individual = Schema.decodeUnknownSync(MessageResponse)(yield* request(`${root}/message/msg_z_first`))
    expect(individual.data.seq).toBe(1)
    for (const sanitize of [false, true]) {
      const exported = Schema.decodeUnknownSync(ExportResponse)(
        yield* request(`/api/experimental/session/${sessionID}/export?sanitize=${sanitize}`),
      )
      expect(exported.data.messages.map((message) => message.seq)).toEqual([1, 2])
    }
  }).pipe(Effect.scoped),
)
