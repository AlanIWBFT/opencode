import { describe, expect, test } from "bun:test"
import { Question } from "@opencode/schema/question"
import { Message, ToolCallPart, ToolResultPart } from "@opencode/ai"
import { SessionQuestionContext } from "@opencode/core/session/question-context"
import { SessionMessage } from "@opencode/core/session/message"
import { Schema } from "effect"

const question = {
  header: "Redundant header",
  question: "What should we keep?",
  options: [
    { label: "Code", description: "Preserve source files" },
    { label: "Logs", description: "Preserve diagnostic output" },
    { label: "Cache", description: "Preserve downloaded packages" },
  ],
}

function cache(questions: Question.Prompt[], answers: Question.Answer[]): SessionQuestionContext.Cache {
  return {
    summaryID: SessionMessage.ID.create(),
    entries: [
      {
        type: "question",
        toolID: "call_question",
        time: 0,
        questions,
        answers,
        input: { questions },
        content: [{ type: "text", text: JSON.stringify({ answers }) }],
        truncated: false,
      },
    ],
  }
}

function restore(questions: Question.Prompt[], answers: Question.Answer[]) {
  const messages = SessionQuestionContext.messages(cache(questions, answers), [])
  expect(messages).toHaveLength(1)
  expect(messages[0].role).toBe("user")
  const content = messages[0].content[0]
  if (content.type !== "text") throw new Error("Expected a text restoration block")
  return content.text
}

describe("question context rendering", () => {
  test.each([
    { label: "legacy input title", inputTitle: "Choose a layout", resolvedTitle: undefined },
    { label: "resolved title without input title", inputTitle: undefined, resolvedTitle: "Choose a layout" },
    { label: "resolved title precedence", inputTitle: "Old input title", resolvedTitle: "Choose a layout" },
  ])("restores page choices using $label without HTML and deduplicates intact calls", ({ inputTitle, resolvedTitle }) => {
    const input = {
      request: {
        action: "render.page",
        ...(inputTitle ? { title: inputTitle } : {}),
        html: "<html>private layout markup</html>",
        awaitAnswer: true,
      },
    }
    const answer = { answered: true, summary: "Two columns", data: { columns: 2, note: "保留侧栏" } }
    const message = Schema.decodeUnknownSync(SessionMessage.Info)({
      id: "msg_page",
      type: "assistant",
      agent: "build",
      model: { providerID: "openai", id: "test" },
      time: { created: 0 },
      content: [
        {
          type: "tool",
          id: "call_page",
          name: "openchamber_render",
          time: { created: 0, completed: 1 },
          state: {
            status: "completed",
            input,
            content: [{ type: "text", text: JSON.stringify({ answer }) }],
            metadata: { openchamber: { action: "render.page", ok: true, answer, ...(resolvedTitle ? { title: resolvedTitle } : {}) } },
          },
        },
      ],
    })
    const entries = SessionQuestionContext.entries(message)
    expect(entries).toHaveLength(1)
    const saved = { summaryID: SessionMessage.ID.create(), entries }
    const restored = JSON.stringify(SessionQuestionContext.messages(saved, []))
    expect(restored).toContain("Choose a layout")
    expect(restored).toContain("Two columns")
    expect(restored).toContain("保留侧栏")
    expect(restored).toContain("page-generated, not verbatim user text")
    expect(restored).not.toContain("private layout markup")
    const entry = entries[0]
    const call = Message.make({
      role: "assistant",
      content: [ToolCallPart.make({ id: entry.toolID, name: "openchamber_render", input })],
    })
    const result = Message.tool(
      ToolResultPart.make({
        id: entry.toolID,
        name: "openchamber_render",
        resultType: "content",
        result: entry.content,
      }),
    )
    expect(SessionQuestionContext.messages(saved, [call, result])).toEqual([])
    expect(SessionQuestionContext.messages(saved, [call])).toHaveLength(1)
  })

  test.each([undefined, { answered: false, reason: "chat" }])(
    "does not restore pages without a submitted answer: %j",
    (answer) => {
      const message = Schema.decodeUnknownSync(SessionMessage.Info)({
        id: "msg_page",
        type: "assistant",
        agent: "build",
        model: { providerID: "openai", id: "test" },
        time: { created: 0 },
        content: [
          {
            type: "tool",
            id: "call_page",
            name: "openchamber_render",
            time: { created: 0 },
            state: {
              status: "completed",
              input: { request: { title: "A page" } },
              content: [{ type: "text", text: "closed" }],
              metadata: { openchamber: { action: "render.page", ok: true, ...(answer ? { answer } : {}) } },
            },
          },
        ],
      })
      expect(SessionQuestionContext.entries(message)).toEqual([])
    },
  )

  test("omits unselected options and redundant headers for an exact choice", () => {
    const text = restore([question], [["Code"]])
    expect(text).toContain("Q: What should we keep?")
    expect(text).toContain("Selected options:\n- Code: Preserve source files\nA: Code")
    expect(text).not.toContain("diagnostic output")
    expect(text).not.toContain("downloaded packages")
    expect(text).not.toContain("Redundant header")
    expect(text).toContain("not necessarily a decision")
  })

  test("keeps each question paired with its answer and preserves multiple selections", () => {
    const text = restore(
      [question, { ...question, question: "What should we archive?", multiple: true }],
      [["Code"], ["Cache", "Logs"]],
    )
    expect(text).toContain("A: Code\n\nQ: What should we archive?")
    expect(text).toContain("A (multiple):\n- Cache\n- Logs")
    expect(text.match(/1970-01-01T00:00:00.000Z/g)).toHaveLength(1)
  })

  test.each([
    ["comparison", ["Code, but use the Logs retention policy"]],
    ["mixed selection", ["Code", "First explain the tradeoffs"]],
    ["case mismatch", ["code"]],
    ["empty answer", []],
  ])("keeps all options for %s", (_name, answers) => {
    const text = restore([question], [answers])
    for (const option of question.options) expect(text).toContain(option.description)
    for (const answer of answers) expect(text).toContain(answer)
    if (!answers.length) expect(text).toContain("A: [Unanswered]")
  })

  test("does not treat duplicate option labels as an unambiguous choice", () => {
    const text = restore(
      [
        {
          ...question,
          options: [question.options[0], { label: "Code", description: "Different scope" }, question.options[1]],
        },
      ],
      [["Code"]],
    )
    expect(text).toContain("Different scope")
    expect(text).toContain("diagnostic output")
  })

  test("preserves multiline custom replies without JSON escaping or truncation", () => {
    const answer = `Keep this exact command:\n  tool --path "C:\\work"\n${"context\n".repeat(500)}Do not restart.`
    expect(restore([question], [[answer]])).toContain(`A: ${answer}`)
  })

  test("keeps the baseline option for a cumulative cleanup selection", () => {
    const text = restore(
      [
        {
          header: "Cleanup",
          question: "应清理哪些旧用例？",
          options: [
            { label: "索引和高级回放", description: "删除 index.html、advanced-replay.*、对应工具和数据。" },
            { label: "再删旧叠加模式", description: "同时删除 overlay 的历史隔离模式，仅留标准模式。" },
          ],
        },
      ],
      [["再删旧叠加模式"]],
    )
    expect(text).toContain("index.html、advanced-replay.*")
    expect(text).toContain("A: 再删旧叠加模式")
  })

  test.each(["Same as the first option, with tracing", "Code with tracing", "与前一项相同，但保留日志"])(
    "keeps referenced options for description: %s",
    (description) => {
      const text = restore(
        [{ ...question, options: [question.options[0], { label: "Custom", description }] }],
        [["Custom"]],
      )
      expect(text).toContain("Code: Preserve source files")
    },
  )

  test("keeps all options when the question itself uses ordinal references", () => {
    expect(restore([{ ...question, question: "选择第二个还是第三个选项？" }], [["Logs"]])).toContain(
      "Preserve downloaded packages",
    )
  })

  test("deduplicates only intact structured exchanges, including native retained tool results", () => {
    const saved = cache([question], [["Code"]])
    const entry = saved.entries[0]
    const call = Message.make({
      role: "assistant",
      content: [ToolCallPart.make({ id: entry.toolID, name: "question", input: entry.input })],
    })
    const result = Message.tool(
      ToolResultPart.make({ id: entry.toolID, name: "question", resultType: "content", result: entry.content }),
    )
    expect(SessionQuestionContext.messages(saved, [call, result])).toEqual([])
    expect(SessionQuestionContext.messages(saved, [result])).toHaveLength(1)
    const partial = Message.tool(
      ToolResultPart.make({
        id: entry.toolID,
        name: "question",
        resultType: "content",
        result: [{ type: "text", text: "[truncated]" }],
      }),
    )
    expect(SessionQuestionContext.messages(saved, [call, partial])).toHaveLength(1)
    expect(
      SessionQuestionContext.messages({ ...saved, entries: [{ ...entry, truncated: true }] }, [call, result]),
    ).toHaveLength(1)
  })

  test("does not infer intact answers from summary prose", () => {
    const saved = cache([question], [["Code"]])
    expect(SessionQuestionContext.messages(saved, [Message.user(restore([question], [["Code"]]))])).toHaveLength(1)
  })
})
