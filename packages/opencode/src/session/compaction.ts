import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { Cause, Effect, Layer, Context } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt as buildEnglishPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { LLM } from "./llm"
import type { TurnState } from "./llm/native-runtime"
import { OpenAINativeCompaction } from "./openai-native-compaction"
import PROMPT_COMPACTION from "@/agent/prompt/compaction.txt"
import PROMPT_COMPACTION_ZH from "@/agent/prompt/compaction.zh.txt"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000
const CHINESE_CHARACTER = /[\u3400-\u9fff\uf900-\ufaff]/u
type SummaryLanguage = "en" | "zh"

const CHINESE_SUMMARY_TEMPLATE = `请严格输出 <template> 中展示的 Markdown 结构，并保持章节顺序不变。回复中不要包含 <template> 标签。
<template>
## 目标
- [用一两句简短的话说明用户希望完成什么]

## 重要细节
- [约束或偏好、决策及原因、重要事实或假设、继续工作所需的准确上下文，或“（无）”]

## 工作状态
### 已完成
- [已经完成的工作、已验证的事实或已经实施的修改；否则为“（无）”]

### 进行中
- [当前工作、部分完成的修改或调查状态；否则为“（无）”]

### 受阻
- [阻塞事项、失败的命令或未知问题；否则为“（无）”]

## 下一步
1. [立即要执行的具体动作，或“（无）”]
2. [已知时列出之后的动作，或“（无）”]

## 相关文件
- [文件或目录路径：重要原因，或“（无）”]
</template>

规则：
- 保留每个章节，即使为空。
- 使用简短要点，不要写成散文段落。
- 已知时保留准确的文件路径、符号、命令、错误字符串、URL 和标识符。
- 不要提及摘要过程或上下文已被压缩。`

const CHINESE_SUMMARY_UPDATE_INSTRUCTIONS = `<prior-summary> 概括了 <conversation> 之前发生的一切。请构建一个合并两者的新摘要。之后 <prior-summary> 将被丢弃：任何未写入新摘要的内容都会丢失。

合并时：
- 即使 <conversation> 没有提及，也要保留 <prior-summary> 中的目标、约束、用户指示、决策和并行工作流。仅删除已经完成且不再需要的内容。
- <conversation> 比 <prior-summary> 更新。如果二者冲突，以对话为准：写出更正后的事实并删除旧说法。
- 加入对话中的新进展、决策、约束和上下文。
- 将已完成的工作从“进行中”移到“已完成”。
- 如果阻塞已解决，更新摘要以反映这一点，同时保留继续工作仍需的细节。
- 更新“目标”和“下一步”以反映当前工作状态。`
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

const serialize = (message: SessionV1.WithParts) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : truncate([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function buildPrompt(input: { previousSummary?: string; context: string[]; language: SummaryLanguage }) {
  if (input.language === "en") {
    return buildEnglishPrompt({ previousSummary: input.previousSummary, context: input.context })
  }
  const conversation = `以下是目前的对话：\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`
  if (!input.previousSummary) {
    return [
      conversation,
      "请根据上面 <conversation> 标签中的对话历史创建新的锚定摘要，以便另一个编码代理继续工作。",
      CHINESE_SUMMARY_TEMPLATE,
    ].join("\n\n")
  }
  return [
    conversation,
    `以下是上述 <conversation> 之前对话的摘要：\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    CHINESE_SUMMARY_UPDATE_INSTRUCTIONS,
    CHINESE_SUMMARY_TEMPLATE,
  ].join("\n\n")
}

function promptLanguage(messages: SessionV1.WithParts[]): SummaryLanguage {
  return messages
    .filter((msg) => msg.info.role === "user" && !msg.parts.some((part) => part.type === "compaction"))
    .slice(-3)
    .some((msg) => msg.parts.some((part) => part.type === "text" && CHINESE_CHARACTER.test(part.text)))
    ? "zh"
    : "en"
}

function localizeAgent(input: { agent: Agent.Info; language: SummaryLanguage }) {
  if (input.language !== "zh") return input.agent
  if (input.agent.prompt !== PROMPT_COMPACTION) return input.agent
  return { ...input.agent, prompt: PROMPT_COMPACTION_ZH }
}

function autoContinueText(input: { overflow: boolean; language: SummaryLanguage }) {
  const overflow = input.overflow
    ? input.language === "zh"
      ? "上一请求由于大型媒体附件超过了提供商的大小限制。对话已被压缩，媒体文件已从上下文中移除。如果用户询问的是附加图片或文件，请说明附件太大无法处理，并建议他们使用更小或更少的文件重试。\n\n"
      : "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
    : ""
  return (
    overflow +
    (input.language === "zh"
      ? "如果你有下一步，请继续；如果你不确定如何进行，请停止并请求澄清。"
      : "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.")
  )
}

function nativeErrorMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  if (error instanceof Error) return error.message
  return String(error)
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
    turnState?: TurnState
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const llm = yield* LLM.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const prepareMessages = Effect.fn("SessionCompaction.prepareMessages")(function* (input: {
      history: SessionV1.WithParts[]
      hidden: ReadonlySet<number>
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const selected = yield* select({
        messages: input.history.filter((_, index) => !input.hidden.has(index)),
        cfg: input.cfg,
        model: input.model,
      })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const conversation = msgs.map(serialize).filter(Boolean).join("\n\n")
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, input.model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const tailIndex = selected.tail_start_id
        ? input.history.findIndex((message) => message.info.id === selected.tail_start_id)
        : -1
      const recent =
        tailIndex < 0
          ? ""
          : JSON.stringify(
              yield* MessageV2.toModelMessagesEffect(input.history.slice(tailIndex), input.model, {
                stripMedia: true,
                toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
              }),
            )
      return { selected, modelMessages, conversation, recent }
    })

    const assistantMessage = (input: {
      parentID: MessageID
      sessionID: SessionID
      userMessage: SessionV1.User
      model: Provider.Model
      ctx: { directory: string; worktree: string }
      completed: boolean
    }): SessionV1.Assistant => {
      const created = Date.now()
      return {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: input.userMessage.model.variant,
        summary: true,
        path: {
          cwd: input.ctx.directory,
          root: input.ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: input.model.id,
        providerID: input.model.providerID,
        time: input.completed ? { created, completed: created } : { created },
        ...(input.completed ? { finish: "stop" as const } : {}),
      }
    }

    const nativeSkipReason = (input: {
      model: Provider.Model
      compacting: { readonly context: readonly unknown[]; readonly prompt: string | undefined }
    }) =>
      !OpenAINativeCompaction.supportsModel(input.model)
        ? "model is not official OpenAI Responses"
        : input.compacting.prompt !== undefined || input.compacting.context.length > 0
          ? "compaction plugin customized prompt/context"
          : undefined

    const tryNativeCompaction = Effect.fn("SessionCompaction.tryOpenAINative")(function* (input: {
      sessionID: SessionID
      userMessage: SessionV1.User
      compactionAgent: Agent.Info
      chatModel: Provider.Model
      nativeCompactionWindow?: OpenAINativeCompaction.Window
      turnState?: TurnState
      history: SessionV1.WithParts[]
      hidden: ReadonlySet<number>
      cfg: ConfigV1.Info
      compacting: { readonly context: readonly unknown[]; readonly prompt: string | undefined }
    }) {
      const skipReason = nativeSkipReason({ model: input.chatModel, compacting: input.compacting })
      if (skipReason) {
        yield* Effect.logInfo("openai native compaction skipped", {
          "session.id": input.sessionID,
          reason: skipReason,
          providerID: input.chatModel.providerID,
          modelID: input.chatModel.id,
          modelApiID: input.chatModel.api.id,
          modelApiNpm: input.chatModel.api.npm,
          pluginContextCount: input.compacting.context.length,
          pluginPrompt: input.compacting.prompt !== undefined,
        })
        return undefined
      }
      const prepared = yield* prepareMessages({
        history: input.history,
        hidden: input.hidden,
        cfg: input.cfg,
        model: input.chatModel,
      })
      const result = yield* Effect.gen(function* () {
        yield* Effect.logInfo("openai native compaction starting", {
          "session.id": input.sessionID,
          providerID: input.chatModel.providerID,
          modelID: input.chatModel.id,
          modelApiID: input.chatModel.api.id,
        })
        const compactResult = yield* llm.compact({
          user: input.userMessage,
          agent: input.compactionAgent,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          messages: prepared.modelMessages,
          model: input.chatModel,
          nativeCompactionWindow: input.nativeCompactionWindow,
          turnState: input.turnState,
        })
        return { ...compactResult, output: OpenAINativeCompaction.sanitizeOutput(compactResult.output) }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("openai native compaction failed; falling back to summary", {
            "session.id": input.sessionID,
            providerID: input.chatModel.providerID,
            modelID: input.chatModel.id,
            error: nativeErrorMessage(cause),
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (result === undefined) return undefined
      if (OpenAINativeCompaction.hasCompactionItem(result.output))
        return {
          output: result.output,
          window: OpenAINativeCompaction.buildReplacementWindow({
            compactInput: result.input,
            compactOutput: result.output,
          }),
          prepared,
        }
      yield* Effect.logWarning("openai native compaction returned no checkpoint; falling back to summary", {
        "session.id": input.sessionID,
        providerID: input.chatModel.providerID,
        modelID: input.chatModel.id,
        outputCount: result.output.length,
        outputTypes: result.output.map((item) => (typeof item.type === "string" ? item.type : "unknown")),
        outputShapes: result.output.map((item) => ({
          type: typeof item.type === "string" ? item.type : "unknown",
          keys: Object.keys(item).filter((key) => key !== "encrypted_content"),
          hasEncryptedContent: typeof item.encrypted_content === "string",
        })),
      })
      return undefined
    })

    const storeNativeCheckpoint = Effect.fn("SessionCompaction.storeOpenAINativeCheckpoint")(function* (input: {
      msg: SessionV1.Assistant
      userMessage: SessionV1.User
      chatModel: Provider.Model
      window: OpenAINativeCompaction.Window
    }) {
      yield* Effect.logInfo("openai native compaction checkpoint stored", {
        "session.id": input.msg.sessionID,
        providerID: input.chatModel.providerID,
        modelID: input.chatModel.id,
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: input.msg.id,
        sessionID: input.msg.sessionID,
        type: "text",
        text: OpenAINativeCompaction.PLACEHOLDER,
        metadata: OpenAINativeCompaction.metadata({
          model: {
            providerID: ProviderV2.ID.make(input.chatModel.providerID),
            modelID: ModelV2.ID.make(input.chatModel.id),
            ...(input.userMessage.model.variant === undefined ? {} : { variant: input.userMessage.model.variant }),
          },
          window: input.window,
        }),
        time: { start: Date.now(), end: Date.now() },
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID: input.msg.sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(Date.now()),
        model: {
          id: ModelV2.ID.make(input.chatModel.id),
          providerID: ProviderV2.ID.make(input.chatModel.providerID),
          variant: ModelV2.VariantID.make(input.userMessage.model.variant ?? "default"),
        },
      })
    })

    const runSummaryCompaction = Effect.fn("SessionCompaction.runSummary")(function* (input: {
      parentID: MessageID
      sessionID: SessionID
      userMessage: SessionV1.User
      compactionAgent: Agent.Info
      history: SessionV1.WithParts[]
      hidden: ReadonlySet<number>
      cfg: ConfigV1.Info
      model: Provider.Model
      ctx: { directory: string; worktree: string }
      previousSummary?: string
      language: SummaryLanguage
      compacting: { readonly context: readonly unknown[]; readonly prompt: string | undefined }
    }) {
      const prepared = yield* prepareMessages({
        history: input.history,
        hidden: input.hidden,
        cfg: input.cfg,
        model: input.model,
      })
      const prompt =
        input.compacting.prompt ??
        [
          buildPrompt({
            previousSummary: input.previousSummary,
            context: [prepared.conversation],
            language: input.language,
          }),
          ...input.compacting.context,
        ]
          .filter(Boolean)
          .join("\n\n")
      const msg = assistantMessage({
        parentID: input.parentID,
        sessionID: input.sessionID,
        userMessage: input.userMessage,
        model: input.model,
        ctx: input.ctx,
        completed: false,
      })
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model: input.model,
      })
      const result = yield* processor.process({
        user: input.userMessage,
        agent: input.compactionAgent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: [
                  prompt,
                  ...(input.compacting.prompt
                    ? ["The following is the conversation history:", prepared.conversation]
                    : []),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
        ],
        model: input.model,
      })
      return { type: "summary" as const, msg, result, selected: prepared.selected, recent: prepared.recent }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      turnState?: TurnState
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")
      // Native compaction continues the active logical turn, so it must see that turn.
      // Summary fallback keeps the legacy behavior of removing and replaying it below.
      const nativeHistory =
        compactionPart && input.messages.at(-1)?.info.id === input.parentID
          ? input.messages.slice(0, -1)
          : input.messages

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const chatModel = yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : chatModel
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const nativePrior = nativeHistory === history ? prior : completedCompactions(nativeHistory)
      const nativeHidden =
        nativeHistory === history ? hidden : new Set(nativePrior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const language = promptLanguage(replay ? [...history, { info: replay.info, parts: replay.parts }] : history)
      const compactionAgent = localizeAgent({ agent, language })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const ctx = yield* InstanceState.context
      const priorCheckpoint = OpenAINativeCompaction.findCheckpoint(nativeHistory)
      const native = yield* tryNativeCompaction({
        sessionID: input.sessionID,
        userMessage,
        compactionAgent,
        chatModel,
        nativeCompactionWindow: priorCheckpoint ? OpenAINativeCompaction.replayWindow({ checkpoint: priorCheckpoint }) : undefined,
        turnState: input.turnState,
        history: nativeHistory,
        hidden: nativeHidden,
        cfg,
        compacting,
      })
      const outcome = native
        ? yield* Effect.gen(function* () {
            const msg = assistantMessage({
              parentID: input.parentID,
              sessionID: input.sessionID,
              userMessage,
              model: chatModel,
              ctx,
              completed: true,
            })
            yield* session.updateMessage(msg)
            yield* storeNativeCheckpoint({ msg, userMessage, chatModel, window: native.window })
            return {
              type: "native" as const,
              msg,
              result: "continue" as const,
              selected: native.prepared.selected,
              recent: native.prepared.recent,
              output: native.output,
            }
          })
        : yield* runSummaryCompaction({
            parentID: input.parentID,
            sessionID: input.sessionID,
            userMessage,
            compactionAgent,
            history,
            hidden,
            cfg,
            model,
            ctx,
            previousSummary,
            language,
            compacting,
          })

      const msg = outcome.msg
      const result = outcome.result

      if (result === "compact") {
        msg.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        msg.finish = "error"
        yield* session.updateMessage(msg)
        return "stop"
      }

      if (
        compactionPart &&
        outcome.selected.tail_start_id &&
        compactionPart.tail_start_id !== outcome.selected.tail_start_id
      ) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: outcome.selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay && outcome.type !== "native") {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay && outcome.type !== "native") {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text = autoContinueText({ overflow: input.overflow === true, language })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (msg.error) return "stop"
      if (result === "continue") {
        const summary =
          outcome.type === "native"
            ? OpenAINativeCompaction.PLACEHOLDER
            : summaryText(
                (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
                  (item) => item.info.id === msg.id,
                ) ?? {
                  info: msg,
                  parts: [],
                },
              )
        if (flags.experimentalEventSystem) {
          if (summary)
            yield* events.publish(SessionEvent.Compaction.Ended, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.make(input.parentID),
              timestamp: DateTime.makeUnsafe(Date.now()),
              reason: input.auto ? "auto" : "manual",
              text: summary ?? "",
              recent: outcome.recent,
            })
        }
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    LLM.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

export * as SessionCompaction from "./compaction"
