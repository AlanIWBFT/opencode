import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { OpenAI } from "@opencode/ai/providers"
import { OpenAITurnState } from "@opencode/core/session/openai-turn-state"
import { SessionProviderContext } from "@opencode/core/session/provider-context"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"

test("WebSocket turn state is first-value-wins and is replayed per frame", () => {
  const state: OpenAITurnState.State = {}
  OpenAITurnState.receive(
    state,
    JSON.stringify({
      type: "response.created",
      response: { metadata: { headers: { "X-Codex-Turn-State": ["first"] } } },
    }),
  )
  OpenAITurnState.receive(
    state,
    JSON.stringify({ type: "response.completed", headers: { "x-codex-turn-state": "later" } }),
  )
  expect(state.value).toBe("first")
  const sent = OpenAITurnState.send(
    state,
    JSON.stringify({ type: "response.create", input: [], client_metadata: { existing: "value" } }),
  )
  expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(sent)).toEqual({
    type: "response.create",
    input: [],
    client_metadata: { existing: "value", "x-codex-turn-state": "first" },
  })
  const other = '{"type":"ping"}'
  expect(OpenAITurnState.send(state, other)).toBe(other)
})

test("turn state is scoped, endpoint-isolated and reusable across OpenAI models", async () => {
  const model = SessionRunnerModel.resolved(OpenAI.responses("gpt-first"), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 128_000, output: 4096 },
  })
  const source = SessionProviderContext.provenance(model)!
  await Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* OpenAITurnState.select(source)).toBeUndefined()
      yield* Effect.gen(function* () {
        const state = yield* OpenAITurnState.select(source)
        OpenAITurnState.capture(state, { "x-codex-turn-state": "first" })
        expect(yield* OpenAITurnState.select({ ...source, modelID: "gpt-second" })).toBe(state)
        expect((yield* OpenAITurnState.select({ ...source, endpoint: "different" }))?.value).toBeUndefined()
        expect(yield* OpenAITurnState.select({ ...source, provider: "other" })).toBeUndefined()
        yield* Effect.gen(function* () {
          expect((yield* OpenAITurnState.select(source))?.value).toBeUndefined()
        }).pipe(OpenAITurnState.scoped)
        expect(state?.value).toBe("first")
      }).pipe(OpenAITurnState.scoped)
      yield* Effect.gen(function* () {
        expect((yield* OpenAITurnState.select(source))?.value).toBeUndefined()
      }).pipe(OpenAITurnState.scoped)
    }),
  )
})
