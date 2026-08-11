import { FinishReason, LLMEvent, ProviderMetadata, ToolResultValue } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { APICallError, type streamText } from "ai"
import { errorMessage } from "@/util/error"
import { ProviderError } from "@/provider/error"
import { ProviderV2 } from "@opencode-ai/core/provider"

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

const NON_RETRYABLE_OPENAI_INCOMPLETE_REASONS = new Set(["max_output_tokens", "content_filter"])
const OPENAI_RETRY_MAX_DELAY_MS = 2_147_483_647
const OPENAI_PROVIDER_ID = ProviderV2.ID.make("openai")

export class ExplicitCompactionError extends Schema.TaggedErrorClass<ExplicitCompactionError>()(
  "ExplicitCompactionError",
  {
    message: Schema.String,
    retryable: Schema.Boolean,
    retryAfterMs: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export function adapterState() {
  return {
    step: 0,
    text: 0,
    reasoning: 0,
    currentTextID: undefined as string | undefined,
    currentReasoningID: undefined as string | undefined,
    toolNames: {} as Record<string, string>,
    copilotTotalNanoAiu: undefined as number | undefined,
  }
}

function finishReason(value: string | undefined): FinishReason {
  return Schema.is(FinishReason)(value) ? value : "unknown"
}

function providerMetadata(value: unknown): ProviderMetadata | undefined {
  if (value == null) return undefined
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

// Temporary AI SDK bridge: Copilot billing survives only in raw provider chunks here.
// Move this extraction into @opencode-ai/llm when Copilot is handled by the native runtime.
function copilotTotalNanoAiu(value: unknown) {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const response =
    raw.response && typeof raw.response === "object" ? (raw.response as Record<string, unknown>) : undefined
  const usage = raw.copilot_usage ?? response?.copilot_usage
  if (!usage || typeof usage !== "object") return
  const total = (usage as Record<string, unknown>).total_nano_aiu
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return
  return total
}

type ExplicitCompactionOutcome =
  | { readonly type: "completed"; readonly input: readonly unknown[]; readonly output: Record<string, unknown> }
  | { readonly type: "failed" | "incomplete" | "stream-error"; readonly cause: unknown }
  | { readonly type: "protocol-error"; readonly message: string; readonly cause?: unknown }
  | { readonly type: "stream-closed" }

export type ExplicitCompactionResult = {
  readonly output: readonly Record<string, unknown>[]
  readonly input: readonly unknown[]
  readonly providerMetadata?: ProviderMetadata
}

type ExplicitCompactionTerminal = {
  readonly type: "opencode.compaction.terminal"
  readonly version: 1
  readonly headers?: Record<string, string>
  readonly cancel?: unknown
  readonly outcome: ExplicitCompactionOutcome
}

function explicitCompactionTerminal(value: unknown): ExplicitCompactionTerminal | undefined {
  const raw = record(value)
  if (raw?.type !== "opencode.compaction.terminal" || raw.version !== 1) return undefined
  const outcome = record(raw.outcome)
  if (!outcome || typeof outcome.type !== "string") return undefined
  if (
    outcome.type === "completed" &&
    Array.isArray(outcome.input) &&
    record(outcome.output)
  )
    return raw as unknown as ExplicitCompactionTerminal
  if (outcome.type === "failed" || outcome.type === "incomplete" || outcome.type === "stream-error")
    return raw as unknown as ExplicitCompactionTerminal
  if (outcome.type === "protocol-error" && typeof outcome.message === "string")
    return raw as unknown as ExplicitCompactionTerminal
  if (outcome.type === "stream-closed") return raw as unknown as ExplicitCompactionTerminal
  return undefined
}

function rawProviderMetadata(value: unknown): ProviderMetadata | undefined {
  const raw = record(value)
  if (raw?.type !== "response.metadata") return undefined
  const metadata = record(raw.metadata)
  const response = record(raw.response)
  const responseMetadata = record(response?.metadata)
  const headers =
    stringRecord(raw.headers) ??
    stringRecord(metadata?.headers) ??
    stringRecord(response?.headers) ??
    stringRecord(responseMetadata?.headers)
  return headers ? { openai: { headers } } : undefined
}

function cancelTerminal(terminal: ExplicitCompactionTerminal) {
  if (typeof terminal.cancel === "function") terminal.cancel()
}

export async function collectExplicitCompaction(
  result: { readonly fullStream: AsyncIterable<AISDKEvent> },
  onProviderMetadata?: (metadata: ProviderMetadata) => void,
): Promise<ExplicitCompactionResult> {
  try {
    for await (const event of result.fullStream) {
      if (event.type === "error") {
        const headers = APICallError.isInstance(event.error) ? stringRecord(event.error.responseHeaders) : undefined
        if (headers) onProviderMetadata?.({ openai: { headers } })
        throw explicitCompactionError(
          "OpenAI Responses explicit compaction stream failed",
          event.error,
          false,
        )
      }
      if (event.type === "abort") {
        throw explicitCompactionError(
          "OpenAI Responses explicit compaction stream was aborted",
          event.reason,
          false,
        )
      }
      if (event.type !== "raw") continue
      const terminal = explicitCompactionTerminal(event.rawValue)
      if (!terminal) continue
      const headers = stringRecord(terminal.headers)
      const metadata = turnStateMetadata(headers)
      if (metadata) onProviderMetadata?.(metadata)
      try {
        switch (terminal.outcome.type) {
          case "completed":
            return {
              input: terminal.outcome.input.filter((item) => record(item)?.type !== "compaction_trigger"),
              output: [terminal.outcome.output],
              ...(metadata ? { providerMetadata: metadata } : {}),
            }
          case "failed":
            throw explicitCompactionError(
              "OpenAI Responses explicit compaction ended with response.failed",
              terminal.outcome.cause,
              true,
              headers,
            )
          case "incomplete":
            throw explicitCompactionError(
              "OpenAI Responses explicit compaction ended with response.incomplete",
              terminal.outcome.cause,
              retryableOpenAIIncomplete(terminal.outcome.cause),
            )
          case "stream-error":
            throw explicitCompactionError(
              "OpenAI Responses explicit compaction stream failed",
              terminal.outcome.cause,
              true,
              headers,
            )
          case "protocol-error":
            throw explicitCompactionError(terminal.outcome.message, terminal.outcome.cause, false)
          case "stream-closed":
            throw explicitCompactionError(
              "OpenAI Responses explicit compaction stream closed before response.completed",
              undefined,
              true,
            )
        }
      } finally {
        cancelTerminal(terminal)
      }
    }
  } catch (cause) {
    if (cause instanceof ExplicitCompactionError) throw cause
    throw explicitCompactionError("OpenAI Responses explicit compaction stream failed", cause, true)
  }
  throw explicitCompactionError(
    "OpenAI Responses explicit compaction stream closed before response.completed",
    undefined,
    true,
  )
}

function explicitCompactionError(
  message: string,
  cause?: unknown,
  fallbackRetryable = false,
  responseHeaders?: Record<string, string>,
) {
  const resolved = resolveExplicitCompactionError(cause, responseHeaders, fallbackRetryable)
  return new ExplicitCompactionError({
    message,
    retryable: resolved.retryable,
    ...(resolved.retryAfterMs === undefined ? {} : { retryAfterMs: resolved.retryAfterMs }),
    ...(cause === undefined ? {} : { cause }),
  })
}

function resolveExplicitCompactionError(
  error: unknown,
  responseHeaders: Record<string, string> | undefined,
  fallbackRetryable: boolean,
) {
  if (APICallError.isInstance(error)) {
    const parsed = ProviderError.parseAPICallError({ providerID: OPENAI_PROVIDER_ID, error })
    if (parsed.type === "context_overflow") return { retryable: false }
    return {
      retryable: parsed.isRetryable,
      retryAfterMs: cappedRetryAfter(error.responseHeaders, error.message),
    }
  }
  if (error instanceof ProviderError.ResponseStreamError || error instanceof ProviderError.HeaderTimeoutError)
    return { retryable: true }
  const raw = record(error)
  const response = record(raw?.response)
  const providerError = record(response?.error) ?? record(raw?.error) ?? raw
  const providerCode = typeof providerError?.code === "string" ? providerError.code : undefined
  const message = typeof providerError?.message === "string" ? providerError.message : "OpenAI stream error"
  const resolved = ProviderError.resolve({
    providerID: OPENAI_PROVIDER_ID,
    message,
    isRetryable: raw?.isRetryable === true || raw?.retryable === true || fallbackRetryable,
    providerCode,
    responseHeaders,
  })
  return {
    retryable: resolved.isRetryable,
    retryAfterMs: cappedRetryAfter(responseHeaders, message),
  }
}

function retryableOpenAIIncomplete(value: unknown) {
  const reason = record(record(record(value)?.response)?.incomplete_details)?.reason
  return typeof reason !== "string" || !NON_RETRYABLE_OPENAI_INCOMPLETE_REASONS.has(reason)
}

function cappedRetryAfter(headers: Record<string, string> | undefined, message: string) {
  const value = ProviderError.retryAfterMs({ headers, message })
  return value === undefined ? undefined : Math.min(OPENAI_RETRY_MAX_DELAY_MS, value)
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function turnStateMetadata(headers: Record<string, string> | undefined): ProviderMetadata | undefined {
  const turnState = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "x-codex-turn-state")
  return turnState ? { openai: { headers: { [turnState[0]]: turnState[1] } } } : undefined
}

function usage(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const item = value as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
  const entries = Object.entries({
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    totalTokens: item.totalTokens,
    reasoningTokens: item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens,
    cacheReadInputTokens: item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens,
    cacheWriteInputTokens: item.inputTokenDetails?.cacheWriteTokens,
  }).filter((entry) => entry[1] !== undefined)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function currentTextID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentTextID = id ?? state.currentTextID ?? `text-${state.text++}`
  return state.currentTextID
}

function currentReasoningID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentReasoningID = id ?? state.currentReasoningID ?? `reasoning-${state.reasoning++}`
  return state.currentReasoningID
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  switch (event.type) {
    case "start":
      return Effect.succeed([])

    case "start-step":
      return Effect.succeed([LLMEvent.stepStart({ index: state.step })])

    case "finish-step":
      if (event.rawFinishReason === "network_error")
        return Effect.fail(new ProviderError.ResponseStreamError("Provider finish_reason: network_error"))
      return Effect.sync(() => {
        const original = providerMetadata(event.providerMetadata)
        const metadata =
          state.copilotTotalNanoAiu === undefined
            ? original
            : {
                ...original,
                copilot: {
                  ...original?.copilot,
                  totalNanoAiu: state.copilotTotalNanoAiu,
                },
              }
        state.copilotTotalNanoAiu = undefined
        return [
          LLMEvent.stepFinish({
            index: state.step++,
            reason: finishReason(event.finishReason),
            usage: usage(event.usage),
            providerMetadata: metadata,
          }),
        ]
      })

    case "finish":
      return Effect.sync(() => {
        const events = [
          LLMEvent.finish({
            reason: finishReason(event.finishReason),
            usage: usage(event.totalUsage),
            providerMetadata: "providerMetadata" in event ? providerMetadata(event.providerMetadata) : undefined,
          }),
        ]
        // Reset so the adapter can be reused for a follow-up stream without leaking
        // counters or block IDs. adapterState() is the single source of truth for shape.
        Object.assign(state, adapterState())
        return events
      })

    case "text-start":
      return Effect.sync(() => {
        state.currentTextID = currentTextID(state, event.id)
        return [
          LLMEvent.textStart({
            id: state.currentTextID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: currentTextID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "text-end":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        state.currentTextID = undefined
        return [
          LLMEvent.textEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-start":
      return Effect.sync(() => {
        state.currentReasoningID = currentReasoningID(state, event.id)
        return [
          LLMEvent.reasoningStart({
            id: state.currentReasoningID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: currentReasoningID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "reasoning-end":
      return Effect.sync(() => {
        const id = currentReasoningID(state, event.id)
        state.currentReasoningID = undefined
        return [
          LLMEvent.reasoningEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-start":
      return Effect.sync(() => {
        state.toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: event.id,
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          text: event.delta ?? "",
        }),
      ])

    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "tool-call":
      return Effect.sync(() => {
        state.toolNames[event.toolCallId] = event.toolName
        return [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input: event.input,
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-result":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolResult({
            id: event.toolCallId,
            name,
            result: ToolResultValue.make(event.output),
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-error":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? ("toolName" in event ? event.toolName : "unknown")
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolError({
            id: event.toolCallId,
            name,
            message: errorMessage(event.error),
            error: event.error,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "error":
      return Effect.fail(event.error)

    case "abort":
    case "source":
    case "file":
    case "tool-output-denied":
    case "tool-approval-request":
      return Effect.succeed([])

    case "raw":
      return Effect.sync(() => {
        state.copilotTotalNanoAiu = copilotTotalNanoAiu(event.rawValue) ?? state.copilotTotalNanoAiu
        const metadata = rawProviderMetadata(event.rawValue)
        return metadata ? [LLMEvent.providerMetadata({ providerMetadata: metadata })] : []
      })

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return Effect.succeed([])
    }
  }
}

export * as LLMAISDK from "./ai-sdk"
