export * as OpenAITurnState from "./openai-turn-state.js"

import { Context, Effect, Option, Schema } from "effect"
import { SessionProviderContext } from "./provider-context.js"

export const header = "x-codex-turn-state"
export type State = { value?: string }
export const Current = Context.Reference<Map<string, State> | undefined>("@opencode/OpenAITurnState", {
  defaultValue: () => undefined,
})

export const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => Effect.provideService(effect, Current, new Map()))

export const select = Effect.fnUntraced(function* (source: SessionProviderContext.Provenance | undefined) {
  const current = yield* Current
  if (!current || source?.provider !== "openai" || source.protocol !== "openai-responses") return undefined
  const key = JSON.stringify(SessionProviderContext.replayIdentity(source))
  const existing = current.get(key)
  if (existing) return existing
  const state: State = {}
  current.set(key, state)
  return state
})

export function capture(state: State | undefined, headers: Readonly<Record<string, unknown>> | undefined) {
  if (!state || state.value || !headers) return
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === header)?.[1]
  const text =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.find((item): item is string => typeof item === "string")
        : undefined
  if (text) state.value = text
}

const record = Schema.Record(Schema.String, Schema.Unknown)
const frame = Schema.decodeUnknownOption(Schema.fromJsonString(record))
const headers = Schema.optional(record)
const metadata = Schema.optional(Schema.Struct({ headers }))
const response = Schema.optional(Schema.Struct({ headers, metadata }))
const incoming = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ headers, metadata, response })))

export function receive(state: State | undefined, value: string) {
  if (!state || state.value) return
  const decoded = incoming(value)
  if (Option.isNone(decoded)) return
  const data = decoded.value
  capture(state, data.headers ?? data.metadata?.headers ?? data.response?.headers ?? data.response?.metadata?.headers)
}

/** Per-frame metadata avoids changing the pooled socket's handshake affinity mid-turn. */
export function send(state: State | undefined, value: string) {
  if (!state?.value) return value
  const decoded = frame(value)
  if (Option.isNone(decoded) || decoded.value.type !== "response.create") return value
  const metadata = Schema.decodeUnknownOption(record)(decoded.value.client_metadata)
  return JSON.stringify({
    ...decoded.value,
    client_metadata: {
      ...(Option.isSome(metadata)
        ? Object.fromEntries(Object.entries(metadata.value).filter(([, value]) => typeof value === "string"))
        : {}),
      [header]: state.value,
    },
  })
}
