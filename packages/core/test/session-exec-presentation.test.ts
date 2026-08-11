import { expect } from "bun:test"
import { Effect, Fiber, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { EventTable } from "@opencode/core/event/sql"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionExecPresentation } from "@opencode/core/session/exec-presentation"
import { SessionExecSnapshots } from "@opencode/core/session/exec-snapshots"
import { SessionStore } from "@opencode/core/session/store"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { SessionExec } from "@opencode/schema/session-exec"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { testEffect } from "./lib/effect"
import { LayerNode } from "@opencode/util/effect/layer-node"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionExecPresentation.node,
      SessionExecSnapshots.node,
      SessionStore.node,
      Database.node,
      Bus.node,
    ]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

for (const nested of [false, true])
  it.effect(
    `final preview survives ${nested ? "Script cancellation" : "command completion"} without rewriting model content or message order`,
    () =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const presentation = yield* SessionExecPresentation.Service
        const snapshots = yield* SessionExecSnapshots.Service
        const store = yield* SessionStore.Service
        const bus = yield* Bus.Service
        const sessionID = SessionID.make("ses_presentation")
        const assistantMessageID = SessionMessage.ID.make("msg_presentation")
        const id = Tool.CallID.make("call_presentation")
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "test",
            directory: "/project",
            version: "test",
          })
          .run()
        const encoded = Schema.encodeSync(SessionMessage.Assistant)(
          Schema.decodeUnknownSync(SessionMessage.Assistant)({
            id: assistantMessageID,
            type: "assistant",
            agent: "build",
            model: { providerID: "openai", id: "gpt" },
            time: { created: 1 },
            content: [
              {
                type: "tool",
                id,
                name: nested ? "execute" : "exec_command",
                time: { created: 1 },
                state: { status: "running", input: {}, metadata: {} },
              },
            ],
          }),
        )
        const { id: _, type, ...data } = encoded
        yield* db
          .insert(SessionMessageTable)
          .values({
            id: assistantMessageID,
            session_id: sessionID,
            type,
            seq: 7,
            time_created: 1,
            data,
          })
          .run()
        const metadata = Schema.decodeUnknownSync(SessionExec.Metadata)({
          command: "echo done",
          output: "running",
          interactions: [],
          processRunning: true,
          truncated: false,
          execDisplay: "root",
        })
        if (nested)
          yield* snapshots.save({
            kind: "script",
            snapshot: {
              sessionID,
              assistantMessageID,
              id,
              revision: 2,
              toolCalls: [
                {
                  id: "0",
                  tool: "$opencode.exec_command",
                  name: "exec_command",
                  status: "completed",
                  content: [{ type: "text", text: "Initial command result" }],
                  metadata,
                },
              ],
            },
          })
        const snapshot = {
          sessionID,
          assistantMessageID,
          id,
          ...(nested ? { childID: "0" } : {}),
          revision: 1,
          metadata,
        }
        yield* presentation.command(snapshot)
        yield* presentation.command({
          ...snapshot,
          revision: 2,
          metadata: { ...metadata, output: "done", processRunning: false, exitCode: 0 },
        })
        expect(yield* db.select().from(EventTable).all()).toHaveLength(0)
        const settled = yield* bus
          .subscribe(SessionEvent.Exec.Captured)
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
        if (nested)
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID,
            id,
            executed: false,
            error: { type: "tool.execution", message: "Script cancelled" },
            content: [{ type: "text", text: "Original model result" }],
          })
        if (!nested)
          yield* bus.publish(SessionEvent.Tool.Success, {
            sessionID,
            assistantMessageID,
            id,
            executed: false,
            content: [{ type: "text", text: "Original model result" }],
          })
        yield* Fiber.join(settled).pipe(Effect.timeout("2 seconds"))
        // Also joins any acknowledgement still in flight after the event was published.
        yield* presentation.checkpoint(sessionID)
        const stored = yield* store.message(assistantMessageID)
        expect(stored?.message).toMatchObject({
          content: [
            {
              state: {
                status: nested ? "error" : "completed",
                content: [{ type: "text", text: "Original model result" }],
                metadata: nested
                  ? {
                      toolCalls: [
                        {
                          id: "0",
                          status: "completed",
                          metadata: { output: "done", processRunning: false, execRevision: 2 },
                        },
                      ],
                    }
                  : { output: "done", processRunning: false, execRevision: 2 },
              },
            },
          ],
        })
        expect(yield* snapshots.list(sessionID)).toEqual([])
        const rows = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .all()
        expect(rows).toEqual([{ seq: 7 }])
        expect(yield* db.select().from(EventTable).all()).toHaveLength(nested ? 3 : 2)
      }),
  )
