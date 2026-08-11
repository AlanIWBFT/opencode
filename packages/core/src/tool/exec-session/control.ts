export * as ExecSessionControl from "./control.js"

import { Context, Effect, Layer, Schema, Scope, Semaphore } from "effect"
import type { SessionID } from "@opencode/schema/session-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KV } from "../../kv.js"

export interface Target {
  readonly sessionID: SessionID
  /** Close admission before the session row is removed, then discard retained lane/execution state. */
  readonly deleted?: boolean
}

export interface Result {
  readonly matched: number
  readonly terminated: number
  readonly failed: number
}

type Stop = (targets: readonly Target[]) => Effect.Effect<Result>

export interface Interface {
  /** Persisted, process-wide IDs do not name a different command after moving or restarting. */
  readonly nextID: Effect.Effect<number>
  /** Register before the owner's cleanup finalizer, so cleanup finishes before unregistering. */
  readonly register: (stop: Stop) => Effect.Effect<void, never, Scope.Scope>
  /** Stops only existing owners; a session action must not create a workspace runtime just to stop it. */
  readonly stop: Stop
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ExecSessionControl") {}

export const beforeMove = Effect.fn("ExecSessionControl.beforeMove")(function* (
  control: Interface,
  sessionID: SessionID,
) {
  const result = yield* control.stop([{ sessionID }])
  if (result.failed > 0)
    return yield* Effect.die(
      new Error(`Cannot move session while ${result.failed} persistent commands could not be stopped`),
    )
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const sequence = yield* kv.get("exec/next-id")
    const lock = Semaphore.makeUnsafe(1)
    const owners = new Set<Stop>()
    let nextID = sequence === undefined ? 1 : Schema.decodeUnknownSync(Schema.Int)(sequence)
    return Service.of({
      nextID: lock.withPermit(
        Effect.gen(function* () {
          const id = nextID++
          yield* kv.set("exec/next-id", nextID)
          return id
        }),
      ),
      register: (stop) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            owners.add(stop)
          }),
          () =>
            Effect.sync(() => {
              owners.delete(stop)
            }),
        ),
      stop: (targets) =>
        Effect.suspend(() =>
          Effect.forEach(Array.from(owners), (stop) => stop(targets), { concurrency: "unbounded" }).pipe(
            Effect.map((results) =>
              results.reduce(
                (sum, result) => ({
                  matched: sum.matched + result.matched,
                  terminated: sum.terminated + result.terminated,
                  failed: sum.failed + result.failed,
                }),
                { matched: 0, terminated: 0, failed: 0 },
              ),
            ),
          ),
        ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node] })
