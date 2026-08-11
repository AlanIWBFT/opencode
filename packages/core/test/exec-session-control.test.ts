import { expect } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { KV } from "@opencode/core/kv"
import { ExecSessionControl } from "@opencode/core/tool/exec-session/control"
import { Session } from "@opencode/schema/session"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ExecSessionControl.node, KV.node])))

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
