import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>, claimed?: () => void) => Effect.Effect<A, E>
  readonly enqueueRunning: (work: Effect.Effect<A, E>, claimed?: () => void) => Effect.Effect<A, E>
  readonly startShell: (
    work: Effect.Effect<A, E>,
    ready?: Latch.Latch,
    claimed?: (started: boolean) => void,
  ) => Effect.Effect<A, E | Busy>
  readonly cancel: Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
}

interface ShellClaim<A, E> {
  readonly await: Effect.Effect<A, E | Busy>
  readonly started: boolean
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "RunningThenRun"; readonly run: RunHandle<A, E>; readonly next: PendingHandle<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E>; readonly run: PendingHandle<A, E> }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  function finishRun(
    id: number,
    done: Deferred.Deferred<A, E | Cancelled>,
    exit: Exit.Exit<A, E>,
  ): Effect.Effect<void> {
    return SynchronizedRef.modifyEffect(
      ref,
      (st): Effect.Effect<readonly [Effect.Effect<void>, State<A, E>]> =>
        Effect.gen(function* () {
          if (st._tag === "Running" && st.run.id === id) {
            return [
              Effect.gen(function* () {
                const idleExit = yield* idle.pipe(Effect.exit)
                yield* complete(done, exit)
                if (Exit.isFailure(idleExit)) yield* Effect.failCause(idleExit.cause)
              }),
              { _tag: "Idle" },
            ] as const
          }
          if (st._tag === "RunningThenRun" && st.run.id === id) {
            const run = yield* startRun(st.next.work, st.next.done)
            return [complete(done, exit), { _tag: "Running", run }] as const
          }
          return [complete(done, exit), st] as const
        }),
    ).pipe(Effect.flatten)
  }

  function startRun(
    work: Effect.Effect<A, E>,
    done: Deferred.Deferred<A, E | Cancelled>,
  ): Effect.Effect<RunHandle<A, E>> {
    return Effect.gen(function* () {
      const id = next()
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope),
      )
      return { id, done, fiber } satisfies RunHandle<A, E>
    })
  }

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) {
          return [idle, { _tag: "Idle" }] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          const run = yield* startRun(st.run.work, st.run.done)
          return [Effect.void, { _tag: "Running", run }] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const claimRunning = (work: Effect.Effect<A, E>, enqueue: boolean) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "Running": {
            if (!enqueue) return [{ await: awaitDone(st.run.done) }, st] as const
            const pending = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [{ await: awaitDone(pending.done) }, { _tag: "RunningThenRun", run: st.run, next: pending }] as const
          }
          case "RunningThenRun":
            return [{ await: awaitDone(st.next.done) }, st] as const
          case "ShellThenRun":
            return [{ await: awaitDone(st.run.done) }, st] as const
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [{ await: awaitDone(run.done) }, { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const run = yield* startRun(work, done)
            return [{ await: awaitDone(done) }, { _tag: "Running", run }] as const
          }
        }
      }),
    )

  const claim = (work: Effect.Effect<A, E>, enqueue: boolean, claimed: () => void) =>
    claimRunning(work, enqueue).pipe(
      Effect.tap(() => Effect.sync(claimed)),
      Effect.flatMap((claim) => claim.await),
    )

  const ensureRunning = (work: Effect.Effect<A, E>, claimed = () => {}) => claim(work, false, claimed)

  const enqueueRunning = (work: Effect.Effect<A, E>, claimed = () => {}) => claim(work, true, claimed)

  const claimShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          const claim: ShellClaim<A, E> = { await: Effect.fail(new Busy()), started: false }
          return [claim, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.forkChild)
        const shell = { id, cancelled, ready, fiber } satisfies ShellHandle<A, E>
        const claim: ShellClaim<A, E> = {
            started: true,
            await: Effect.gen(function* () {
              const exit = yield* Fiber.await(fiber)
              if (Exit.isSuccess(exit)) return exit.value
              if (
                Cause.hasInterruptsOnly(exit.cause) ||
                ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
              ) {
                if (onInterrupt) return yield* onInterrupt
                return yield* Effect.die(new Cancelled())
              }
              return yield* Effect.failCause(exit.cause)
            }),
          }
        return [claim, { _tag: "Shell", shell }] as const
      }),
    )

  const startShell = (
    work: Effect.Effect<A, E>,
    ready?: Latch.Latch,
    claimed: (started: boolean) => void = () => {},
  ): Effect.Effect<A, E | Busy> =>
    claimShell(work, ready).pipe(
      Effect.tap((claim) => Effect.sync(() => claimed(claim.started))),
      Effect.flatMap((claim) => claim.await),
    )

  const cancel = SynchronizedRef.modify(ref, (st) => {
    switch (st._tag) {
      case "Idle":
        return [Effect.void, st] as const
      case "Running":
        return [
          Effect.gen(function* () {
            yield* Fiber.interrupt(st.run.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "RunningThenRun":
        return [
          Effect.gen(function* () {
            yield* Fiber.interrupt(st.run.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* Deferred.fail(st.next.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "Shell":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "ShellThenRun":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
    }
  }).pipe(Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    enqueueRunning,
    startShell,
    cancel,
  }
}

export * as Runner from "./runner"
