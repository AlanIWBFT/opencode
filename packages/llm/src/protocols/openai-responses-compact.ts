import { Effect, Schema, Stream } from "effect"
import { Endpoint } from "../route/endpoint"
import type { Interface as RequestExecutorInterface } from "../route/executor"
import { HttpTransport } from "../route/transport"
import type { Route } from "../route/client"
import type { LLMRequest, LLMError, ProviderMetadata } from "../schema"
import { OpenAIOptions } from "./utils/openai-options"
import { ProviderShared } from "./shared"

const ROUTE = "openai-responses-compact"

const OpenAIResponsesCompactBody = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(Schema.Unknown),
  store: Schema.optional(Schema.Boolean),
  stream: Schema.optional(Schema.Boolean),
  instructions: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  tool_choice: Schema.optional(Schema.Unknown),
  service_tier: Schema.optional(OpenAIOptions.OpenAIServiceTier),
  prompt_cache_key: Schema.optional(Schema.String),
  // Accept WebSocket-shaped prepared bodies, but compact replay uses HTTP headers
  // for turn-state and intentionally omits client_metadata from the payload.
  client_metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  include: Schema.optional(Schema.Array(Schema.String)),
  reasoning: Schema.optional(
    Schema.Struct({
      effort: Schema.optional(OpenAIOptions.OpenAIReasoningEffort),
      summary: Schema.optional(Schema.Literal("auto")),
    }),
  ),
  text: Schema.optional(
    Schema.Struct({
      verbosity: Schema.optional(OpenAIOptions.OpenAITextVerbosity),
    }),
  ),
})
type OpenAIResponsesCompactBody = Schema.Schema.Type<typeof OpenAIResponsesCompactBody>
const encodeCompactRequestBody = (body: { readonly input: readonly unknown[] }) => ProviderShared.encodeJson(body)

export type OutputItem = Record<string, unknown>
export type Output = readonly OutputItem[]
export type Result = {
  readonly output: Output
  readonly input: readonly unknown[]
  readonly providerMetadata?: ProviderMetadata
}

const OpenAIResponsesCompactResponse = Schema.Struct({
  output: Schema.Array(ProviderShared.JsonObject),
})
type OpenAIResponsesCompactResponse = Schema.Schema.Type<typeof OpenAIResponsesCompactResponse>

const OpenAIResponsesCompactOutputItem = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("compaction"),
    id: Schema.optionalKey(Schema.String),
    encrypted_content: Schema.String,
    internal_chat_message_metadata_passthrough: Schema.optional(Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const decodeCompactionItem = Schema.decodeUnknownOption(OpenAIResponsesCompactOutputItem)

const OpenAIResponsesCompactStreamEvent = Schema.Record(Schema.String, Schema.Unknown)
type OpenAIResponsesCompactStreamEvent = typeof OpenAIResponsesCompactStreamEvent.Type

const COMPACTION_TRIGGER = { type: "compaction_trigger" } as const
const TURN_STATE_HEADER = "x-codex-turn-state"

type CompiledRequest = {
  readonly request: LLMRequest
  readonly route: Route<unknown, unknown>
  readonly body: unknown
}

const endpoint = (route: Route<unknown, unknown>) =>
  Endpoint.path("/responses", {
    baseURL: route.endpoint.baseURL,
    query: route.endpoint.query,
  })

const decodeBody = Schema.decodeUnknownEffect(OpenAIResponsesCompactBody)
const decodeResponse = Schema.decodeUnknownEffect(OpenAIResponsesCompactResponse)

export const supports = (compiled: CompiledRequest) => compiled.route.protocol === "openai-responses"

export const compactWithInput = Effect.fn("OpenAIResponsesCompact.compactWithInput")(function* (input: {
  readonly compiled: CompiledRequest
  readonly executor: RequestExecutorInterface
}) {
  const body = yield* decodeBody(input.compiled.body).pipe(
    Effect.mapError(() => ProviderShared.invalidRequest("OpenAI Responses compact requires a compatible request body")),
  )
  const compactBody = yield* compactRequestBody({
    model: body.model,
    input: body.input,
    store: false,
    stream: true,
    instructions: body.instructions,
    tools: body.tools,
    tool_choice: body.tool_choice,
    reasoning: body.reasoning,
    service_tier: body.service_tier,
    prompt_cache_key: body.prompt_cache_key,
    text: body.text,
    include: body.include,
  })
  const compactInput = compactBody.input.filter((item) => !isCompactionTrigger(item))
  const parts = yield* HttpTransport.jsonRequestParts({
    body: compactBody,
    request: input.compiled.request,
    endpoint: endpoint(input.compiled.route),
    auth: input.compiled.route.auth,
    encodeBody: encodeCompactRequestBody,
  })
  const response = yield* input.executor.execute(
    ProviderShared.jsonPost({
      url: parts.url,
      body: parts.bodyText,
      headers: { ...parts.headers, accept: "text/event-stream" },
    }),
  )
  const providerMetadata = responseMetadata(response.headers)
  if (contentType(response.headers).includes("text/event-stream")) {
    const stream = yield* decodeStreamResponse(response.stream)
    return {
      output: stream.output,
      input: compactInput,
      ...((providerMetadata ?? stream.providerMetadata) ? { providerMetadata: providerMetadata ?? stream.providerMetadata } : {}),
    }
  }
  const text = yield* response.text.pipe(
    Effect.mapError(() => ProviderShared.eventError(ROUTE, "Failed to read OpenAI Responses compact response")),
  )
  if (looksLikeEventStream(text)) {
    const stream = yield* decodeStreamResponse(Stream.make(new TextEncoder().encode(text)))
    return {
      output: stream.output,
      input: compactInput,
      ...((providerMetadata ?? stream.providerMetadata) ? { providerMetadata: providerMetadata ?? stream.providerMetadata } : {}),
    }
  }
  const payload = yield* ProviderShared.parseJson(ROUTE, text, "Invalid OpenAI Responses compact response")
  return {
    output: yield* decodeCompactOutput(payload, text),
    input: compactInput,
    ...(providerMetadata ? { providerMetadata } : {}),
  }
})

export const compact = Effect.fn("OpenAIResponsesCompact.compact")(function* (input: {
  readonly compiled: CompiledRequest
  readonly executor: RequestExecutorInterface
}) {
  return (yield* compactWithInput(input)).output
})

function contentType(headers: Record<string, string>) {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1]?.toLowerCase() ?? ""
}

function responseMetadata(headers: Record<string, string>): ProviderMetadata | undefined {
  const value = headerValue(headers, TURN_STATE_HEADER)
  return value ? { openai: { headers: { [TURN_STATE_HEADER]: value } } } : undefined
}

function metadataFromEvent(event: OpenAIResponsesCompactStreamEvent): ProviderMetadata | undefined {
  const headers = eventHeaders(event)
  return headers ? responseMetadata(headers as Record<string, string>) : undefined
}

function eventHeaders(event: OpenAIResponsesCompactStreamEvent): Record<string, unknown> | undefined {
  if (ProviderShared.isRecord(event.headers)) return event.headers
  if (ProviderShared.isRecord(event.metadata) && ProviderShared.isRecord(event.metadata.headers)) return event.metadata.headers
  if (!ProviderShared.isRecord(event.response)) return undefined
  if (ProviderShared.isRecord(event.response.headers)) return event.response.headers
  if (ProviderShared.isRecord(event.response.metadata) && ProviderShared.isRecord(event.response.metadata.headers))
    return event.response.metadata.headers
  return undefined
}

function headerValue(headers: Record<string, unknown>, name: string) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  const value = found?.[1]
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string")
  return undefined
}

function looksLikeEventStream(text: string) {
  const trimmed = text.trimStart()
  return trimmed.startsWith("data:") || trimmed.startsWith("event:")
}

function isCompactionTrigger(value: unknown) {
  return ProviderShared.isRecord(value) && value.type === "compaction_trigger"
}

const decodeStreamEvent = Schema.decodeUnknownEffect(OpenAIResponsesCompactStreamEvent)

const compactRequestBody = Effect.fn("OpenAIResponsesCompact.compactRequestBody")(function* (value: unknown) {
  if (!ProviderShared.isRecord(value)) return yield* ProviderShared.invalidRequest("OpenAI Responses compact body must be a JSON object")
  const input = Array.isArray(value.input) ? value.input : []
  return {
    ...value,
    input: [...input.filter((item) => !isCompactionTrigger(item)), COMPACTION_TRIGGER],
  }
})

const OpenAIResponsesCompactCompletedEvent = Schema.Struct({
  response: OpenAIResponsesCompactResponse,
})
const decodeCompletedEvent = Schema.decodeUnknownEffect(OpenAIResponsesCompactCompletedEvent)

const decodeCompactOutput = (payload: unknown, raw: string) =>
  decodeResponse(payload).pipe(
    Effect.map((decoded) => decoded.output),
    Effect.catch(() =>
      decodeCompletedEvent(payload).pipe(
        Effect.map((decoded) => decoded.response.output),
        Effect.mapError(() => ProviderShared.eventError(ROUTE, "Invalid OpenAI Responses compact response", raw)),
      ),
    ),
    Effect.flatMap((output) => requireSingleCompactionOutput(output, raw)),
  )

function compactionItems(items: ReadonlyArray<unknown>) {
  return items.flatMap((item) => {
    const parsed = decodeCompactionItem(item)
    return parsed._tag === "Some" ? [parsed.value] : []
  })
}

const requireSingleCompactionOutput = Effect.fn("OpenAIResponsesCompact.requireSingleCompactionOutput")(function* (
  items: ReadonlyArray<unknown>,
  raw?: string,
) {
  const output = compactionItems(items)
  if (output.length === 1) return output
  return yield* ProviderShared.eventError(
    ROUTE,
    `OpenAI Responses compact expected exactly one compaction item, received ${output.length}`,
    raw,
  )
})

function eventOutputIndex(event: OpenAIResponsesCompactStreamEvent) {
  return typeof event.output_index === "number" ? event.output_index : undefined
}

function orderedItems(items: ReadonlyMap<number, OutputItem>) {
  return Array.from(items.entries())
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item)
}

function itemTypes(items: Output) {
  return items.map((item) => (typeof item.type === "string" ? item.type : "unknown"))
}

const decodeStreamResponse = Effect.fn("OpenAIResponsesCompact.decodeStreamResponse")(function* (
  stream: Stream.Stream<Uint8Array, unknown>,
) {
  const added = new Map<number, OutputItem>()
  const done = new Map<number, OutputItem>()
  const eventTypes: string[] = []
  let completed: Output | undefined
  let providerMetadata: ProviderMetadata | undefined
  let sawCompleted = false
  const frames = Array.from(
    yield* ProviderShared.sseFraming(
      stream.pipe(
        Stream.mapError((error) =>
          ProviderShared.eventError(ROUTE, "Failed to read OpenAI Responses compact stream", ProviderShared.errorText(error)),
        ),
      ),
    ).pipe(Stream.runCollect),
  )

  for (const frame of frames) {
    const event = yield* ProviderShared.parseJson(ROUTE, frame, "Invalid OpenAI Responses compact stream event").pipe(
      Effect.andThen(decodeStreamEvent),
      Effect.mapError(() => ProviderShared.eventError(ROUTE, "Invalid OpenAI Responses compact stream event", frame)),
    )
    if (typeof event.type === "string") eventTypes.push(event.type)
    providerMetadata ??= metadataFromEvent(event)
    if (event.type === "error" || event.type === "response.failed") {
      return yield* ProviderShared.eventError(ROUTE, "OpenAI Responses compact stream failed", frame)
    }
    if (event.type === "response.output_item.added" && ProviderShared.isRecord(event.item)) {
      added.set(eventOutputIndex(event) ?? added.size, event.item)
      continue
    }
    if (event.type === "response.output_item.done" && ProviderShared.isRecord(event.item)) {
      done.set(eventOutputIndex(event) ?? done.size, event.item)
      continue
    }
    if (event.type === "response.completed") {
      sawCompleted = true
      if (ProviderShared.isRecord(event.response) && Array.isArray(event.response.output)) {
        completed = event.response.output.filter(ProviderShared.isRecord)
      }
      break
    }
  }

  if (!sawCompleted) return yield* ProviderShared.eventError(ROUTE, "OpenAI Responses compact stream closed before response.completed")
  const output = orderedItems(done)
  if (compactionItems(output).length > 0)
    return { output: yield* requireSingleCompactionOutput(output), ...(providerMetadata ? { providerMetadata } : {}) }
  const addedOutput = orderedItems(added)
  if (completed && compactionItems(completed).length > 0)
    return { output: yield* requireSingleCompactionOutput(completed), ...(providerMetadata ? { providerMetadata } : {}) }
  if (compactionItems(addedOutput).length > 0)
    return { output: yield* requireSingleCompactionOutput(addedOutput), ...(providerMetadata ? { providerMetadata } : {}) }
  yield* Effect.logWarning("OpenAI Responses compact stream returned no output", {
    eventTypes,
    addedTypes: itemTypes(addedOutput),
    doneTypes: itemTypes(output),
    completedTypes: completed ? itemTypes(completed) : undefined,
  })
  return { output: yield* requireSingleCompactionOutput([]), ...(providerMetadata ? { providerMetadata } : {}) }
})

export * as OpenAIResponsesCompact from "./openai-responses-compact"
