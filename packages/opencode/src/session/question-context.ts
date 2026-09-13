import { SessionV1 } from "@opencode-ai/core/v1/session"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import type { ModelMessage } from "ai"
import { Effect, Schema } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { MessageID, PartID } from "./schema"

const decodeQuestions = Schema.decodeUnknownSync(Schema.Struct({ questions: Schema.Array(QuestionV1.Info) }))
const decodeAnswers = Schema.decodeUnknownSync(QuestionV1.Reply)

// Best-effort references, not semantic classification. False positives only
// retain more options. Custom answers never need this heuristic.
const OPTION_REFERENCES = [
  /同上|上述|前者|后者|两者|二者|在此基础|(?:其他|其它|另一)(?:个)?选项|(?:再|同时)(?:加|增|删|移除|保留|含)/u,
  /(?:与|和|跟)[^\n。；]{0,40}(?:相同|一样|一致)|(?:选项|方案)\s*[A-Z\d]|第[一二三四五六七八九十\d]+(?:个|项|种)/iu,
  /\b(?:same as|as above|former|latter|both|neither|in addition|on top of|also|option\s+[a-z\d]|(?:first|second|third) option)\b/iu,
]

export type Cache = {
  summaryID: MessageID
  entries: {
    partID: PartID
    time: number
    questions: typeof QuestionV1.Info.Type[]
    answers: typeof QuestionV1.Answer.Type[]
  }[]
}

// The transcript remains authoritative after compaction, pruning, restart, fork,
// and revert. Read it once per checkpoint per drain, rather than persisting a
// second copy of user decisions or scanning full history on every tool step.
export const load = Effect.fn("SessionQuestionContext.load")(function* (
  compacted: SessionV1.WithParts[],
  previous?: Cache,
) {
  const markers = new Set(
    compacted.flatMap((message) =>
      message.info.role === "user" && message.parts.some((part) => part.type === "compaction") ? [message.info.id] : [],
    ),
  )
  const summary = compacted
    .map((message) => message.info)
    .filter(
      (info): info is SessionV1.Assistant =>
        info.role === "assistant" && !!info.summary && !!info.finish && !info.error && markers.has(info.parentID),
    )
    .toSorted(MessageV2.compareOrder)
    .at(-1)
  if (!summary) return undefined
  if (previous?.summaryID === summary.id) return previous

  const session = yield* Session.Service
  const history = yield* session.messages({ sessionID: summary.sessionID }).pipe(Effect.orDie)
  const boundary = history.findIndex((message) => message.info.id === summary.parentID)
  if (boundary < 0) throw new Error(`Question context compaction marker missing: ${summary.parentID}`)
  return {
    summaryID: summary.id,
    entries: history.slice(0, boundary).flatMap((message) => {
      if (message.info.role !== "assistant") return []
      return message.parts.flatMap((part) => {
        if (part.type !== "tool" || part.tool !== "question" || part.state.status !== "completed") return []
        return [
          {
            partID: part.id,
            time: part.state.time.end,
            questions: [...decodeQuestions(part.state.input).questions],
            answers: [...decodeAnswers(part.state.metadata).answers],
          },
        ]
      })
    }),
  } satisfies Cache
})

export function messages(cache: Cache | undefined, active: SessionV1.WithParts[]): ModelMessage[] {
  if (!cache) return []
  const visible = new Set(
    active.flatMap((message) => {
      if (message.info.role !== "assistant") return []
      // Match model-message conversion: failed assistant messages are omitted,
      // except aborted turns with completed tool results.
      if (message.info.error && !SessionV1.AbortedError.isInstance(message.info.error)) return []
      return message.parts.flatMap((part) =>
        part.type === "tool" && part.tool === "question" && part.state.status === "completed" &&
          !part.state.time.compacted && part.state.metadata.truncated !== true
          ? [part.id]
          : [],
      )
    }),
  )
  const entries = cache.entries.filter((entry) => !visible.has(entry.partID))
  if (!entries.length) return []
  return [
    {
      role: "user",
      content: [
        "<restored-question-context>",
        "Historical user replies, in conversation order. Q/options are assistant-authored; A is the user's verbatim reply, not necessarily a decision. " +
          "Preserve its scope; later user corrections take precedence. Use silently as background, not as a new task.",
        ...entries.map((entry) => [
          `### ${new Date(entry.time).toISOString()}`,
          ...entry.questions.map((question, index) => renderQuestion(question, entry.answers[index] ?? [])),
        ].join("\n\n")),
        "</restored-question-context>",
      ].join("\n\n"),
    },
  ]
}

function renderQuestion(question: typeof QuestionV1.Info.Type, answers: typeof QuestionV1.Answer.Type) {
  const exact = answers.length > 0 && answers.every((answer) => question.options.filter((option) => option.label === answer).length === 1)
  const selected = question.options.filter((option) => answers.includes(option.label))
  const context = [question.question, ...selected.flatMap((option) => [option.label, option.description])].join("\n")
  const referenced = OPTION_REFERENCES.some((pattern) => pattern.test(context)) || question.options.some((option) =>
    !answers.includes(option.label) && option.label.length > 1 && context.includes(option.label),
  )
  const options = exact && !referenced ? selected : question.options
  return [
    `Q: ${question.question}`,
    ...(options.length ? [
      `${options === selected ? "Selected options" : "Options"}:\n${options.map((option) => `- ${option.label}: ${option.description}`).join("\n")}`,
    ] : []),
    answers.length === 0 ? "A: [Unanswered]" : answers.length === 1 ? `A: ${answers[0]}` : `A (multiple):\n${answers.map((answer) => `- ${answer}`).join("\n")}`,
  ].join("\n")
}

export * as SessionQuestionContext from "./question-context"
