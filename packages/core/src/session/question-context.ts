export * as SessionQuestionContext from "./question-context.js"

import { Message } from "@opencode/ai"
import { Question } from "@opencode/schema/question"
import { and, asc, eq, lt } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { Database } from "../database/database.js"
import { SessionHistory } from "./history.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { SessionMessageTable } from "./sql.js"

const decodeQuestions = Schema.decodeUnknownSync(Schema.Struct({ questions: Schema.Array(Question.Prompt) }))
const decodeAnswers = Schema.decodeUnknownSync(Schema.Struct({ answers: Schema.Array(Question.Answer) }))

// Best-effort references, not semantic classification. False positives only retain more options.
const OPTION_REFERENCES = [
  /同上|上述|前者|后者|两者|二者|在此基础|(?:其他|其它|另一)(?:个)?选项|(?:再|同时)(?:加|增|删|移除|保留|含)/u,
  /(?:与|和|跟)[^\n。；]{0,40}(?:相同|一样|一致)|(?:选项|方案)\s*[A-Z\d]|第[一二三四五六七八九十\d]+(?:个|项|种)/iu,
  /\b(?:same as|as above|former|latter|both|neither|in addition|on top of|also|option\s+[a-z\d]|(?:first|second|third) option)\b/iu,
]

export type Cache = {
  summaryID: SessionMessage.ID
  entries: {
    toolID: string
    time: number
    questions: readonly Question.Prompt[]
    answers: readonly Question.Answer[]
    input: SessionMessage.ToolStateCompleted["input"]
    content: SessionMessage.ToolStateCompleted["content"]
    truncated: boolean
  }[]
}

// The original transcript is authoritative. A caller owns this cache only for its current drain.
export const load = Effect.fn("SessionQuestionContext.load")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  active: readonly SessionMessage.Info[],
  previous?: Cache,
) {
  // The runner has already selected a checkpoint compatible with the current model.
  const summary = active.findLast((message) => message.type === "compaction" && message.status === "completed")
  if (!summary) return undefined
  if (previous?.summaryID === summary.id) return previous
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, summary.id)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* Effect.die(new Error(`Question context compaction marker missing: ${summary.id}`))
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        lt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const history = yield* Effect.forEach(rows, SessionHistory.decodeMessageRow).pipe(Effect.orDie)
  return {
    summaryID: summary.id,
    entries: history.flatMap((message) =>
      message.type !== "assistant"
        ? []
        : message.content.flatMap((part) => {
            if (part.type !== "tool" || part.name !== "question" || part.state.status !== "completed") return []
            return [
              {
                toolID: part.id,
                time: DateTime.toEpochMillis(part.time.completed ?? message.time.completed ?? message.time.created),
                questions: decodeQuestions(part.state.input).questions,
                answers: decodeAnswers(part.state.metadata).answers,
                input: part.state.input,
                content: part.state.content,
                truncated: part.state.metadata?.truncated === true,
              },
            ]
          }),
    ),
  } satisfies Cache
})

export function messages(cache: Cache | undefined, active: readonly Message[]): Message[] {
  if (!cache) return []
  const parts = active.flatMap((message) => message.content)
  const calls = new Map(
    parts.flatMap((part) =>
      part.type === "tool-call" && part.name === "question" ? [[part.id, part.input] as const] : [],
    ),
  )
  const results = new Map(
    parts.flatMap((part) =>
      part.type === "tool-result" && part.name === "question" && part.result.type === "content"
        ? [[part.id, part.result.value] as const]
        : [],
    ),
  )
  // Summary prose is not proof that the original question and verbatim answer remain intact.
  const entries = cache.entries.filter(
    (entry) =>
      entry.truncated ||
      !isDeepStrictEqual(calls.get(entry.toolID), entry.input) ||
      !isDeepStrictEqual(results.get(entry.toolID), entry.content),
  )
  if (!entries.length) return []
  return [
    Message.user(
      [
        "<restored-question-context>",
        "Historical user replies, in conversation order. Q/options are assistant-authored; A is the user's verbatim reply, not necessarily a decision. " +
          "Preserve its scope; later user corrections take precedence. Use silently as background, not as a new task.",
        ...entries.map((entry) =>
          [
            `### ${new Date(entry.time).toISOString()}`,
            ...entry.questions.map((question, index) => renderQuestion(question, entry.answers[index] ?? [])),
          ].join("\n\n"),
        ),
        "</restored-question-context>",
      ].join("\n\n"),
    ),
  ]
}

function renderQuestion(question: Question.Prompt, answers: Question.Answer) {
  const exact =
    answers.length > 0 &&
    answers.every((answer) => question.options.filter((option) => option.label === answer).length === 1)
  const selected = question.options.filter((option) => answers.includes(option.label))
  const context = [question.question, ...selected.flatMap((option) => [option.label, option.description])].join("\n")
  const referenced =
    OPTION_REFERENCES.some((pattern) => pattern.test(context)) ||
    question.options.some(
      (option) => !answers.includes(option.label) && option.label.length > 1 && context.includes(option.label),
    )
  const options = exact && !referenced ? selected : question.options
  return [
    `Q: ${question.question}`,
    ...(options.length
      ? [
          `${options === selected ? "Selected options" : "Options"}:\n${options.map((option) => `- ${option.label}: ${option.description}`).join("\n")}`,
        ]
      : []),
    answers.length === 0
      ? "A: [Unanswered]"
      : answers.length === 1
        ? `A: ${answers[0]}`
        : `A (multiple):\n${answers.map((answer) => `- ${answer}`).join("\n")}`,
  ].join("\n")
}
