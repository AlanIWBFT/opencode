import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Question } from "../question"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Session } from "./session"
import { LocalMessageOrder } from "@opencode-ai/core/database/local-message-order"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
  readonly cleanupUnderMutation: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const question = yield* Question.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const { db } = yield* Database.Service

    const clear = Effect.fn("SessionRevert.clear")(function* (sessionID: SessionID) {
      for (const item of yield* question.list()) {
        if (item.sessionID !== sessionID) continue
        yield* question.reject(item.id).pipe(Effect.catchTag("Question.NotFoundError", () => Effect.void))
      }
    })

    const revertImpl = Effect.fn("SessionRevert.revertImpl")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      yield* clear(input.sessionID)
      const expectedEvent = yield* EventV2.latestSequence(db, input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const expectedOrder = yield* db
        .select({
          message: LocalMessageOrder.SessionOrderTable.message_seq,
          part: LocalMessageOrder.SessionOrderTable.part_seq,
        })
        .from(LocalMessageOrder.SessionOrderTable)
        .where(eq(LocalMessageOrder.SessionOrderTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      let lastUser: SessionV1.User | undefined
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev) return session

      const rollback = yield* snap.track()
      rev.snapshot = session.revert?.snapshot ?? rollback
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(patches)
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      const boundary = all.findIndex((msg) => msg.info.id === rev.messageID)
      const range = boundary < 0 ? [] : all.slice(boundary)
      const diffs = yield* summary.computeDiff({ messages: range })
      yield* sessions
        .setRevert({
          sessionID: input.sessionID,
          revert: rev,
          summary: {
            additions: diffs.reduce((sum, x) => sum + x.additions, 0),
            deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
            files: diffs.length,
          },
          expected: {
            event: expectedEvent + 1,
            message: expectedOrder?.message ?? 0,
            part: expectedOrder?.part ?? 0,
          },
        })
        .pipe(Effect.tapError(() => (rollback ? snap.restore(rollback) : Effect.void)))
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const revert = (input: RevertInput) => state.withMutation(input.sessionID)(revertImpl(input))

    const unrevertImpl = Effect.fn("SessionRevert.unrevertImpl")(function* (input: { sessionID: SessionID }) {
      yield* Effect.logInfo("unreverting", { sessionID: input.sessionID })
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = (input: { sessionID: SessionID }) => state.withMutation(input.sessionID)(unrevertImpl(input))

    const cleanupImpl = Effect.fn("SessionRevert.cleanupImpl")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const boundary = msgs.findIndex((msg) => msg.info.id === messageID)
      if (boundary < 0) {
        yield* Effect.logWarning("revert boundary message is missing", { sessionID, messageID })
        yield* sessions.clearRevert(sessionID)
        return
      }
      const target = msgs[boundary]
      const remove = msgs.slice(boundary + (session.revert.partID ? 1 : 0)).reverse()
      if (!session.revert.partID && target) remove.push(target)
      const items = remove.map((msg) =>
        EventV2.publishItem(SessionV1.Event.MessageRemoved, { sessionID, messageID: msg.info.id }),
      )
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          for (const part of removeParts) {
            items.push(
              EventV2.publishItem(SessionV1.Event.PartRemoved, {
                sessionID,
                messageID: target.info.id,
                partID: part.id,
              }),
            )
          }
        }
      }
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* events.publishBatch(items)
          yield* sessions.clearRevert(sessionID)
        }),
      )
    })

    const cleanup = (session: Session.Info) => state.withMutation(session.id)(cleanupImpl(session))

    return Service.of({ revert, unrevert, cleanup, cleanupUnderMutation: cleanupImpl })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Database.node,
    Session.node,
    Snapshot.node,
    Storage.node,
    EventV2Bridge.node,
    Question.node,
    SessionSummary.node,
    SessionRunState.node,
  ],
})

export * as SessionRevert from "./revert"
