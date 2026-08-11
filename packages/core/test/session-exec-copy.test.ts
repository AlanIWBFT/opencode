import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionExecSnapshots } from "@opencode/core/session/exec-snapshots"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { SessionTransfer } from "@opencode/core/session/transfer"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionExec } from "@opencode/schema/session-exec"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Session.node, SessionTransfer.node, SessionExecSnapshots.node, Database.node]),
    [Project.node.replace(globalProjectNode), SessionExecution.node.replace(SessionExecution.noopLayer)],
  ),
)

for (const nested of [false, true])
  it.effect(
    `fork and import preserve latest ${nested ? "Script child" : "command"} output without claiming its process`,
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const transfer = yield* SessionTransfer.Service
        const snapshots = yield* SessionExecSnapshots.Service
        const db = (yield* Database.Service).db
        const parent = yield* sessions.create({ location: { directory: AbsolutePath.make("/project") } })
        const messageID = SessionMessage.ID.create()
        const callID = Tool.CallID.make("command")
        const metadata: SessionExec.Metadata = {
          command: "long command",
          output: "initial",
          interactions: [],
          processRunning: true,
          truncated: false,
          execDisplay: "root",
          execID: 17,
        }
        const message = Schema.decodeUnknownSync(SessionMessage.Assistant)({
          id: messageID,
          type: "assistant",
          agent: "build",
          model: { providerID: "openai", id: "gpt" },
          time: { created: 1, completed: 2 },
          content: [
            {
              type: "tool",
              id: callID,
              name: nested ? "execute" : "exec_command",
              time: { created: 1, completed: 2 },
              state: {
                status: "completed",
                input: {},
                content: [{ type: "text", text: "original model result" }],
                metadata: nested
                  ? {
                      toolCalls: [
                        {
                          id: "0",
                          tool: "$opencode.exec_command",
                          name: "exec_command",
                          status: "completed",
                          metadata,
                        },
                      ],
                    }
                  : metadata,
              },
            },
          ],
        })
        const { id, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message)
        yield* db
          .insert(SessionMessageTable)
          .values({ id: messageID, session_id: parent.id, type, seq: 1, time_created: 1, data })
          .run()
        yield* Bus.reserveSequence(db, parent.id, 1)
        yield* snapshots.save({
          kind: "exec",
          snapshot: {
            sessionID: parent.id,
            assistantMessageID: messageID,
            id: callID,
            childID: nested ? "0" : undefined,
            revision: 2,
            metadata: { ...metadata, output: "latest bounded preview" },
          },
        })
        const fork = yield* sessions.fork({ sessionID: parent.id })
        const exported = yield* transfer.export({ sessionID: parent.id })
        const imported = yield* transfer.import({
          location: parent.location,
          data: {
            info: { ...exported.info, id: Session.ID.create() },
            messages: exported.messages.map((message) => ({ ...message, id: SessionMessage.ID.create() })),
          },
        })
        for (const sessionID of [fork.id, imported.id]) {
          const copied = (yield* sessions.messages({ sessionID, order: "asc" }))[0]
          expect(copied).toMatchObject({
            content: [
              {
                state: {
                  content: [{ type: "text", text: "original model result" }],
                  metadata: nested
                    ? { toolCalls: [{ metadata: { output: "latest bounded preview", processRunning: false } }] }
                    : { output: "latest bounded preview", processRunning: false },
                },
              },
            ],
          })
        }
        expect(exported.messages[0]).toMatchObject({
          content: [
            {
              state: {
                metadata: nested ? { toolCalls: [{ metadata: { processRunning: true } }] } : { processRunning: true },
              },
            },
          ],
        })
      }),
  )
