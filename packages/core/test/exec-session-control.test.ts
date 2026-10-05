import { expect } from "bun:test"
import { Context, Deferred, Duration, Effect, Exit, Layer, LayerMap, Scope } from "effect"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { ExecSessionControl } from "@opencode/core/tool/exec-session/control"
import { Session } from "@opencode/schema/session"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ExecSessionControl.node, KV.node])))

class Owner extends Context.Service<Owner, { closed: boolean }>()("test/ExecOwner") {}

it.effect("conditional eviction keeps the cached replacement open while the old graph finishes cleanup", () =>
  Effect.gen(function* () {
    const control = yield* ExecSessionControl.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
    const cleaning = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const owners: { closed: boolean }[] = []
    const map = yield* LayerMap.make(
      (_ref: Location.Ref) => Layer.effect(Owner, Effect.gen(function* () {
        const owner = { closed: false }
        owners.push(owner)
        yield* control.register(() => Effect.succeed({ matched: 0, terminated: 0, failed: 0 }), {
          location,
          busy: () => false,
          close: () => { owner.closed = true },
        })
        if (owners.length === 1) yield* Effect.addFinalizer(() => Effect.gen(function* () {
          yield* Deferred.succeed(cleaning, undefined)
          yield* Deferred.await(finish)
        }))
        return owner
      })),
      { idleTimeToLive: Duration.infinity },
    )
    yield* Effect.scoped(map.contextEffect(location))
    const [released, replacement] = yield* Effect.all([
      control.releaseLocation(location, map.invalidate(location)),
      Effect.gen(function* () {
        yield* Deferred.await(cleaning)
        expect(owners[0].closed).toBe(true)
        expect(yield* control.releaseLocation(location, Effect.die("concurrent eviction"))).toBe(false)
        return Context.get(yield* Effect.scoped(map.contextEffect(location)), Owner)
      }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined))),
    ], { concurrency: "unbounded" })
    expect(released).toBe(true)
    expect(replacement.closed).toBe(false)
    expect(Context.get(yield* Effect.scoped(map.contextEffect(location)), Owner)).toBe(replacement)
  }),
)

it.effect("execution IDs remain distinct across concurrent owners and a reconstructed runtime", () =>
  Effect.gen(function* () {
    const control = yield* ExecSessionControl.Service
    const kv = yield* KV.Service
    const ids = yield* Effect.all(
      Array.from({ length: 8 }, () => control.nextID),
      { concurrency: "unbounded" },
    )
    expect(new Set(ids).size).toBe(8)
    const context = yield* Layer.build(
      ExecSessionControl.layer.pipe(Layer.provide(Layer.succeed(KV.Service, kv)), Layer.fresh),
    )
    expect(Context.get(context, ExecSessionControl.Service)).not.toBe(control)
    expect(yield* Context.get(context, ExecSessionControl.Service).nextID).toBeGreaterThan(Math.max(...ids))
  }),
)

it.effect("stop finds existing owners at execution time and unregisters only after cleanup", () =>
  Effect.gen(function* () {
    const control = yield* ExecSessionControl.Service
    const targets = [{ sessionID: Session.ID.make("ses_control") }]
    const stop = control.stop(targets)
    const owner = yield* Scope.make()
    let called = 0
    yield* control
      .register((received) =>
        Effect.sync(() => {
          expect(received).toBe(targets)
          called++
          return { matched: 1, terminated: 1, failed: 0 }
        }),
      )
      .pipe(Effect.provideService(Scope.Scope, owner))
    yield* Scope.addFinalizer(
      owner,
      control.stop(targets).pipe(
        Effect.tap((result) => {
          expect(result.matched).toBe(1)
          return Effect.void
        }),
      ),
    )
    expect(yield* stop).toEqual({ matched: 1, terminated: 1, failed: 0 })
    yield* Scope.close(owner, Exit.void)
    expect(called).toBe(2)
    expect(yield* control.stop(targets)).toEqual({ matched: 0, terminated: 0, failed: 0 })
  }),
)
