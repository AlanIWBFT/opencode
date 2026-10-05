export * as ExecSessionControl from "./control.js"

import { Context, Effect, Layer, Schema, Scope, Semaphore } from "effect"
import type { SessionID } from "@opencode/schema/session-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KV } from "../../kv.js"
import { Location } from "../../location.js"
import { LocationServiceMap } from "../../location-service-map.js"

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

interface Lifetime {
  readonly location: Location.Ref
  readonly busy: () => boolean
  readonly close: () => void
}

export interface Interface {
  /** Persisted, process-wide IDs do not name a different command after moving or restarting. */
  readonly nextID: Effect.Effect<number>
  /** Register before the owner's cleanup finalizer, so cleanup finishes before unregistering. */
  readonly register: (stop: Stop, lifetime?: Lifetime) => Effect.Effect<void, never, Scope.Scope>
  /** Check existing owners and close free owners' launch admission in one synchronous operation. */
  readonly releaseLocation: (location: Location.Ref, release: Effect.Effect<void>) => Effect.Effect<boolean>
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
    const owners = new Map<Stop, Lifetime | undefined>()
    const releasing = new Set<string>()
    const locationKey = (location: Location.Ref) => {
      const ref = LocationServiceMap.canonical(location)
      return JSON.stringify([ref.directory, ref.workspaceID])
    }
    let nextID = sequence === undefined ? 1 : Schema.decodeUnknownSync(Schema.Int)(sequence)
    return Service.of({
      nextID: lock.withPermit(
        Effect.gen(function* () {
          const id = nextID++
          yield* kv.set("exec/next-id", nextID)
          return id
        }),
      ),
      register: (stop, lifetime) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            owners.set(stop, lifetime)
          }),
          () =>
            Effect.sync(() => {
              owners.delete(stop)
            }),
        ),
      releaseLocation: (location, release) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const key = locationKey(location)
            const admitted = yield* Effect.sync(() => {
              if (releasing.has(key)) return false
              const matching = Array.from(owners.values()).filter(
                (owner) => owner && locationKey(owner.location) === key,
              )
              if (matching.some((owner) => owner?.busy())) return false
              releasing.add(key)
              for (const owner of matching) owner?.close()
              return true
            })
            if (!admitted) return false
            yield* release.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  releasing.delete(key)
                }),
              ),
            )
            return true
          }),
        ),
      stop: (targets) =>
        Effect.suspend(() =>
          Effect.forEach(Array.from(owners.keys()), (stop) => stop(targets), { concurrency: "unbounded" }).pipe(
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
