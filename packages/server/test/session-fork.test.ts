import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })

it.live("forks through a completed answer at idle and after the parent advances", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (path: string, body?: unknown, status = 200) =>
      Effect.promise(async () => {
        const response = await handler(new Request(`http://opencode.local${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }))
        expect(response.status).toBe(status)
        const json: unknown = await response.json()
        return json
      })
    const template = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", {})).data
    for (const advanced of [false, true]) {
      const answer = `msg_answer_${advanced}`
      const question = `msg_question_${advanced}`
      const messages = [
        { id: question, type: "user", text: "First question", time: { created: 1 } },
        {
          id: answer,
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "test" },
          content: [{ type: "text", text: "Finished answer" }],
          finish: "stop",
          time: { created: 2, completed: 3 },
        },
      ]
      const tail = advanced ? [{ id: "msg_later", type: "user", text: "Later question", time: { created: 4 } }] : []
      const parent = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/experimental/session/import", {
        info: { ...template, id: Session.ID.create() },
        messages: [...messages, ...tail],
      })).data
      const fork = Schema.decodeUnknownSync(SessionResponse)(yield* request(`/api/session/${parent.id}/fork`, {
        experimental: { through: answer },
      })).data
      expect(fork.fork).toEqual({ sessionID: parent.id, boundary: { type: "through", messageID: answer } })
      expect(yield* request(`/api/session/${fork.id}/message?order=asc`)).toMatchObject({
        data: [
          { type: "user", text: "First question" },
          { type: "assistant", content: [{ type: "text", text: "Finished answer" }] },
        ],
      })
      expect(yield* request(`/api/session/${parent.id}/message?order=asc`)).toMatchObject({ data: [...messages, ...tail] })

      const before = Schema.decodeUnknownSync(SessionResponse)(yield* request(`/api/session/${parent.id}/fork`, {
        before: answer,
      })).data
      expect(yield* request(`/api/session/${before.id}/message?order=asc`)).toMatchObject({
        data: [{ type: "user", text: "First question" }],
      })
      expect(yield* request(`/api/session/${parent.id}/fork`, {
        experimental: { through: "msg_missing" },
      }, 404)).toMatchObject({ _tag: "MessageNotFoundError", sessionID: parent.id, messageID: "msg_missing" })
      expect(yield* request(`/api/session/${parent.id}/fork`, {
        before: question, experimental: { through: answer },
      }, 400)).toMatchObject({ _tag: "InvalidRequestError", kind: "fork_boundary" })
    }
    expect(yield* request(`/api/session/${template.id}/fork`, {
      experimental: { through: "msg_answer_true" },
    }, 404)).toMatchObject({ _tag: "MessageNotFoundError", sessionID: template.id, messageID: "msg_answer_true" })
  }).pipe(Effect.scoped),
)
