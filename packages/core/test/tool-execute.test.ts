import { expect, test } from "bun:test"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import { Tool } from "@opencode/core/tool"
import { execute } from "@opencode/core/tool/runtime"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Info } from "@opencode/schema/tool"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { Tool as ToolSchema } from "@opencode/schema/tool"

const context = {
  sessionID: Session.ID.make("ses_execute"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_execute"),
  id: Tool.CallID.make("call_execute"),
  progress: () => Effect.void,
}

const createCodeMode = (tools: ReadonlyMap<string, Info>) =>
  CodeModeTool.create({ tools }, (_, tool, input, context) => execute(tool, input, context))

test("execute describes invariant Code Mode behavior", () => {
  expect(createCodeMode(new Map()).description).toBe(
    [
      "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.",
      "`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable; all other external access goes through `tools`.",
      "Within `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.",
      'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
      "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
      "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.",
      "A script may make up to 64 tool calls, including discovery searches. Retained result and log output is limited to 1 MiB.",
    ].join("\n"),
  )
})

test("canonical execution distinguishes declared, model-only, and raw schema outputs", async () => {
  const declared: Info = {
    name: "declared",
    description: "Declared",
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: ({ value }) => Effect.succeed({ output: { value } }),
  }
  const modelOnlyInput = Schema.Struct({})
  const modelOnly = {
    name: "model_only",
    description: "Model only",
    input: modelOnlyInput,
    execute: () => Effect.succeed({ content: "visible only", metadata: { kind: "model" } }),
  } satisfies Info<typeof modelOnlyInput, undefined>
  const raw: Info = {
    name: "raw",
    description: "Raw",
    input: {},
    output: {},
    execute: (input) => Effect.succeed({ output: input, content: "raw" }),
  }

  expect(await Effect.runPromise(execute(declared, { value: "encoded" }, context))).toEqual({
    output: { value: "encoded" },
    content: [{ type: "text", text: '{"value":"encoded"}' }],
  })
  expect(await Effect.runPromise(execute(modelOnly, {}, context))).toEqual({
    output: undefined,
    content: [{ type: "text", text: "visible only" }],
    metadata: { kind: "model" },
  })
  expect(await Effect.runPromise(execute(raw, { unchecked: true }, context))).toEqual({
    output: { unchecked: true },
    content: [{ type: "text", text: "raw" }],
  })
})

test("declared outputs cannot bypass validation and raw outputs stay JSON-compatible", async () => {
  const missing: Info = {
    name: "missing",
    description: "Missing output",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.succeed({ content: "not an output" }),
  }
  const invalid: Info = {
    name: "invalid",
    description: "Invalid raw output",
    input: {},
    output: {},
    execute: () => Effect.succeed({ output: 1n, content: "not JSON" }),
  }

  expect((await Effect.runPromiseExit(execute(missing, {}, context))).toString()).toContain(
    "Tool did not return its declared output",
  )
  expect((await Effect.runPromiseExit(execute(invalid, {}, context))).toString()).toContain(
    "Tool returned a non-JSON value",
  )
})

test("foreign typed failures settle as Tool.Error at the untrusted boundary", async () => {
  class ForeignFailure extends Schema.TaggedError<ForeignFailure>()("Plugin.ForeignFailure", {
    message: Schema.String,
  }) {}
  const lying: Info = {
    name: "lying",
    description: "Fails with a non-Tool.Error typed failure",
    input: Schema.Struct({}),
    execute: () => new ForeignFailure({ message: "transport died" }) as never,
  }

  const error = await Effect.runPromise(execute(lying, {}, context).pipe(Effect.flip))
  expect(error).toBeInstanceOf(Tool.Error)
  expect(error.message).toBe("transport died")
})

test("execute supports callable namespace tools", async () => {
  const callable: Info = {
    name: "admin",
    description: "Administer Slack",
    input: Schema.Struct({}),
    output: Schema.String,
    options: { namespace: "slack" },
    execute: () => Effect.succeed({ output: "admin" }),
  }
  const child: Info = {
    name: "create",
    description: "Create a Slack resource",
    input: Schema.Struct({}),
    output: Schema.String,
    options: { namespace: "slack.admin" },
    execute: () => Effect.succeed({ output: "created" }),
  }
  const codeMode = createCodeMode(
    new Map([
      ["slack_admin", callable],
      ["slack_admin_create", child],
    ]),
  )
  const result = await Effect.runPromise(
    codeMode.execute({ code: "return [await tools.slack.admin({}), await tools.slack.admin.create({})]" }, context),
  )

  expect(result.metadata).toMatchObject({
    toolCalls: [
      { id: "0", tool: "slack.admin", name: "admin", status: "completed", content: [{ type: "text", text: "admin" }] },
      {
        id: "1",
        tool: "slack.admin.create",
        name: "create",
        status: "completed",
        content: [{ type: "text", text: "created" }],
      },
    ],
  })
  expect(result.content).toEqual([{ type: "text", text: '[\n  "admin",\n  "created"\n]' }])
})

test("concurrent identical child calls retain their own progress and final details", async () => {
  const release = await Effect.runPromise(Deferred.make<void>())
  const updates: ToolSchema.Metadata[] = []
  const nested: Info = {
    name: "echo",
    description: "Concurrent echo",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.String,
    execute: ({ text }, child) =>
      Effect.gen(function* () {
        expect(child.id).toBe(context.id)
        yield* child.progress({ preview: child.childID })
        if (child.childID === "0") yield* Deferred.await(release)
        else yield* Deferred.succeed(release, undefined)
        return { output: `${text}:${child.childID}`, metadata: { resultID: child.childID } }
      }),
  }
  const result = await Effect.runPromise(
    createCodeMode(new Map([["echo", nested]])).execute(
      { code: 'return await Promise.all([tools.echo({ text: "same" }), tools.echo({ text: "same" })])' },
      {
        ...context,
        progress: (update) =>
          Effect.sync(() => {
            updates.push(update)
          }),
      },
    ),
  )
  const calls = Schema.decodeUnknownSync(Schema.Array(ToolSchema.ChildCall))(result.metadata?.toolCalls)
  expect(calls).toMatchObject([
    {
      id: "0",
      status: "completed",
      input: { text: "same" },
      metadata: { resultID: "0" },
      content: [{ type: "text", text: "same:0" }],
    },
    {
      id: "1",
      status: "completed",
      input: { text: "same" },
      metadata: { resultID: "1" },
      content: [{ type: "text", text: "same:1" }],
    },
  ])
  expect(
    updates.some(
      (update) => update.toolCalls[0]?.metadata?.preview === "0" && update.toolCalls[1]?.metadata?.preview === "1",
    ),
  ).toBe(true)
  expect(calls.every((call) => call.time !== undefined && call.time.end! >= call.time.start)).toBe(true)
})

test("a child output validation failure preserves its progress and error details", async () => {
  const declared: Info = {
    name: "invalid",
    description: "Invalid output",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: (_, child) => child.progress({ diagnostic: "retained" }).pipe(Effect.as({ output: 42 })),
  }
  const codeMode = createCodeMode(new Map([["invalid", declared]]))
  const result = await Effect.runPromise(codeMode.execute({ code: "return await tools.invalid({})" }, context))
  expect(result.metadata).toMatchObject({
    error: true,
    toolCalls: [{ id: "0", status: "error", metadata: { diagnostic: "retained" } }],
  })
  expect(result.metadata?.toolCalls[0].error).toContain("invalid value for its output schema")
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
    name: "start", description: "Start persistent work", input: Schema.Struct({}), output: Schema.String,
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
    name: "start", description: "Start work", input: Schema.Struct({}), output: Schema.String,
    execute: (_, child) => Effect.sync(() => {
      called++
      child.registerCleanup?.(Effect.sync(() => { cleaned++ }))
      return { output: "running" }
    }),
  }
  const result = await Effect.runPromise(createCodeMode(new Map([["start", start]])).execute(
    { code: "for (let i = 0; i < 65; i++) await tools.start({})" }, context,
  ))
  expect(called).toBe(64)
  expect(cleaned).toBe(64)
  expect(result.metadata?.error).toBe(true)
})

test("native Script calls serialize by execution ID while independent executions can progress", async () => {
  const otherStarted = Deferred.makeUnsafe<void>()
  let firstRunning = false
  const options = { codemode: { namespace: "$opencode", concurrency: { group: "exec-session", limit: 1, inputKey: "exec_id" } } }
  const poll: Info = {
    name: "poll", description: "Poll", input: Schema.Struct({ exec_id: Schema.Number }), output: Schema.Number, options,
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
    name: "stdin", description: "Write", input: Schema.Struct({ exec_id: Schema.Number }), output: Schema.Number, options,
    execute: ({ exec_id }) => Effect.sync(() => {
      expect(firstRunning).toBe(false)
      return { output: exec_id }
    }),
  }
  const script = createCodeMode(new Map([["poll", poll], ["stdin", stdin]]))
  const result = await Effect.runPromise(script.execute({
    code: "return await Promise.all([tools.$opencode.poll({exec_id: 1}), tools.$opencode.stdin({exec_id: 1}), tools.$opencode.poll({exec_id: 2})])",
  }, context).pipe(Effect.timeout("2 seconds")))
  expect(result.metadata?.error).toBeUndefined()
  expect(result.content).toEqual([{ type: "text", text: "[\n  1,\n  1,\n  2\n]" }])
})
