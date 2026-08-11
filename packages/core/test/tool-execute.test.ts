import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import { Permission } from "@opencode/core/permission"
import { Tool } from "@opencode/core/tool"
import { execute } from "@opencode/core/tool/runtime"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Info } from "@opencode/schema/tool"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { it } from "./lib/effect"
import { permissionService } from "./lib/permission"
import { Tool as ToolSchema } from "@opencode/schema/tool"

const context = {
  sessionID: Session.ID.make("ses_execute"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_execute"),
  id: Tool.CallID.make("call_execute"),
  progress: () => Effect.void,
}

const allowAll = permissionService({ assert: () => Effect.void })

const createCodeMode = (tools: ReadonlyMap<string, Info>, permission = allowAll) =>
  CodeModeTool.create({ tools }, (_, tool, input, context) => execute(tool, input, context), permission)

test("execute describes invariant Code Mode behavior", () => {
  expect(createCodeMode(new Map()).description).toBe(
    [
      "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.",
      "`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable: there is no `setTimeout` or sleep. All other external access goes through `tools`.",
      "Within `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.",
      'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
      "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
      "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.",
      "A script may make up to 64 tool calls, including discovery searches. Retained result and log output is limited to 1 MiB.",
    ].join("\n"),
  )
})

test("execute rejects filesystem fetches", async () => {
  const result = await Effect.runPromise(
    createCodeMode(new Map()).execute({ code: 'return await fetch("file:///blocked.txt")' }, context),
  )

  expect(result.output.error).toBe(true)
  expect(result.output.output).toContain("fetch cannot be used for filesystem access.")
})

describe("fetch permissions", () => {
  const hits: Array<string> = []
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        hits.push(`${request.method} ${new URL(request.url).pathname}`)
        return new Response("ok")
      },
    })
  })
  afterAll(() => server.stop(true))

  test("fetch asks the webfetch permission for its URL as the execute call", async () => {
    hits.length = 0
    const asked: Array<Permission.AssertInput> = []
    const url = `${server.url.origin}/allowed`
    const result = await Effect.runPromise(
      createCodeMode(
        new Map(),
        permissionService({ assert: (input) => Effect.sync(() => void asked.push(input)) }),
      ).execute({ code: `return await (await fetch("${url}", { method: "POST" })).text()` }, context),
    )

    expect(result.output.output).toBe("ok")
    expect(hits).toEqual(["POST /allowed"])
    expect(asked).toEqual([
      {
        action: "webfetch",
        resources: [url],
        save: ["*"],
        metadata: { method: "POST", url },
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      },
    ])
  })

  test("a rejection with feedback reaches the program as the error message", async () => {
    hits.length = 0
    const url = `${server.url.origin}/corrected`
    const corrected = permissionService({
      assert: () => Effect.fail(new Permission.CorrectedError({ feedback: "use the docs site instead" })),
    })
    const result = await Effect.runPromise(
      createCodeMode(new Map(), corrected).execute(
        { code: `try { await fetch("${url}") } catch (e) { return e.message }` },
        context,
      ),
    )

    expect(result.output.output).toBe(`The user rejected fetching ${url}: use the docs site instead`)
    expect(hits).toEqual([])
  })

  test("a URL denied for webfetch is never requested and rejects like a failed fetch", async () => {
    hits.length = 0
    const url = `${server.url.origin}/denied`
    const denied = permissionService({
      assert: (input) =>
        Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources })),
    })
    const result = await Effect.runPromise(
      createCodeMode(new Map(), denied).execute(
        { code: `const [denied] = await Promise.allSettled([fetch("${url}")]); return denied.status` },
        context,
      ),
    )

    expect(result.output.output).toBe("rejected")
    expect(hits).toEqual([])
  })
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

test("executions share the prepared runtime of an inventory while keeping per-call state", async () => {
  let conversions = 0
  const echo: Info = {
    name: "echo",
    description: "Echo a value",
    input: {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => {
            conversions++
            return { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
          },
          output: () => ({}),
        },
      },
    },
    execute: (input, context) => Effect.succeed({ content: `${context.id}:${(input as { value: string }).value}` }),
  }
  const inventory = { tools: new Map([["echo", echo]]) }
  const codeMode = CodeModeTool.create(inventory, (_, tool, input, context) => execute(tool, input, context), allowAll)
  const run = (id: string) => {
    const progress: Array<Tool.Metadata> = []
    return CodeModeTool.create(inventory, (_, tool, input, context) => execute(tool, input, context), allowAll)
      .execute(
        { code: `return await tools.echo({ value: "${id}" })` },
        { ...context, id: Tool.CallID.make(id), progress: (update) => Effect.sync(() => progress.push(update)) },
      )
      .pipe(Effect.map((result) => ({ output: result.output.output, progress })))
  }

  expect(CodeModeTool.catalog(inventory).tools).toHaveLength(1)
  const results = await Effect.runPromise(
    Effect.all([run("first"), run("second")], { concurrency: "unbounded" }).pipe(Effect.provide(TestClock.layer())),
  )
  expect<unknown>(results).toMatchObject(
    ["first", "second"].map((id) => ({
      output: `${id}:${id}`,
      progress: [{ toolCalls: [{ tool: "echo", status: "running", input: { value: id } }] }],
    })),
  )
  expect(
    (await Effect.runPromise(codeMode.execute({ code: 'return await tools.echo({ value: "x" })' }, context))).output
      .output,
  ).toBe("call_execute:x")
  expect(conversions).toBe(1)

  await Effect.runPromise(
    createCodeMode(new Map(inventory.tools)).execute({ code: 'return await tools.echo({ value: "next" })' }, context),
  )
  expect(conversions).toBe(2)
})

const progressCodeMode = (started: Deferred.Deferred<void>, wait: Effect.Effect<void>) =>
  createCodeMode(
    new Map<string, Info>([
      [
        "step",
        {
          name: "step",
          description: "Step",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed({ output: "ok" }),
        },
      ],
      [
        "wait",
        {
          name: "wait",
          description: "Wait",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(wait), Effect.as({ output: "ok" })),
        },
      ],
    ]),
  )

const row = (tool: string, status: string) => ({ tool, status })

it.effect("execute sends at most one progress update per 100 ms with the latest rows", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const progress: Array<Tool.Metadata> = []
    const fiber = yield* progressCodeMode(started, Effect.sleep("250 millis"))
      .execute(
        { code: "for (const i of [1, 2, 3]) await tools.step({}); await tools.wait({}); return await tools.step({})" },
        { ...context, progress: (update) => Effect.sync(() => progress.push(update)) },
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(started)
    yield* Effect.yieldNow
    expect(progress).toMatchObject([{ toolCalls: [row("step", "running")] }])

    yield* TestClock.adjust("100 millis")
    const steps = [row("step", "completed"), row("step", "completed"), row("step", "completed")]
    expect(progress.slice(1)).toMatchObject([{ toolCalls: [...steps, row("wait", "running")] }])

    // The wait's content arrives 150 ms after the trailing update; completion is carried by the final result.
    yield* TestClock.adjust("150 millis")
    const result = yield* Fiber.join(fiber)
    yield* TestClock.adjust("1 second")
    expect(progress.slice(2)).toMatchObject([{ toolCalls: [...steps, { ...row("wait", "running"), content: [] }] }])
    expect(result.metadata).toMatchObject({ toolCalls: [...steps, row("wait", "completed"), row("step", "completed")] })
  }),
)

it.effect("interrupted execute sends its latest progress rows before it settles", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const progress: Array<Tool.Metadata> = []
    const fiber = yield* progressCodeMode(started, Effect.never)
      .execute(
        { code: "await tools.step({}); await tools.step({}); return await tools.wait({})" },
        { ...context, progress: (update) => Effect.sync(() => progress.push(update)) },
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    yield* TestClock.adjust("1 second")
    expect(progress).toMatchObject([
      { toolCalls: [row("step", "running")] },
      { toolCalls: [row("step", "completed"), row("step", "completed"), row("wait", "error")] },
    ])
  }),
)
it.effect("concurrent identical child calls retain their own progress and final details", () => Effect.gen(function* () {
  const release = yield* Deferred.make<void>()
  const started = yield* Deferred.make<void>()
  const finish = yield* Deferred.make<void>()
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
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(finish)
        return { output: `${text}:${child.childID}`, metadata: { resultID: child.childID } }
      }),
  }
  const fiber = yield*
    createCodeMode(new Map([["echo", nested]])).execute(
      { code: 'return await Promise.all([tools.echo({ text: "same" }), tools.echo({ text: "same" })])' },
      {
        ...context,
        progress: (update) =>
          Effect.sync(() => {
            updates.push(update)
          }),
      },
    ).pipe(Effect.forkChild({ startImmediately: true }))
  yield* Deferred.await(started)
  yield* Effect.yieldNow
  yield* TestClock.adjust("100 millis")
  yield* Deferred.succeed(finish, undefined)
  const result = yield* Fiber.join(fiber)
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
}))

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
