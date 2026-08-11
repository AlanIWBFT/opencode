import { describe, expect, test } from "bun:test"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import { Tool } from "@opencode/core/tool"
import { execute } from "@opencode/core/tool/runtime"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { ChildCall, type Info, type Metadata } from "@opencode/schema/tool"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { it } from "./lib/effect"
import { permissionService } from "./lib/permission"

const context = {
  sessionID: Session.ID.make("ses_execute"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_execute"),
  id: Tool.CallID.make("call_execute"),
  progress: () => Effect.void,
}

const allowAll = permissionService({ assert: () => Effect.void })
const createCodeMode = (tools: ReadonlyMap<string, Info>) =>
  CodeModeTool.create({ tools }, (_, tool, input, context) => execute(tool, input, context), allowAll)

describe("exec integration", () => {
  it.effect("concurrent identical exec calls retain their own progress and final details", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const updates: Metadata[] = []
      const nested: Info = {
        name: "exec_command",
        description: "Concurrent echo",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: ({ text }, child) =>
          Effect.gen(function* () {
            expect(child.id).not.toBe(context.id)
            expect(child.parentCallID).toBe(context.id)
            yield* child.progress({ preview: child.childID })
            if (child.childID === "0") yield* Deferred.await(release)
            else yield* Deferred.succeed(release, undefined)
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(finish)
            return { output: `${text}:${child.childID}`, metadata: { resultID: child.childID } }
          }),
      }
      const fiber = yield* createCodeMode(new Map([["exec_command", nested]]))
        .execute(
          { code: 'return await Promise.all([tools.exec_command({ text: "same" }), tools.exec_command({ text: "same" })])' },
          { ...context, progress: (update) => Effect.sync(() => { updates.push(update) }) },
        )
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      yield* Effect.yieldNow
      yield* TestClock.adjust("100 millis")
      yield* Deferred.succeed(finish, undefined)
      const result = yield* Fiber.join(fiber)
      const calls = Schema.decodeUnknownSync(Schema.Array(ChildCall))(result.metadata?.toolCalls)
      expect(calls).toMatchObject([
        { id: "0", name: "exec_command", status: "completed", input: { text: "same" }, metadata: { resultID: "0" } },
        { id: "1", name: "exec_command", status: "completed", input: { text: "same" }, metadata: { resultID: "1" } },
      ])
      expect(updates.some((update) => update.toolCalls[0]?.metadata?.preview === "0" && update.toolCalls[1]?.metadata?.preview === "1")).toBe(true)
      expect(calls.every((call) => call.time !== undefined && call.time.end! >= call.time.start)).toBe(true)
      expect(result.output.output).toBe('["same:0","same:1"]')
    }),
  )

  test("an exec output validation failure preserves its progress and error details", async () => {
    const declared: Info = {
      name: "exec_command",
      description: "Invalid output",
      input: Schema.Struct({}),
      output: Schema.String,
      execute: (_, child) => child.progress({ diagnostic: "retained" }).pipe(Effect.as({ output: 42 })),
    }
    const result = await Effect.runPromise(createCodeMode(new Map([["exec_command", declared]])).execute({ code: "return await tools.exec_command({})" }, context))
    expect(result.metadata).toMatchObject({ error: true, toolCalls: [{ id: "0", status: "error", metadata: { diagnostic: "retained" } }] })
    expect(result.metadata?.toolCalls[0].error).toContain("invalid value for its output schema")
  })

  test("ordinary calls keep official records and outer files without exec snapshots", async () => {
    let snapshots = 0
    const ordinary: Info = {
      name: "read",
      description: "Read a file",
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.String,
      execute: (_, child) => {
        expect(child.childID).toBeUndefined()
        return child.progress({ preview: "not recorded" }).pipe(Effect.as({
          output: "result",
          content: [{ type: "file", mime: "image/png", uri: "data:image/png;base64,AAAA", name: "image.png" }],
          metadata: { detail: "not recorded" },
        }))
      },
    }
    const script = CodeModeTool.create(
      { tools: new Map([["read", ordinary]]) },
      (_, tool, input, context) => execute(tool, input, context),
      allowAll,
      undefined,
      () => Effect.sync(() => { snapshots++ }),
    )
    const result = await Effect.runPromise(script.execute({ code: 'return await tools.read({ path: "image.png" })' }, context))
    expect(result.metadata).toEqual({ toolCalls: [{ tool: "read", status: "completed", input: { path: "image.png" } }] })
    expect(result.output.output).toBe("result")
    expect(result.output.files).toEqual([{ data: "AAAA", mime: "image/png", name: "image.png" }])
    expect(snapshots).toBe(0)
  })

  for (const scenario of [
    { name: "failed", code: 'await tools.start({}); throw new Error("later failure")', cleaned: 1 },
    { name: "successful", code: 'await tools.start({}); return "ok"', cleaned: 0 },
    { name: "handled error", code: 'try { await tools.start({}); throw new Error("handled") } catch {} return "ok"', cleaned: 0 },
  ]) {
    test(`a ${scenario.name} Script applies cleanup only to its registered work`, async () => {
      let cleaned = 0
      const start: Info = {
        name: "start",
        description: "Start persistent work",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: (_, child) => Effect.sync(() => {
          child.registerCleanup?.(Effect.sync(() => { cleaned++ }))
          return { output: "running" }
        }),
      }
      await Effect.runPromise(createCodeMode(new Map([["start", start]])).execute({ code: scenario.code }, context))
      expect(cleaned).toBe(scenario.cleaned)
    })
  }

  test("interrupting a Script cleans work whose child invocation already returned", async () => {
    let cleaned = 0
    const waiting = await Effect.runPromise(Deferred.make<void>())
    const start: Info = {
      name: "start",
      description: "Start persistent work",
      input: Schema.Struct({}),
      output: Schema.String,
      execute: (_, child) => Effect.sync(() => {
        child.registerCleanup?.(Effect.sync(() => { cleaned++ }))
        return { output: "running" }
      }),
    }
    const wait: Info = {
      name: "wait",
      description: "Wait for interruption",
      input: Schema.Struct({}),
      execute: () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
    }
    const script = createCodeMode(new Map([["start", start], ["wait", wait]]))
    const fiber = Effect.runFork(script.execute({ code: "await tools.start({}); await tools.wait({})" }, context))
    await Effect.runPromise(Deferred.await(waiting))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(cleaned).toBe(1)
  })

  test("cancellation waits for failed-Script cleanup already in progress", async () => {
    let cleaned = 0
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const start: Info = {
      name: "start",
      description: "Start persistent work",
      input: Schema.Struct({}),
      output: Schema.String,
      execute: (_, child) => Effect.sync(() => {
        child.registerCleanup?.(Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          cleaned++
        }))
        return { output: "running" }
      }),
    }
    const script = createCodeMode(new Map([["start", start]]))
    const fiber = Effect.runFork(script.execute({ code: 'await tools.start({}); throw new Error("failed")' }, context))
    await Effect.runPromise(Deferred.await(entered))
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const cancelling = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(cancelling)
    })))
    expect(cleaned).toBe(1)
  })

  test("the preserved 64-call limit fails the Script and cleans its launched work", async () => {
    let called = 0
    let cleaned = 0
    const start: Info = {
      name: "start",
      description: "Start work",
      input: Schema.Struct({}),
      output: Schema.String,
      execute: (_, child) => Effect.sync(() => {
        called++
        child.registerCleanup?.(Effect.sync(() => { cleaned++ }))
        return { output: "running" }
      }),
    }
    const result = await Effect.runPromise(createCodeMode(new Map([["start", start]])).execute({ code: "for (let i = 0; i < 65; i++) await tools.start({})" }, context))
    expect(called).toBe(64)
    expect(cleaned).toBe(64)
    expect(result.metadata?.error).toBe(true)
  })

  test("native Script calls serialize by execution ID while independent executions can progress", async () => {
    const otherStarted = Deferred.makeUnsafe<void>()
    let firstRunning = false
    const options = { codemode: { namespace: "$opencode", concurrency: { group: "exec-session", limit: 1, inputKey: "exec_id" } } }
    const poll: Info = {
      name: "poll",
      description: "Poll",
      input: Schema.Struct({ exec_id: Schema.Number }),
      output: Schema.Number,
      options,
      execute: ({ exec_id }) => Effect.gen(function* () {
        if (exec_id === 1) {
          firstRunning = true
          yield* Deferred.await(otherStarted)
          firstRunning = false
        } else yield* Deferred.succeed(otherStarted, undefined)
        return { output: exec_id }
      }),
    }
    const stdin: Info = {
      name: "stdin",
      description: "Write",
      input: Schema.Struct({ exec_id: Schema.Number }),
      output: Schema.Number,
      options,
      execute: ({ exec_id }) => Effect.sync(() => {
        expect(firstRunning).toBe(false)
        return { output: exec_id }
      }),
    }
    const result = await Effect.runPromise(createCodeMode(new Map([["poll", poll], ["stdin", stdin]]))
      .execute({ code: "return await Promise.all([tools.$opencode.poll({exec_id: 1}), tools.$opencode.stdin({exec_id: 1}), tools.$opencode.poll({exec_id: 2})])" }, context)
      .pipe(Effect.timeout("2 seconds")))
    expect(result.metadata?.error).toBeUndefined()
    expect(result.content).toEqual([{ type: "text", text: "[1,1,2]" }])
  })
})
