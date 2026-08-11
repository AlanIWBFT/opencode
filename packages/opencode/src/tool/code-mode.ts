import * as Tool from "./tool"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Exit, Option, Schema, Semaphore } from "effect"
import { CodeMode, Tool as SandboxTool, toolError } from "@opencode-ai/codemode"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { ExecSession } from "./exec-session"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PartID } from "@/session/schema"

export const CODE_MODE_TOOL = "execute"

const DESCRIPTION = "Run a confined orchestration script with access to available OpenCode and MCP tools."
const LIMITS = { timeoutMs: 120_000, maxToolCalls: 64, maxOutputBytes: 1_048_576 }

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "Script body executed by the confined interpreter.",
  }),
})

type Metadata = {
  codeMode?: { projected: true }
  toolCalls: {
    tool: string
    status: "running" | "completed" | "error"
    input?: Record<string, unknown>
    title?: string
    metadata?: Record<string, unknown>
  }[]
  error?: boolean
}

type CallEntry = Metadata["toolCalls"][number]

type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number]

type CatalogEntry =
  | {
      _tag: "mcp"
      key: string
      server: string
      local: string
      tool: MCP.McpTool
    }
  | {
      _tag: "native"
      key: string
      server: "$opencode"
      local: string
      native: Tool.Def
    }

function groupByServer(mcpTools: Record<string, MCP.McpTool>, servers: readonly string[]): Map<string, CatalogEntry[]> {
  const byLongest = [...servers].sort((a, b) => b.length - a.length)
  const groups = new Map<string, CatalogEntry[]>()
  for (const key of Object.keys(mcpTools).sort((a, b) => a.localeCompare(b))) {
    const server =
      byLongest.find((name) => key.startsWith(name + "_")) ?? (key.includes("_") ? key.slice(0, key.indexOf("_")) : key)
    const local = server && key.startsWith(server + "_") ? key.slice(server.length + 1) : key
    const entry: CatalogEntry = {
      _tag: "mcp",
      key,
      server,
      local,
      tool: mcpTools[key]!,
    }
    groups.set(server, [...(groups.get(server) ?? []), entry])
  }
  return groups
}

export function describeCatalog(
  mcpTools: Record<string, MCP.McpTool>,
  servers: readonly string[],
  native: Tool.Def[] = [],
): string {
  return CodeMode.make({
    tools: toolTree(
      [...groupByServer(mcpTools, servers).values()].flat().concat(native.map(nativeEntry)),
      () => () => Effect.fail(toolError("Tool preview is not executable.")),
    ),
  }).instructions()
}

function nativeEntry(tool: Tool.Def): CatalogEntry {
  return { _tag: "native", key: tool.id, server: "$opencode", local: tool.id, native: tool }
}

const lastSegment = (uri: string) => {
  const trimmed = uri.split(/[?#]/, 1)[0]!.replace(/\/+$/, "")
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1)
  return segment.length > 0 ? segment : undefined
}

const dataUrl = (mime: string, base64: string) => `data:${mime};base64,${base64}`

function projectMcpResult(result: CallToolResult, collect: (attachment: Attachment) => void): unknown {
  const text: string[] = []
  let files = 0
  let images = 0
  const push = (attachment: Attachment) => {
    files += 1
    if (attachment.mime.startsWith("image/")) images += 1
    collect(attachment)
  }
  for (const block of result.content) {
    switch (block.type) {
      case "text":
        text.push(block.text)
        break
      case "image":
      case "audio":
        push({ type: "file", mime: block.mimeType, url: dataUrl(block.mimeType, block.data) })
        break
      case "resource": {
        if ("text" in block.resource) {
          text.push(block.resource.text)
          break
        }
        const mime = block.resource.mimeType ?? "application/octet-stream"
        push({ type: "file", mime, url: dataUrl(mime, block.resource.blob), filename: lastSegment(block.resource.uri) })
        break
      }
      case "resource_link":
        // A link is a reference, not fetchable media; hand it to the program instead of the attachment channel.
        text.push(`${block.name}: ${block.uri}`)
        break
    }
  }

  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent
  if (text.length > 0) return text.join("\n")
  if (files > 0) {
    const noun = files === images ? "image" : "file"
    return `[${files} ${noun}${files === 1 ? "" : "s"} attached to the result]`
  }
  return null
}

type RuntimeCall = { readonly index: number; readonly name: string }
type Run = (input: unknown, call: RuntimeCall) => Effect.Effect<unknown, unknown, never>

function toolTree(catalog: readonly CatalogEntry[], run: (entry: CatalogEntry) => Run) {
  const tree: Record<string, Record<string, SandboxTool.Definition<never>>> = {}
  for (const entry of catalog) {
    const namespace = (tree[entry.server] ??= {})
    namespace[entry.local] = SandboxTool.make({
      description: entry._tag === "native" ? entry.native.description : (entry.tool.def.description ?? ""),
      input: (entry._tag === "native"
        ? ToolJsonSchema.fromTool(entry.native)
        : entry.tool.def.inputSchema) as SandboxTool.JsonSchema,
      output: entry._tag === "mcp" ? (entry.tool.def.outputSchema as SandboxTool.JsonSchema | undefined) : undefined,
      run: run(entry),
    })
  }
  return tree
}

const invokeChildTool = Effect.fn("CodeMode.invokeChildTool")(function* (input: {
  plugin: Plugin.Interface
  entry: CatalogEntry
  args: Record<string, unknown>
  callID: string
  ctx: Tool.Context
  registerCleanup(cleanup: Effect.Effect<unknown, never>): void
  metadata(update: { title?: string; metadata?: Record<string, unknown> }): Effect.Effect<void>
}) {
  yield* input.plugin.trigger(
    "tool.execute.before",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID },
    { args: input.args },
  )
  if (input.entry._tag === "native") {
    const result = yield* input.entry.native.execute(input.args, {
      ...input.ctx,
      callID: input.callID,
      metadata: input.metadata,
      registerCleanup: input.registerCleanup,
    })
    yield* input.plugin.trigger(
      "tool.execute.after",
      { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID, args: input.args },
      result,
    )
    return result
  }

  const tool = input.entry.tool
  const result: CallToolResult = yield* Effect.gen(function* () {
    yield* input.ctx.ask({ permission: input.entry.key, metadata: {}, patterns: ["*"], always: ["*"] })
    // Deliberately mirrors McpCatalog.convertTool's transport call so the MCP service stays free of tool-loop concerns.
    return yield* Effect.promise(async () => {
      const raw = await tool.client.callTool({ name: tool.def.name, arguments: input.args }, CallToolResultSchema, {
        resetTimeoutOnProgress: true,
        signal: input.ctx.abort,
        timeout: tool.timeout,
        // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
        onprogress: () => {},
      })
      if (raw.isError)
        throw new Error(
          raw.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((text) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        )
      return raw
    })
  }).pipe(
    Effect.withSpan("Tool.execute", {
      attributes: {
        "tool.name": input.entry.key,
        "tool.call_id": input.callID,
        "session.id": input.ctx.sessionID,
        "message.id": input.ctx.messageID,
      },
    }),
  )
  yield* input.plugin.trigger(
    "tool.execute.after",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID, args: input.args },
    result,
  )
  return result
})

export const CodeModeTool = Tool.define(
  CODE_MODE_TOOL,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const execSessions = Option.getOrUndefined(yield* Effect.serviceOption(ExecSession.Service))
    const plugin = yield* Plugin.Service

    const init: Tool.DefWithoutID<typeof Parameters, Metadata> = {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: Effect.fn("CodeMode.execute")(function* (params, ctx) {
        if (ctx.abort.aborted) {
          return {
            title: CODE_MODE_TOOL,
            metadata: { toolCalls: [], error: true },
            output: "Execution cancelled.",
          } satisfies Tool.ExecuteResult<Metadata>
        }
        const agent = yield* agents.get(ctx.agent)
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        const ruleset = Permission.merge(agent.permission, session.permission ?? [])
        const mcpTools = Permission.visibleTools(yield* mcp.tools(), ruleset)
        const servers = Object.keys(yield* mcp.clients()).map(McpCatalog.sanitize)
        const native = Array.isArray(ctx.extra?.codeModeTools)
          ? ctx.extra.codeModeTools.filter(
              (tool): tool is Tool.Def => typeof tool === "object" && tool !== null && "id" in tool,
            )
          : []
        const catalog = [...groupByServer(mcpTools, servers).values()].flat().concat(native.map(nativeEntry))

        const calls: CallEntry[] = []
        const projected = new Map<number, SessionV1.ToolPart>()
        const attachments: Attachment[] = []
        const cleanups: Effect.Effect<unknown, never>[] = []
        const metadata = (error = false): Metadata => ({
          toolCalls: calls.map((call) => ({ ...call })),
          ...(projected.size > 0 ? { codeMode: { projected: true as const } } : {}),
          ...(error ? { error: true } : {}),
        })
        const publish = () =>
          ctx.metadata({
            title: CODE_MODE_TOOL,
            metadata: metadata(),
          })

        const concurrency = new Map<string, Semaphore.Semaphore>()
        const collectNative = (entry: CatalogEntry & { _tag: "native" }, result: Tool.ExecuteResult) => {
          for (const attachment of result.attachments ?? []) attachments.push(attachment)
          if (!["exec_command", "poll_exec", "write_stdin", "terminate_exec"].includes(entry.key)) return result.output
          return {
            output: result.output,
            running: result.metadata.processRunning === true,
            ...(typeof result.metadata.execID === "number" ? { execID: result.metadata.execID } : {}),
            ...(typeof result.metadata.laneID === "number" ? { laneID: result.metadata.laneID } : {}),
            ...(typeof result.metadata.exitCode === "number" ? { exitCode: result.metadata.exitCode } : {}),
            ...(typeof result.metadata.execError === "string" ? { error: result.metadata.execError } : {}),
          }
        }
        const updateProjected = (index: number, update: (part: SessionV1.ToolPart) => SessionV1.ToolPart) =>
          Effect.gen(function* () {
            const part = projected.get(index)
            if (!part) return
            const next = update(part)
            projected.set(index, next)
            yield* sessions.updatePart(next)
          })
        const callTool =
          (entry: CatalogEntry): Run =>
          (input, runtimeCall) =>
            Effect.gen(function* () {
              const index = runtimeCall.index
              const args = (input ?? {}) as Record<string, unknown>
              const started = Date.now()
              const part: SessionV1.ToolPart = {
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                type: "tool",
                tool: entry.key,
                callID: `${ctx.callID ?? CODE_MODE_TOOL}/code-mode/${index}`,
                state: { status: "running", input: args, time: { start: started } },
                metadata: {
                  codeMode: { parentCallID: ctx.callID ?? CODE_MODE_TOOL, runtimeCallID: String(index) },
                },
              }
              projected.set(index, part)
              yield* publish()
              yield* sessions.updatePart(part)
              const childAttachments: Attachment[] = []
              const result = yield* invokeChildTool({
                plugin,
                entry,
                args,
                callID: part.callID,
                ctx,
                registerCleanup: (cleanup) => cleanups.push(cleanup),
                metadata: (update) =>
                  Effect.suspend(() => {
                    const current = calls[index]
                    if (current) calls[index] = { ...current, ...update }
                    return updateProjected(index, (part) =>
                      part.state.status === "running"
                        ? {
                            ...part,
                            state: {
                              ...part.state,
                              ...(update.title ? { title: update.title } : {}),
                              ...(update.metadata ? { metadata: update.metadata } : {}),
                            },
                          }
                        : part,
                    ).pipe(Effect.andThen(publish()))
                  }),
              })
              if (entry._tag === "native") {
                const nativeResult = result as Tool.ExecuteResult
                for (const attachment of nativeResult.attachments ?? []) childAttachments.push(attachment)
                const complete = (part: SessionV1.ToolPart, metadata = nativeResult.metadata): SessionV1.ToolPart => ({
                  ...part,
                  state: {
                    status: "completed",
                    input: args,
                    output: nativeResult.output,
                    title: nativeResult.title,
                    metadata,
                    time: { start: started, end: Date.now() },
                    attachments: childAttachments.map((attachment) => ({
                      ...attachment,
                      id: PartID.ascending(),
                      sessionID: ctx.sessionID,
                      messageID: ctx.messageID,
                    })),
                  },
                })
                let committedPart: SessionV1.ToolPart | undefined
                const execCommitted = execSessions
                  ? yield* execSessions.commitOriginal({
                      sessionID: part.sessionID,
                      messageID: part.messageID,
                      callID: part.callID,
                      update: (current, metadata) => {
                        committedPart =
                          current.state.status === "running"
                            ? complete(current, { ...nativeResult.metadata, ...metadata })
                            : current
                        return committedPart
                      },
                    })
                  : false
                if (execCommitted && committedPart) {
                  projected.set(index, committedPart)
                  yield* publish()
                } else {
                  yield* updateProjected(index, (part) => complete(part))
                }
                return collectNative(entry, nativeResult)
              }
              const value = projectMcpResult(result as CallToolResult, (attachment) =>
                childAttachments.push(attachment),
              )
              attachments.push(...childAttachments)
              yield* updateProjected(index, (part) => ({
                ...part,
                state: {
                  status: "completed",
                  input: args,
                  output: typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? ""),
                  title: entry.key,
                  metadata: {},
                  time: { start: started, end: Date.now() },
                  attachments: childAttachments.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: ctx.messageID,
                  })),
                },
              }))
              return value
            }).pipe(
              Effect.onExit((exit) => {
                if (Exit.isSuccess(exit)) return Effect.void
                const message = Cause.hasInterruptsOnly(exit.cause)
                  ? "Tool call cancelled."
                  : (() => {
                      const error = Cause.squash(exit.cause)
                      return error instanceof Error ? error.message : String(error)
                    })()
                return updateProjected(runtimeCall.index, (part) =>
                  part.state.status === "running"
                    ? {
                        ...part,
                        state: {
                          status: "error",
                          input: part.state.input,
                          error: message,
                          metadata: part.state.metadata,
                          time: { start: part.state.time.start, end: Date.now() },
                        },
                      }
                    : part,
                )
              }),
              (effect) => {
                if (entry._tag !== "native") return effect
                const options = entry.native.codeMode
                const permits = options?.concurrency === "serial" ? 1 : options?.maxConcurrency
                if (!permits) return effect
                const key = options?.key?.(input) ?? options?.group ?? entry.key
                const lock = concurrency.get(key) ?? Semaphore.makeUnsafe(permits)
                concurrency.set(key, lock)
                return lock.withPermits(1)(effect)
              },
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                const error = Cause.squash(cause)
                return Effect.fail(toolError(error instanceof Error ? error.message : String(error), error))
              }),
            )

        const runtime = CodeMode.make<Record<string, Record<string, SandboxTool.Definition<never>>>>({
          tools: toolTree(catalog, callTool),
          limits: LIMITS,
          onToolCallStart: ({ index, name, input }) =>
            Effect.suspend(() => {
              const shown = (() => {
                if (input === null || input === undefined) return
                if (typeof input === "object" && !Array.isArray(input)) {
                  const value = input as Record<string, unknown>
                  return Object.keys(value).length > 0 ? value : undefined
                }
                return { input }
              })()
              calls[index] = {
                tool: name,
                status: "running",
                ...(shown ? { input: shown } : {}),
              }
              return publish()
            }),
          onToolCallEnd: ({ index, outcome }) =>
            Effect.suspend(() => {
              const current = calls[index]
              if (current)
                calls[index] = {
                  ...current,
                  status: outcome === "success" ? "completed" : "error",
                }
              return publish()
            }),
        })

        const abort = Effect.callback<void>((resume) => {
          if (ctx.abort.aborted) return resume(Effect.void)
          const handler = () => resume(Effect.void)
          ctx.abort.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
        })
        const cancelled = (): CodeMode.Result => ({
          ok: false,
          error: { kind: "ExecutionFailure", message: "Execution cancelled." },
          toolCalls: calls.map((call) => ({ name: call.tool })),
        })

        const result = yield* Effect.raceFirst(runtime.execute(params.code), abort.pipe(Effect.map(cancelled)))
        if (!result.ok && cleanups.length > 0) {
          yield* Effect.forEach(cleanups, (cleanup) => cleanup, { concurrency: "unbounded", discard: true })
        }
        const logs = result.logs ?? []
        const withLogs = (text: string) => {
          if (logs.length === 0) return text
          return text.length > 0 ? `${text}\n\nLogs:\n${logs.join("\n")}` : `Logs:\n${logs.join("\n")}`
        }

        if (!result.ok) {
          if (ctx.abort.aborted) {
            return {
              title: CODE_MODE_TOOL,
              metadata: metadata(true),
              output: "Execution cancelled.",
            } satisfies Tool.ExecuteResult<Metadata>
          }
          const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
          return yield* Effect.fail(new Error(withLogs([result.error.message, ...hints].join("\n"))))
        }

        // The interpreter validates returned values as plain JSON, so stringify cannot throw;
        // it yields undefined only for a program that returns undefined.
        const output =
          typeof result.value === "string"
            ? result.value
            : (JSON.stringify(result.value, null, 2) ?? String(result.value))

        return {
          title: CODE_MODE_TOOL,
          metadata: metadata(),
          output: withLogs(output),
          ...(attachments.length > 0 ? { attachments } : {}),
        } satisfies Tool.ExecuteResult<Metadata>
      }, Effect.orDie),
    }
    return init
  }),
)
