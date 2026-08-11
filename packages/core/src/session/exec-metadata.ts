import { Schema } from "effect"
import { castDraft, produce, type WritableDraft } from "immer"
import { SessionExec } from "@opencode/schema/session-exec"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"

/** A copied transcript preserves command output, not ownership of the source's live processes. */
export function detachExecMetadata(message: SessionMessage.Info) {
  if (message.type !== "assistant") return message
  return produce(message, (draft) => {
    const error = "Historical command copy: no live execution belongs to this session."
    for (const part of draft.content) {
      if (part.type !== "tool" || part.state.status === "streaming") continue
      const metadata = part.state.metadata
      if (part.name === "exec_command" && metadata?.processRunning === true) {
        metadata.processRunning = false
        metadata.execError = error
      }
      if (part.name !== "execute" || !Array.isArray(metadata?.toolCalls)) continue
      metadata.toolCalls = metadata.toolCalls.map((call) => {
        if (!Schema.is(Tool.ChildCall)(call) || call.name !== "exec_command" || call.metadata?.processRunning !== true)
          return call
        return castDraft({ ...call, metadata: { ...call.metadata, processRunning: false, execError: error } })
      })
    }
  })
}

export function applyScriptMetadata(
  assistant: WritableDraft<SessionMessage.Assistant>,
  snapshot: SessionExec.ScriptSnapshot,
) {
  if (assistant.id !== snapshot.assistantMessageID) return
  const tool = assistant.content.findLast((item) => item.type === "tool" && item.id === snapshot.id)
  if (!tool || tool.type !== "tool" || tool.name !== "execute" || tool.state.status === "streaming") return
  const revision = tool.state.metadata?.codeModeRevision
  if (typeof revision === "number" && revision >= snapshot.revision) return
  const previous = tool.state.metadata?.toolCalls
  const calls = snapshot.toolCalls.map((call) => {
    if (!Array.isArray(previous)) return call
    const original = previous.find((item) => Schema.is(Tool.ChildCall)(item) && item.id === call.id)
    if (!Schema.is(Tool.ChildCall)(original)) return call
    const revision = original.metadata?.execRevision
    if (typeof revision !== "number" || revision <= Number(call.metadata?.execRevision ?? 0)) return call
    return { ...call, metadata: { ...call.metadata, ...original.metadata } }
  })
  tool.state.metadata = castDraft({ ...tool.state.metadata, toolCalls: calls, codeModeRevision: snapshot.revision })
}

/** Updates presentation metadata without adding model calls or changing tool results. */
export function applyExecMetadata(assistant: WritableDraft<SessionMessage.Assistant>, snapshot: SessionExec.Snapshot) {
  if (assistant.id !== snapshot.assistantMessageID) return
  const tool = assistant.content.findLast((item) => item.type === "tool" && item.id === snapshot.id)
  if (!tool || tool.type !== "tool" || tool.state.status === "streaming") return
  const metadata = {
    ...Schema.encodeSync(SessionExec.Metadata)(snapshot.metadata),
    execRevision: snapshot.revision,
  }
  if (snapshot.childID === undefined) {
    if (tool.name !== "exec_command") return
    const revision = tool.state.metadata?.execRevision
    if (typeof revision === "number" && revision >= snapshot.revision) return
    tool.state.metadata = castDraft({ ...tool.state.metadata, ...metadata })
    return
  }
  if (tool.name !== "execute") return
  const calls = tool.state.metadata?.toolCalls
  if (!Array.isArray(calls)) return
  const index = calls.findIndex((call) => Schema.is(Tool.ChildCall)(call) && call.id === snapshot.childID)
  const call = calls[index]
  if (!Schema.is(Tool.ChildCall)(call) || call.name !== "exec_command") return
  const revision = call.metadata?.execRevision
  if (typeof revision === "number" && revision >= snapshot.revision) return
  calls[index] = castDraft({ ...call, metadata: { ...call.metadata, ...metadata } })
}
