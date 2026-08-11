import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Session.node, Bus.node, Database.node]), [
    Project.node.replace(globalProjectNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
)

it.effect("message reads expose immutable database creation order, not update sequence, ID or embedded JSON", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    const session = yield* sessions.create({ location: { directory: AbsolutePath.make("/project") } })
    const first = SessionMessage.ID.make("msg_z_first")
    const second = SessionMessage.ID.make("msg_a_second")
    const created = yield* bus.publish(SessionEvent.Step.Started, {
      sessionID: session.id,
      assistantMessageID: first,
      agent: Agent.ID.make("build"),
      model: Schema.decodeUnknownSync(Model.Ref)({ id: "gpt", providerID: "openai" }),
      started: 1000,
    })
    yield* sessions.synthetic({ sessionID: session.id, id: second, text: "later", resume: false })
    yield* SessionInbox.promote(db, bus, session.id, "steer")
    const before = yield* sessions.messages({ sessionID: session.id, order: "asc" })
    expect(before.map((message) => message.id)).toEqual([first, second])
    expect(before[0].seq).toBe(created.durable.seq)
    yield* bus.publish(SessionEvent.Text.Started, { sessionID: session.id, assistantMessageID: first, ordinal: 0 })
    const updated = yield* bus.publish(SessionEvent.Text.Ended, {
      sessionID: session.id,
      assistantMessageID: first,
      ordinal: 0,
      text: "finished text",
    })
    expect(updated.durable.seq).toBeGreaterThan(before[1].seq)
    yield* db
      .update(SessionMessageTable)
      .set({ data: sql`json_set(${SessionMessageTable.data}, '$.seq', 999999)` })
      .where(eq(SessionMessageTable.id, first))
      .run()
    const after = yield* sessions.messages({ sessionID: session.id, order: "asc" })
    expect(after.map((message) => message.seq)).toEqual(before.map((message) => message.seq))
    expect((yield* sessions.message({ sessionID: session.id, messageID: first }))?.seq).toBe(before[0].seq)
    const page = yield* sessions.messages({
      sessionID: session.id,
      order: "asc",
      limit: 1,
      cursor: { id: first, direction: "next" },
    })
    expect(page.map((message) => message.id)).toEqual([second])
    expect(after[0]).toMatchObject({ content: [{ type: "text", text: "finished text" }] })
    if (after[0].type === "assistant") expect(after[0].content.every((part) => !Object.hasOwn(part, "seq"))).toBe(true)
  }),
)
