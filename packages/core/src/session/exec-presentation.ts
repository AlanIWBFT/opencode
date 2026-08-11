export * as SessionExecPresentation from "./exec-presentation.js"

import { Context, Effect, Layer, Schema, Semaphore, Stream } from "effect"
import { SessionExec } from "@opencode/schema/session-exec"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { SessionExecSnapshots } from "./exec-snapshots.js"
import { SessionStore } from "./store.js"
import { SessionProjector } from "./projector.js"

export interface Interface {
  readonly command: (snapshot: SessionExec.Snapshot) => Effect.Effect<void>
  /** Capture current previews before copying settled history into a fork. */
  readonly checkpoint: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExecPresentation") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const snapshots = yield* SessionExecSnapshots.Service
    const store = yield* SessionStore.Service
    const bus = yield* Bus.Service
    const lock = Semaphore.makeUnsafe(1)
    const settle = (sessionID: SessionID, messageID?: SessionMessage.ID, checkpoint = false) =>
      lock.withPermit(
        Effect.gen(function* () {
          const entries = (yield* snapshots.list(sessionID, messageID)).toSorted(
            (left, right) => Number(left.kind === "exec") - Number(right.kind === "exec"),
          )
          for (const entry of entries) {
            const current = yield* store.message(entry.snapshot.assistantMessageID)
            if (!current || current.sessionID !== sessionID || current.message.type !== "assistant") {
              yield* snapshots.acknowledge(entry)
              continue
            }
            const tool = current.message.content.findLast(
              (part) => part.type === "tool" && part.id === entry.snapshot.id,
            )
            if (!tool || tool.type !== "tool") {
              yield* snapshots.acknowledge(entry)
              continue
            }
            // Terminal tool events replace metadata. Wait for that replacement before appending a final preview.
            if (tool.state.status !== "completed" && tool.state.status !== "error") continue
            if (entry.kind === "script") {
              if (tool.name !== "execute") continue
              if (Number(tool.state.metadata?.codeModeRevision ?? 0) < entry.snapshot.revision)
                yield* bus.publish(SessionEvent.Exec.ScriptCaptured, entry.snapshot)
              yield* snapshots.acknowledge(entry)
              continue
            }
            if (entry.snapshot.metadata.processRunning && !checkpoint) continue
            const childID = entry.snapshot.childID
            const calls = tool.state.metadata?.toolCalls
            const child = Array.isArray(calls)
              ? calls.find((call) => Schema.is(Tool.ChildCall)(call) && call.id === childID)
              : undefined
            const metadata =
              childID === undefined
                ? tool.state.metadata
                : Schema.is(Tool.ChildCall)(child)
                  ? child.metadata
                  : undefined
            if (Number(metadata?.execRevision ?? 0) < entry.snapshot.revision)
              yield* bus.publish(SessionEvent.Exec.Captured, entry.snapshot)
            if (!entry.snapshot.metadata.processRunning) yield* snapshots.acknowledge(entry)
          }
        }),
      )

    yield* bus
      .subscribe([
        SessionEvent.Tool.Success,
        SessionEvent.Tool.Failed,
        SessionEvent.Step.Ended,
        SessionEvent.Step.Failed,
        SessionEvent.Deleted,
      ])
      .pipe(
        Stream.runForEach((event) =>
          event.type === "session.deleted"
            ? snapshots.remove(event.data.sessionID)
            : settle(event.data.sessionID, event.data.assistantMessageID),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )

    return Service.of({
      command: (snapshot) =>
        Effect.gen(function* () {
          yield* snapshots.save({ kind: "exec", snapshot })
          yield* bus.publish(SessionEvent.Exec.Updated, snapshot)
          if (!snapshot.metadata.processRunning) yield* settle(snapshot.sessionID, snapshot.assistantMessageID)
        }),
      checkpoint: (sessionID) => settle(sessionID, undefined, true),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionExecSnapshots.node, SessionStore.node, Bus.node, SessionProjector.node],
})
