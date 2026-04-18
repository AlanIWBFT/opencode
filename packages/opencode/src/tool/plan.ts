import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { PlanState } from "./plan-state"
import { Question } from "../question"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { Database } from "@opencode-ai/core/database/database"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const Parameters = Schema.Struct({})

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const database = yield* Database.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const plan = PlanState.file(info, instance)
          const answers = yield* question.ask({
            id: ctx.callID ? PlanState.id({ messageID: ctx.messageID, callID: ctx.callID }) : undefined,
            sessionID: ctx.sessionID,
            questions: [PlanState.info(plan)],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (!PlanState.approve(answers[0]?.[0])) return yield* new Question.RejectedError()

          yield* PlanState.build({ session, provider, sessionID: ctx.sessionID, plan }).pipe(
            Effect.provideService(Database.Service, database),
          )

          return {
            title: PlanState.title,
            output: PlanState.output,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
