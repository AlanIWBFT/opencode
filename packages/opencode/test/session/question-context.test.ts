import { describe, expect, test } from "bun:test"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { SessionQuestionContext } from "@/session/question-context"
import { OpenAINativeCompaction } from "@/session/openai-native-compaction"
import { MessageID, PartID } from "@/session/schema"

const question = {
  header: "Redundant header",
  question: "What should we keep?",
  options: [
    { label: "Code", description: "Preserve source files" },
    { label: "Logs", description: "Preserve diagnostic output" },
    { label: "Cache", description: "Preserve downloaded packages" },
  ],
}

function restore(questions: (typeof QuestionV1.Info.Type)[], answers: (typeof QuestionV1.Answer.Type)[]) {
  const messages = SessionQuestionContext.messages({
    summaryID: MessageID.make("msg_summary"),
    entries: [{ partID: PartID.make("prt_question"), time: 0, questions, answers }],
  }, [])
  expect(messages).toHaveLength(1)
  expect(messages[0].role).toBe("user")
  if (typeof messages[0].content !== "string") throw new Error("Expected a text restoration block")
  return messages[0].content
}

describe("question context rendering", () => {
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
    const text = restore([question, { ...question, question: "What should we archive?", multiple: true }], [["Code"], ["Cache", "Logs"]])
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
    const text = restore([{ ...question, options: [question.options[0], { label: "Code", description: "Different scope" }, question.options[1]] }], [["Code"]])
    expect(text).toContain("Different scope")
    expect(text).toContain("diagnostic output")
  })

  test("preserves multiline custom replies without JSON escaping or truncation", () => {
    const answer = `Keep this exact command:\n  tool --path "C:\\work"\n${"context\n".repeat(500)}Do not restart.`
    expect(restore([question], [[answer]])).toContain(`A: ${answer}`)
  })

  test("keeps the baseline option for a cumulative cleanup selection", () => {
    const text = restore([{
      header: "Cleanup",
      question: "应清理哪些旧用例？",
      options: [
        { label: "索引和高级回放", description: "删除 index.html、advanced-replay.*、对应工具和数据。" },
        { label: "再删旧叠加模式", description: "同时删除 overlay 的历史隔离模式，仅留标准模式。" },
      ],
    }], [["再删旧叠加模式"]])
    expect(text).toContain("index.html、advanced-replay.*")
    expect(text).toContain("A: 再删旧叠加模式")
  })

  test.each(["Same as the first option, with tracing", "Code with tracing", "与前一项相同，但保留日志"])(
    "keeps referenced options for description: %s", (description) => {
      const text = restore([{ ...question, options: [question.options[0], { label: "Custom", description }] }], [["Custom"]])
      expect(text).toContain("Code: Preserve source files")
    },
  )

  test("keeps all options when the question itself uses ordinal references", () => {
    expect(restore([{ ...question, question: "选择第二个还是第三个选项？" }], [["Logs"]])).toContain("Preserve downloaded packages")
  })

  test("native replacement windows discard the derived restoration block", () => {
    const restored = restore([question], [["Code"]])
    const user = { role: "user", content: [{ type: "input_text", text: "Continue the task" }] }
    const checkpoint = { type: "compaction", encrypted_content: "opaque" }
    const window = OpenAINativeCompaction.buildReplacementWindow({
      compactInput: [user, { role: "user", content: [{ type: "input_text", text: restored }] }],
      compactOutput: [checkpoint],
    })
    expect(window.output).toEqual([user, checkpoint])
  })
})
