export * as SessionExecSnapshots from "./exec-snapshots.js"

import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { produce } from "immer"
import { SessionExec } from "@opencode/schema/session-exec"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KV } from "../kv.js"
import { applyExecMetadata, applyScriptMetadata } from "./exec-metadata.js"

const Entry = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("exec"), snapshot: SessionExec.Snapshot }),
  Schema.Struct({ kind: Schema.Literal("script"), snapshot: SessionExec.ScriptSnapshot }),
])
export type Entry = typeof Entry.Type

export interface Interface {
  /** Replaces the latest bounded presentation; it does not append to the event log. */
  readonly save: (entry: Entry) => Effect.Effect<void>
  readonly list: (sessionID: SessionID, messageID?: SessionMessage.ID) => Effect.Effect<readonly Entry[]>
  /** Remove only the captured revision: a later preview may already have replaced it. */
  readonly acknowledge: (entry: Entry) => Effect.Effect<void>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExecSnapshots") {}

const prefix = (sessionID: SessionID, messageID?: SessionMessage.ID) =>
  `session-exec/${encodeURIComponent(sessionID)}/${messageID === undefined ? "" : `${encodeURIComponent(messageID)}/`}`

const key = (entry: Entry) =>
  `${prefix(entry.snapshot.sessionID, entry.snapshot.assistantMessageID)}${encodeURIComponent(entry.snapshot.id)}/${entry.kind}/${entry.kind === "exec" && entry.snapshot.childID !== undefined ? `child/${encodeURIComponent(entry.snapshot.childID)}` : "root"}`

const Stored = Schema.Struct({ owner: Schema.String, entry: Entry })
const decode = Schema.decodeUnknownSync(Stored)
const encode = Schema.encodeSync(Stored)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    // Live processes are not recovered across backend runtimes; only their last bounded preview survives.
    const owner = crypto.randomUUID()
    const lock = Semaphore.makeUnsafe(1)
    const scan = Effect.fn("SessionExecSnapshots.scan")(function* (
      sessionID: SessionID,
      messageID?: SessionMessage.ID,
    ) {
      const entries: KV.Entry[] = []
      let after: string | undefined
      do {
        const page = yield* kv.scan({ prefix: prefix(sessionID, messageID), after, limit: 1000 })
        entries.push(...page.entries)
        after = page.next
      } while (after !== undefined)
      return entries
    })
    return Service.of({
      save: (entry) =>
        lock.withPermit(
          Effect.gen(function* () {
            const stored = yield* kv.get(key(entry))
            if (stored !== undefined && decode(stored).entry.snapshot.revision >= entry.snapshot.revision) return
            yield* kv.set(key(entry), encode({ owner, entry }))
          }),
        ),
      list: (sessionID, messageID) =>
        lock.withPermit(
          scan(sessionID, messageID).pipe(
            Effect.flatMap((entries) =>
              Effect.forEach(entries, (stored) =>
                Effect.gen(function* () {
                  const value = decode(stored.value)
                  if (value.owner === owner) return value.entry
                  const entry = interrupted(value.entry)
                  yield* kv.set(stored.key, encode({ owner, entry }))
                  return entry
                }),
              ),
            ),
          ),
        ),
      acknowledge: (entry) =>
        lock.withPermit(
          Effect.gen(function* () {
            const stored = yield* kv.get(key(entry))
            if (stored === undefined || decode(stored).entry.snapshot.revision !== entry.snapshot.revision) return
            yield* kv.remove(key(entry))
          }),
        ),
      remove: (sessionID) =>
        lock.withPermit(
          scan(sessionID).pipe(
            Effect.flatMap((entries) => Effect.forEach(entries, (entry) => kv.remove(entry.key), { discard: true })),
          ),
        ),
    })
  }),
)

function interrupted(entry: Entry): Entry {
  const error = "The backend runtime ended; live execution state is unavailable. The last saved output is preserved."
  if (entry.kind === "exec") {
    if (!entry.snapshot.metadata.processRunning) return entry
    return {
      ...entry,
      snapshot: {
        ...entry.snapshot,
        revision: entry.snapshot.revision + 1,
        metadata: { ...entry.snapshot.metadata, processRunning: false, execError: error },
      },
    }
  }
  if (!entry.snapshot.toolCalls.some((call) => call.status === "running")) return entry
  return {
    ...entry,
    snapshot: {
      ...entry.snapshot,
      revision: entry.snapshot.revision + 1,
      toolCalls: entry.snapshot.toolCalls.map((call) =>
        call.status !== "running"
          ? call
          : {
              ...call,
              status: "error",
              error,
              ...(call.time ? { time: { ...call.time, end: Date.now() } } : {}),
            },
      ),
    },
  }
}

/** Parent children must exist before their independently advancing command previews are applied. */
export function overlay(message: SessionMessage.Info, entries: readonly Entry[]) {
  if (message.type !== "assistant") return message
  return produce(message, (draft) => {
    for (const entry of entries) if (entry.kind === "script") applyScriptMetadata(draft, entry.snapshot)
    for (const entry of entries) if (entry.kind === "exec") applyExecMetadata(draft, entry.snapshot)
  })
}

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node] })
