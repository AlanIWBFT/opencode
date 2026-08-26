import { NodeStream } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import { once } from "node:events"
import { PassThrough } from "node:stream"

const prematureClose = "Readable closed before emitting 'end'"

const read = (input: PassThrough) =>
  Stream.runCollect(
    NodeStream.fromReadable({
      evaluate: () => input,
      onError: (error) => (error instanceof Error ? error : new Error(String(error))),
    }),
  )

const failureMessage = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("Expected stream read to fail")
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

describe("NodeStream.fromReadable", () => {
  test("reads a normally ended stream", async () => {
    const input = new PassThrough()
    const result = Effect.runPromise(read(input).pipe(Effect.timeout("1 second")))
    input.end("ok")

    const chunks = await result
    expect(Buffer.concat(chunks).toString()).toBe("ok")
  })

  test("fails when a readable closes before end", async () => {
    const input = new PassThrough()
    const result = Effect.runPromiseExit(read(input).pipe(Effect.timeout("1 second")))
    expect(input.listenerCount("close")).toBeGreaterThan(0)
    input.destroy()

    expect(failureMessage(await result)).toBe(prematureClose)
  })

  test("fails when the readable was already closed before evaluation", async () => {
    const input = new PassThrough()
    const closed = once(input, "close")
    input.destroy()
    await closed

    const exit = await Effect.runPromiseExit(read(input).pipe(Effect.timeout("1 second")))
    expect(failureMessage(exit)).toBe(prematureClose)
  })

  test("does not report a premature close when consumption is interrupted", async () => {
    const input = new PassThrough()
    const fiber = Effect.runFork(read(input))
    expect(input.listenerCount("close")).toBeGreaterThan(0)

    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(input.destroyed).toBe(true)
    expect(input.listenerCount("close")).toBe(0)
  })
})
