import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Provider } from "@/provider/provider"
import { Token } from "@/util/token"
import { Option, Schema } from "effect"

export const STRATEGY = "openai-responses-compact"
export const PLACEHOLDER = "[OpenAI native compaction checkpoint]"

const LOCK_KEY = "openaiNativeCompactionLock"
const WINDOW_KEY = "openaiNativeCompactionWindow"
const DEFAULT_VARIANT = "default"
const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000

export const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  variant: Schema.optional(Schema.String),
})
export type ModelRef = typeof ModelRef.Type

const Lock = Schema.Struct({
  version: Schema.Literal(1),
  strategy: Schema.Literal(STRATEGY),
  model: ModelRef,
})
export type Lock = typeof Lock.Type

const WindowV1 = Schema.Struct({
  version: Schema.Literal(1),
  output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
})
const WindowV2 = Schema.Struct({
  version: Schema.Literal(2),
  output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  compactOutput: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
})
const Window = Schema.Union([WindowV1, WindowV2])
export type Window = typeof Window.Type

const Metadata = Schema.Struct({
  [LOCK_KEY]: Lock,
  [WINDOW_KEY]: Window,
})
export type Metadata = typeof Metadata.Type

export type Checkpoint = {
  readonly markerID: SessionV1.User["id"]
  readonly summaryID: SessionV1.Assistant["id"]
  readonly auto: boolean
  readonly tailStartID?: SessionV1.User["id"]
  readonly lock: Lock
  readonly window: Window
}

const CONTEXTUAL_USER_PREFIXES = [
  "<system-update>",
  "<environment_context>",
  "<system-reminder>",
  "<permissions instructions>",
  "<model_switch>",
  "<token_budget>",
  "<context_window",
  "<context_window_guidance",
  "<rollout_budget>",
] as const

const decodeMetadata = Schema.decodeUnknownOption(Metadata)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

export const metadata = (input: {
  readonly model: ModelRef
  readonly output?: readonly Record<string, unknown>[]
  readonly compactOutput?: readonly Record<string, unknown>[]
  readonly window?: Window
}) =>
  Metadata.make({
    [LOCK_KEY]: { version: 1, strategy: STRATEGY, model: input.model },
    [WINDOW_KEY]:
      input.window ??
      ({
        version: 2,
        output: [...(input.output ?? [])],
        ...(input.compactOutput ? { compactOutput: [...input.compactOutput] } : {}),
      } satisfies Window),
  })

export const legacyMetadata = (input: { readonly model: ModelRef; readonly output: readonly Record<string, unknown>[] }) =>
  Metadata.make({
    [LOCK_KEY]: { version: 1, strategy: STRATEGY, model: input.model },
    [WINDOW_KEY]: { version: 1, output: input.output },
  })

export const sanitizeOutput = (output: readonly Record<string, unknown>[]) =>
  output.filter((item) => {
    const role = typeof item.role === "string" ? item.role : undefined
    if (role === "system" || role === "developer") return false
    return true
  })

export const hasCompactionItem = (output: readonly Record<string, unknown>[]) =>
  output.some((item) => item.type === "compaction" && typeof item.encrypted_content === "string")

export const supportsModel = (model: Provider.Model) =>
  String(model.providerID) === "openai" && model.api.npm === "@ai-sdk/openai"

export const canReplayWithModel = (left: ModelRef, right: ModelRef) =>
  String(left.providerID) === "openai" && String(right.providerID) === "openai"
    ? true
    :
  String(left.providerID) === String(right.providerID) &&
  String(left.modelID) === String(right.modelID) &&
  String(left.variant ?? DEFAULT_VARIANT) === String(right.variant ?? DEFAULT_VARIANT)

export const checkpointMetadata = (message: SessionV1.WithParts | undefined) => {
  if (!message || message.info.role !== "assistant" || !message.info.summary || !message.info.finish || message.info.error)
    return
  return message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => Option.getOrUndefined(decodeMetadata(part.metadata)))
    .find((item) => item !== undefined)
}

export const findCheckpoint = (messages: readonly SessionV1.WithParts[]): Checkpoint | undefined => {
  const markers = new Map(
    messages.flatMap((message) => {
      if (message.info.role !== "user") return []
      const part = message.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")
      return part ? [[message.info.id, part] as const] : []
    }),
  )
  return messages
    .toReversed()
    .flatMap((message): Checkpoint[] => {
      if (message.info.role !== "assistant") return []
      const marker = markers.get(message.info.parentID)
      if (!marker) return []
      const decoded = checkpointMetadata(message)
      if (!decoded) return []
      return [
        {
          markerID: message.info.parentID,
          summaryID: message.info.id,
          auto: marker.auto,
          tailStartID: marker.tail_start_id,
          lock: decoded[LOCK_KEY],
          window: decoded[WINDOW_KEY],
        },
      ]
    })[0]
}

export const replayMessages = (messages: readonly SessionV1.WithParts[]) => {
  const checkpoint = findCheckpoint(messages)
  if (!checkpoint) return { messages: [...messages], checkpoint: undefined }
  const replayStartID = checkpoint.tailStartID ?? checkpoint.markerID
  return {
    checkpoint,
    messages: messages.filter(
      (message) =>
        message.info.id !== checkpoint.markerID &&
        message.info.id !== checkpoint.summaryID &&
        message.info.id >= replayStartID,
    ),
  }
}

export const normalizeOutput = (output: readonly Record<string, unknown>[]) =>
  output.filter((item): item is Record<string, unknown> => isRecord(item))

export const buildReplacementWindow = (input: {
  readonly compactInput: readonly unknown[]
  readonly compactOutput: readonly Record<string, unknown>[]
}): Window => {
  const output = compactionItems(input.compactOutput)
  return {
    version: 2,
    output: [...truncateRetainedMessages(retainedCompactInput(input.compactInput)), ...output],
    compactOutput: output,
  }
}

export const replayWindow = (input: { readonly checkpoint: Checkpoint }): Window | undefined => {
  if (input.checkpoint.window.version === 2) return input.checkpoint.window
  return hasCompactionItem(input.checkpoint.window.output) ? input.checkpoint.window : undefined
}

function compactionItems(items: readonly Record<string, unknown>[]) {
  return items.filter((item) => item.type === "compaction" && typeof item.encrypted_content === "string").slice(0, 1)
}

function retainedCompactInput(input: readonly unknown[]) {
  return input
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter(isRetainedForRemoteCompactionV2)
    .filter(shouldKeepCompactedHistoryItem)
}

function isRetainedForRemoteCompactionV2(item: Record<string, unknown>) {
  return ["user", "developer", "system"].includes(typeof item.role === "string" ? item.role : "")
}

function shouldKeepCompactedHistoryItem(item: Record<string, unknown>) {
  if (item.role === "developer" || item.role === "system") return false
  if (item.role !== "user" || !Array.isArray(item.content)) return false
  const content = item.content.filter(isUserInputContent)
  if (content.length === 0) return false
  return !content.some(isContextualUserContent)
}

function isUserInputContent(item: unknown): item is Record<string, unknown> {
  if (!isRecord(item)) return false
  if (item.type === "input_text") return typeof item.text === "string"
  return item.type === "input_image" && typeof item.image_url === "string"
}

function isContextualUserContent(item: Record<string, unknown>) {
  if (item.type !== "input_text" || typeof item.text !== "string") return false
  const text = item.text.trimStart().toLowerCase()
  return CONTEXTUAL_USER_PREFIXES.some((prefix) => text.startsWith(prefix))
}

function truncateRetainedMessages(items: readonly Record<string, unknown>[]) {
  let remaining = RETAINED_MESSAGE_TOKEN_BUDGET
  const result: Record<string, unknown>[] = []
  for (const item of items.toReversed()) {
    if (remaining <= 0) continue
    const tokens = Math.max(1, Token.estimate(JSON.stringify(item)))
    if (tokens <= remaining) {
      result.push(item)
      remaining -= tokens
      continue
    }
    const truncated = truncateMessage(item, remaining)
    if (truncated) result.push(truncated)
    remaining = 0
  }
  return result.reverse()
}

function truncateMessage(item: Record<string, unknown>, tokens: number): Record<string, unknown> | undefined {
  if (item.role !== "user" || !Array.isArray(item.content)) return undefined
  let remainingChars = Math.max(0, tokens * 4)
  const content = item.content.flatMap((part) => {
    if (!isRecord(part)) return []
    if (part.type !== "input_text" || typeof part.text !== "string") return [part]
    if (remainingChars <= 0) return []
    const text = part.text.slice(0, remainingChars)
    remainingChars -= text.length
    return text ? [{ ...part, text }] : []
  })
  if (content.length === 0) return undefined
  return { ...item, content }
}

export * as OpenAINativeCompaction from "./openai-native-compaction"
