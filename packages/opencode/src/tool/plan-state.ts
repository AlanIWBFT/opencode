import path from "path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { QuestionID } from "@/question/schema"
import { Provider } from "@/provider/provider"
import { Database } from "@opencode-ai/core/database/database"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"

const yes = "Yes"
const no = "No"

export interface Recovered {
  info: {
    id: QuestionID
    sessionID: SessionID
    questions: ReadonlyArray<ReturnType<typeof info>>
    tool: {
      messageID: MessageID
      callID: string
    }
  }
  part: SessionV1.ToolPart & { state: SessionV1.ToolStateRunning }
  plan: string
}

export const title = "Switching to build agent"
export const output = "User approved switching to build agent. Wait for further instructions."
export const approve = (answer?: string) => answer === yes

export const file = (session: { slug: string; time: { created: number } }, instance: InstanceContext) =>
  path.relative(instance.worktree, Session.plan(session, instance))

export const info = (plan: string) => ({
  question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
  header: "Build Agent",
  custom: false,
  options: [
    { label: yes, description: "Switch to build agent and start implementing the plan" },
    { label: no, description: "Stay with plan agent to continue refining the plan" },
  ],
})

export const id = (tool: { messageID: MessageID; callID: string }) =>
  QuestionID.make(`que_${tool.messageID.slice(4)}_${tool.callID}`)

export const ref = (id: QuestionID) => {
  const value = String(id)
  if (!value.startsWith("que_")) return
  const rest = value.slice(4)
  if (rest.length <= 27) return
  if (rest[26] !== "_") return
  return {
    messageID: MessageID.make(`msg_${rest.slice(0, 26)}`),
    callID: rest.slice(27),
  }
}

function directoryCondition(directory: string) {
  const code = directory.charCodeAt(0)
  const windows =
    (directory[1] === ":" && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) ||
    directory.startsWith("\\\\") ||
    directory.startsWith("//")
  if (!windows) return eq(SessionTable.directory, directory)
  return inArray(SessionTable.directory, [
    ...new Set([directory, directory.replaceAll("\\", "/"), directory.replaceAll("/", "\\")]),
  ])
}

const model = Effect.fn("PlanState.model")(function* (sessionID: SessionID, provider: Provider.Interface) {
  for (const item of yield* MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return yield* provider.defaultModel().pipe(Effect.orDie)
})

export const recover = Effect.fn("PlanState.recover")(function* (requestID?: QuestionID) {
  const ctx = yield* InstanceState.context
  const database = yield* Database.Service
  const recovered = requestID ? ref(requestID) : undefined
  if (requestID && !recovered) return [] as Recovered[]

  const where = [
    eq(SessionTable.project_id, ctx.project.id),
    directoryCondition(ctx.directory),
    isNull(SessionTable.time_archived),
    sql`json_extract(${PartTable.data}, '$.tool') = 'plan_exit'`,
    sql`json_extract(${PartTable.data}, '$.state.status') = 'running'`,
  ]
  if (recovered) {
    where.push(eq(PartTable.message_id, recovered.messageID))
    where.push(sql`json_extract(${PartTable.data}, '$.callID') = ${recovered.callID}`)
  }

  const rows: Array<{ part: typeof PartTable.$inferSelect; session: typeof SessionTable.$inferSelect }> = yield* database.db
    .select({ part: PartTable, session: SessionTable })
    .from(PartTable)
    .innerJoin(SessionTable, eq(PartTable.session_id, SessionTable.id))
    .where(and(...where))
    .all()
    .pipe(Effect.orDie)

  return rows.map((row) => {
    const part = {
      ...row.part.data,
      id: row.part.id,
      sessionID: row.part.session_id,
      messageID: row.part.message_id,
    } as SessionV1.ToolPart & { state: SessionV1.ToolStateRunning }
    const session = Session.fromRow(row.session)
    const plan = file(session, ctx)
    return {
      info: {
        id: id({ messageID: part.messageID, callID: part.callID }),
        sessionID: part.sessionID,
        questions: [info(plan)],
        tool: {
          messageID: part.messageID,
          callID: part.callID,
        },
      },
      part,
      plan,
    }
  })
})

const done = Effect.fn("PlanState.done")(function* (input: {
  session: Pick<Session.Interface, "updateMessage">
  part: SessionV1.ToolPart
}) {
  const msg = yield* MessageV2.get({ sessionID: input.part.sessionID, messageID: input.part.messageID }).pipe(
    Effect.orDie,
  )
  if (msg.info.role !== "assistant") return
  if (msg.info.time.completed) return
  yield* input.session.updateMessage({
    ...msg.info,
    time: {
      ...msg.info.time,
      completed: Date.now(),
    },
  })
})

export const reject = Effect.fn("PlanState.reject")(function* (input: {
  session: Pick<Session.Interface, "updateMessage" | "updatePart">
  part: SessionV1.ToolPart & { state: SessionV1.ToolStateRunning }
  error: string
}) {
  yield* input.session.updatePart({
    ...input.part,
    state: {
      status: "error",
      input: input.part.state.input,
      error: input.error,
      time: { start: input.part.state.time.start, end: Date.now() },
    },
  })
  yield* done({ session: input.session, part: input.part })
})

export const build = Effect.fn("PlanState.build")(function* (input: {
  session: Pick<Session.Interface, "updateMessage" | "updatePart">
  provider: Provider.Interface
  sessionID: SessionID
  plan: string
}) {
  const msg: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: yield* model(input.sessionID, input.provider),
  }
  yield* input.session.updateMessage(msg)
  yield* input.session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: input.sessionID,
    type: "text",
    text: `The plan at ${input.plan} has been approved, you can now edit files. Execute the plan`,
    synthetic: true,
  } satisfies SessionV1.TextPart)
})

export const reply = Effect.fn("PlanState.reply")(function* (input: {
  session: Pick<Session.Interface, "updateMessage" | "updatePart">
  provider: Provider.Interface
  item: Recovered
  answer?: string
  error: string
}) {
  if (!approve(input.answer)) {
    yield* reject({ session: input.session, part: input.item.part, error: input.error })
    return undefined
  }

  yield* build({
    session: input.session,
    provider: input.provider,
    sessionID: input.item.part.sessionID,
    plan: input.item.plan,
  })
  yield* input.session.updatePart({
    ...input.item.part,
    state: {
      status: "completed",
      input: input.item.part.state.input,
      output,
      title,
      metadata: {},
      time: { start: input.item.part.state.time.start, end: Date.now() },
    },
  })
  yield* done({ session: input.session, part: input.item.part })
  return input.item.part.sessionID
})

export * as PlanState from "./plan-state"
