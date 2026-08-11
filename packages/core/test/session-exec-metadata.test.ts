import { expect, test } from "bun:test"
import { Schema } from "effect"
import { produce } from "immer"
import { applyExecMetadata, applyScriptMetadata } from "@opencode/core/session/exec-metadata"
import { SessionExec } from "@opencode/schema/session-exec"
import { SessionMessage } from "@opencode/schema/session-message"

const assistant = (nested: boolean) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: "msg_exec",
    type: "assistant",
    agent: "build",
    model: { providerID: "openai", id: "gpt" },
    time: { created: 1, completed: 3 },
    content: [
      {
        type: "tool",
        id: "call_exec",
        name: nested ? "execute" : "exec_command",
        time: { created: 1, completed: 2 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: "Original model-visible result" }],
          metadata: nested
            ? {
                toolCalls: [
                  {
                    id: "0",
                    tool: "exec_command",
                    name: "exec_command",
                    status: "completed",
                    metadata: { processRunning: true },
                  },
                  {
                    id: "1",
                    tool: "read",
                    name: "read",
                    status: "completed",
                    content: [{ type: "text", text: "Sibling result" }],
                  },
                ],
              }
            : { processRunning: true },
        },
      },
    ],
  })

const snapshot = (nested: boolean) =>
  Schema.decodeUnknownSync(SessionExec.Snapshot)({
    sessionID: "ses_exec",
    assistantMessageID: "msg_exec",
    id: "call_exec",
    ...(nested ? { childID: "0" } : {}),
    revision: 2,
    metadata: {
      command: "echo done",
      output: "done",
      interactions: [],
      processRunning: false,
      exitCode: 0,
      truncated: false,
      execDisplay: "root",
    },
  })

for (const nested of [false, true]) {
  test(`exec metadata updates ${nested ? "a Script child" : "a direct command"} without rewriting model history`, () => {
    const before = assistant(nested)
    const next = produce(before, (draft) => applyExecMetadata(draft, snapshot(nested)))
    expect(next.content).toHaveLength(1)
    expect(next.time).toEqual(before.time)
    const tool = next.content[0]
    const original = before.content[0]
    if (
      tool.type !== "tool" ||
      original.type !== "tool" ||
      tool.state.status !== "completed" ||
      original.state.status !== "completed"
    )
      throw new Error("Expected completed tools")
    expect(tool.state.content).toEqual(original.state.content)
    expect(tool.state.input).toEqual(original.state.input)
    const metadata = tool.state.metadata!
    if (nested) {
      expect(metadata.toolCalls).toMatchObject([
        { id: "0", status: "completed", metadata: { output: "done", processRunning: false, execRevision: 2 } },
        { id: "1", content: [{ type: "text", text: "Sibling result" }] },
      ])
    } else expect(metadata).toMatchObject({ output: "done", processRunning: false, execRevision: 2 })
    expect(produce(next, (draft) => applyExecMetadata(draft, { ...snapshot(nested), revision: 1 }))).toBe(next)
  })
}

test("late command snapshots do not recreate removed calls or target another message", () => {
  const before = assistant(true)
  expect(produce(before, (draft) => applyExecMetadata(draft, { ...snapshot(true), childID: "missing" }))).toBe(before)
  expect(
    produce(before, (draft) =>
      applyExecMetadata(draft, {
        ...snapshot(true),
        assistantMessageID: SessionMessage.ID.make("msg_other"),
      }),
    ),
  ).toBe(before)
})

test("a later Script snapshot preserves newer command output while settling the child", () => {
  const before = assistant(true)
  const live = produce(before, (draft) => applyExecMetadata(draft, snapshot(true)))
  const script = Schema.decodeUnknownSync(SessionExec.ScriptSnapshot)({
    sessionID: "ses_exec",
    assistantMessageID: "msg_exec",
    id: "call_exec",
    revision: 3,
    toolCalls: [
      {
        id: "0",
        tool: "$opencode.exec_command",
        name: "exec_command",
        status: "completed",
        content: [{ type: "text", text: "Initial command return" }],
        metadata: { output: "old preview", processRunning: true, execRevision: 1 },
      },
    ],
  })
  const next = produce(live, (draft) => applyScriptMetadata(draft, script))
  const tool = next.content[0]
  expect(tool).toMatchObject({
    state: {
      status: "completed",
      content: [{ type: "text", text: "Original model-visible result" }],
      metadata: {
        codeModeRevision: 3,
        toolCalls: [
          {
            id: "0",
            status: "completed",
            content: [{ type: "text", text: "Initial command return" }],
            metadata: { output: "done", processRunning: false, execRevision: 2 },
          },
        ],
      },
    },
  })
  expect(next.time).toEqual(before.time)
  expect(produce(next, (draft) => applyScriptMetadata(draft, { ...script, revision: 2 }))).toBe(next)
  expect(produce(next, (draft) => applyScriptMetadata(draft, script))).toBe(next)
})

test("Script and command snapshots converge regardless of delivery order", () => {
  const before = assistant(true)
  const script = Schema.decodeUnknownSync(SessionExec.ScriptSnapshot)({
    sessionID: "ses_exec",
    assistantMessageID: "msg_exec",
    id: "call_exec",
    revision: 1,
    toolCalls: [{ id: "0", tool: "$opencode.exec_command", name: "exec_command", status: "completed" }],
  })
  const commandFirst = produce(before, (draft) => {
    applyExecMetadata(draft, snapshot(true))
    applyScriptMetadata(draft, script)
  })
  const scriptFirst = produce(before, (draft) => {
    applyScriptMetadata(draft, script)
    applyExecMetadata(draft, snapshot(true))
  })
  expect(commandFirst).toEqual(scriptFirst)
})
