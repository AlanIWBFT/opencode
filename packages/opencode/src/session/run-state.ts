import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Deferred, Effect, Fiber, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly withMutation: (sessionID: SessionID) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly interrupt: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly admit: <A, E, R>(
    sessionID: SessionID,
    admission: Effect.Effect<Admission<A>, E, R>,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<A, E, R>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export type Admission<A> =
  | { readonly _tag: "done"; readonly value: A }
  | { readonly _tag: "run"; readonly complete: (result: SessionV1.WithParts) => A }

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const mutations = yield* KeyedMutex.make<SessionID>()

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      let next!: Runner.Runner<SessionV1.WithParts>
      next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: mutations.withLock(sessionID)(
          Effect.gen(function* () {
            if (data.runners.get(sessionID) !== next || next.busy) return
            data.runners.delete(sessionID)
            yield* status.set(sessionID, { type: "idle" })
          }),
        ),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const interrupt = Effect.fn("SessionRunState.interrupt")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancel
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
      yield* interrupt(sessionID)
    })

    const beginRunning = Effect.fn("SessionRunState.beginRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      enqueue: boolean,
    ) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* runner(sessionID, onInterrupt)
          const claimed = yield* Deferred.make<void>()
          const signal = () => Deferred.doneUnsafe(claimed, Effect.void)
          const running = enqueue ? current.enqueueRunning : current.ensureRunning
          const fiber = yield* running(work, signal).pipe(
            Effect.ensuring(Effect.sync(signal)),
            Effect.forkChild,
          )
          yield* Deferred.await(claimed)
          return Fiber.join(fiber)
        }),
      )
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const wait = yield* restore(mutations.withLock(sessionID)(beginRunning(sessionID, onInterrupt, work, false)))
          return yield* restore(wait)
        }),
      )
    })

    const admit = <A, E, R>(
      sessionID: SessionID,
      admission: Effect.Effect<Admission<A>, E, R>,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ): Effect.Effect<A, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const admitted = yield* restore(
            mutations.withLock(sessionID)(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const result = yield* admission
                  if (result._tag === "done") return result
                  const wait = yield* beginRunning(sessionID, onInterrupt, work, true)
                  return { ...result, wait } as const
                }),
              ),
            ),
          )
          if (admitted._tag === "done") return admitted.value
          return admitted.complete(yield* restore(admitted.wait))
        }),
      )

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      const begin = Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* runner(sessionID, onInterrupt)
          const claimed = yield* Deferred.make<boolean>()
          const signal = (started: boolean) => Deferred.doneUnsafe(claimed, Effect.succeed(started))
          const fiber = yield* current
            .startShell(work, ready, signal)
            .pipe(Effect.ensuring(Effect.sync(() => signal(false))))
            .pipe(Effect.forkChild)
          const started = yield* Deferred.await(claimed)
          if (started && ready) yield* ready.await
          return Fiber.join(fiber)
        }),
      )
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const wait = yield* restore(mutations.withLock(sessionID)(begin))
          return yield* restore(wait)
        }),
      ).pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({
      withMutation: mutations.withLock,
      assertNotBusy,
      cancel,
      interrupt,
      ensureRunning,
      admit,
      startShell,
    })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [BackgroundJob.node, SessionStatus.node] })

export * as SessionRunState from "./run-state"
