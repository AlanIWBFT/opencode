import type { Auth } from "@/auth"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Cause, Effect, FiberSet, Queue } from "effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient } from "effect/unstable/http"
import {
  LLMRequest,
  Tool as NativeTool,
  ToolFailure,
  ToolRuntime,
  toDefinitions,
  type JsonSchema,
  type LLMEvent,
  type ProviderMetadata,
} from "@opencode-ai/llm"
import type { LLMClientShape } from "@opencode-ai/llm/route"
import { LLMNative } from "./native-request"

export type RuntimeStatus =
  | { readonly type: "supported"; readonly apiKey: string; readonly baseURL?: string }
  | { readonly type: "unsupported"; readonly reason: string }
export type StreamResult =
  | { readonly type: "supported"; readonly stream: Stream.Stream<LLMEvent, unknown> }
  | { readonly type: "unsupported"; readonly reason: string }

export type TurnState = { value?: string }

const TURN_STATE_HEADER = "x-codex-turn-state"

type StreamInput = {
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly llmClient: LLMClientShape
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, any>
  readonly headers: Record<string, string>
  readonly abort: AbortSignal
  readonly turnState?: TurnState
}

type RequestInput = Pick<
  StreamInput,
  "model" | "provider" | "toolChoice" | "temperature" | "topP" | "topK" | "maxOutputTokens" | "headers"
> & {
  readonly apiKey: string
  readonly baseURL?: string
  readonly messages: ModelMessage[]
  readonly tools?: Record<string, Tool>
  readonly providerOptions?: Record<string, any>
  readonly turnState?: TurnState
}

export function status(input: Pick<StreamInput, "model" | "provider" | "auth">): RuntimeStatus {
  return statusWithFetch(input, providerFetch(input))
}

function statusWithFetch(
  input: Pick<StreamInput, "model" | "provider" | "auth">,
  fetch: typeof globalThis.fetch | undefined,
): RuntimeStatus {
  const providerID = input.model.providerID
  if (providerID !== "openai" && providerID !== "anthropic" && !providerID.startsWith("opencode"))
    return { type: "unsupported", reason: "provider is not openai, opencode, or anthropic" }
  const npm = input.model.api.npm
  if (npm !== "@ai-sdk/openai" && npm !== "@ai-sdk/openai-compatible" && npm !== "@ai-sdk/anthropic")
    return { type: "unsupported", reason: "provider package is not OpenAI, OpenAI-compatible, or Anthropic" }
  if (input.auth?.type === "oauth" && !(input.provider.id === "openai" && fetch)) {
    return { type: "unsupported", reason: "OAuth auth requires a provider fetch override" }
  }

  const apiKey = typeof input.provider.options.apiKey === "string" ? input.provider.options.apiKey : input.provider.key
  if (!apiKey) return { type: "unsupported", reason: "API key is not configured" }

  return {
    type: "supported",
    apiKey,
    baseURL: typeof input.provider.options.baseURL === "string" ? input.provider.options.baseURL : undefined,
  }
}

export function stream(input: StreamInput): StreamResult {
  const fetch = providerFetch(input)
  const current = statusWithFetch(input, fetch)
  if (current.type === "unsupported") return current

  // Integration point with @opencode-ai/llm: native-request lowers session data
  // into an LLMRequest, then LLMClient handles route selection and transport.
  //
  // ProviderTransform.providerOptions builds AI-SDK-shaped options for the
  // selected SDK key (e.g. "openai") and the native LLM SDK reads the same
  // keys via OpenAIOptions.* (store, reasoningEffort, reasoningSummary,
  // include, textVerbosity, promptCacheKey). Both sides intentionally use
  // OpenAI's official wire field names, so this is identity, not translation
  // — if a field ever needs to differ between the two surfaces, the
  // translation belongs here, not split across both packages.
  const tools = nativeTools(input.tools, input)
  const baseRequest = buildRequest({ ...input, apiKey: current.apiKey, baseURL: current.baseURL })
  const stream = Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const settlements = yield* FiberSet.make<void>()
        const results = yield* Queue.unbounded<LLMEvent, Cause.Done>()
        const provider = input.llmClient
          .stream(
            LLMRequest.update(baseRequest, {
              tools: [...baseRequest.tools, ...toDefinitions(tools)],
            }),
          )
          .pipe(
            Stream.tap((event) => Effect.sync(() => captureTurnState(input.turnState, event))),
            Stream.flatMap((event) =>
              event.type !== "tool-call" || event.providerExecuted
                ? Stream.make(event)
                : Stream.make(event).pipe(
                    Stream.concat(
                      Stream.fromEffectDrain(
                        ToolRuntime.dispatch(tools, event).pipe(
                          Effect.flatMap((dispatched) => Queue.offerAll(results, dispatched.events)),
                          Effect.catchCause((cause) => Queue.failCause(results, cause)),
                          Effect.asVoid,
                          FiberSet.run(settlements, { startImmediately: true }),
                        ),
                      ),
                    ),
                  ),
            ),
            Stream.concat(
              Stream.fromEffectDrain(
                FiberSet.awaitEmpty(settlements).pipe(Effect.andThen(Queue.end(results)), Effect.asVoid),
              ),
            ),
          )
        return provider.pipe(Stream.concat(Stream.fromQueue(results)))
      }),
    ),
  )

  return {
    ...current,
    stream: fetch ? stream.pipe(Stream.provideService(FetchHttpClient.Fetch, fetch)) : stream,
  }
}

function buildRequest(input: RequestInput) {
  return LLMNative.request({
    model: input.model,
    apiKey: input.apiKey,
    baseURL: input.baseURL,
    messages: ProviderTransform.message(input.messages, input.model, input.providerOptions ?? {}),
    tools: {},
    toolChoice: input.toolChoice,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxOutputTokens: input.maxOutputTokens,
    providerOptions: ProviderTransform.providerOptions(input.model, input.providerOptions ?? {}),
    headers: { ...providerHeaders(input.provider.options.headers), ...input.headers, ...withTurnStateHeaders(input) },
  })
}

export function createTurnState(): TurnState {
  return {}
}

export function usesOpenAITurnState(input: Pick<RequestInput, "model" | "turnState">) {
  return input.model.api.npm === "@ai-sdk/openai" && input.turnState !== undefined
}

export function withTurnStateHeaders(input: Pick<RequestInput, "model" | "turnState">) {
  return usesOpenAITurnState(input) && input.turnState?.value
    ? { [TURN_STATE_HEADER]: input.turnState.value }
    : undefined
}

export function captureTurnState(state: TurnState | undefined, event: LLMEvent | ProviderMetadata | undefined) {
  if (!state || state.value) return
  const providerMetadata = eventProviderMetadata(event)
  const openai = providerMetadata?.openai
  if (!isRecord(openai) || !isRecord(openai.headers)) return
  const value = headerValue(openai.headers, TURN_STATE_HEADER)
  if (value) state.value = value
}

function eventProviderMetadata(event: LLMEvent | ProviderMetadata | undefined): ProviderMetadata | undefined {
  if (!event) return undefined
  if (isRecord(event) && typeof event.type === "string") {
    if (!("providerMetadata" in event)) return undefined
    return isProviderMetadata(event.providerMetadata) ? event.providerMetadata : undefined
  }
  return isProviderMetadata(event) ? event : undefined
}

function isProviderMetadata(value: unknown): value is ProviderMetadata {
  if (!isRecord(value)) return false
  return Object.values(value).every(isRecord)
}

function headerValue(headers: Record<string, unknown>, name: string) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  const value = found?.[1]
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string")
  return undefined
}

function providerFetch(input: Pick<StreamInput, "provider" | "auth">): typeof globalThis.fetch | undefined {
  if (input.provider.id !== "openai" || input.auth?.type !== "oauth") return undefined
  const value: unknown = input.provider.options.fetch
  if (typeof value !== "function") return undefined
  return value as typeof globalThis.fetch
}

function providerHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function nativeSchema(value: unknown): JsonSchema {
  if (!value || typeof value !== "object") return { type: "object", properties: {} }
  if ("jsonSchema" in value && value.jsonSchema && typeof value.jsonSchema === "object")
    return value.jsonSchema as JsonSchema
  return asSchema(value as Parameters<typeof asSchema>[0]).jsonSchema as JsonSchema
}

export function nativeTools(tools: Record<string, Tool>, input: Pick<StreamInput, "messages" | "abort">) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, item]) => [
      name,
      // Tool execution remains opencode-owned. The native runtime only adapts
      // the @opencode-ai/llm tool call back into the AI SDK Tool.execute shape.
      NativeTool.make({
        description: item.description ?? "",
        jsonSchema: nativeSchema(item.inputSchema),
        execute: (args: unknown, ctx) =>
          Effect.tryPromise({
            try: () => {
              if (!item.execute) throw new Error(`Tool has no execute handler: ${name}`)
              return item.execute(args, {
                toolCallId: ctx?.id ?? name,
                messages: input.messages,
                abortSignal: input.abort,
              })
            },
            catch: (error) => new ToolFailure({ message: errorMessage(error), error }),
          }),
      }),
    ]),
  )
}

export * as LLMNativeRuntime from "./native-runtime"
