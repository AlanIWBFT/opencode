import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, Exit, Layer, Result } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import type { ExplicitCompactionResult } from "./llm/ai-sdk"
import { LLMNativeRuntime, type TurnState } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { OpenAINativeCompaction } from "./openai-native-compaction"

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

const CODEX_BETA_FEATURES_HEADER = "x-codex-beta-features"
const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2"

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  nativeCompactionWindow?: OpenAINativeCompaction.Window
  turnState?: TurnState
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
  readonly compact: (input: StreamInput) => Effect.Effect<ExplicitCompactionResult, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })
      if (input.nativeCompactionWindow && !OpenAINativeCompaction.supportsModel(input.model))
        return yield* Effect.fail(new Error("OpenAI Responses compaction replay requires the official OpenAI provider"))

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm && !input.nativeCompactionWindow) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: OpenAINativeCompaction.supportsModel(input.model)
            ? withRemoteCompactionV2(prepared.headers)
            : prepared.headers,
          abort: input.abort,
          turnState: input.turnState,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      const headers = {
        ...prepared.headers,
        ...LLMNativeRuntime.withTurnStateHeaders({ model: input.model, turnState: input.turnState }),
      }
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      const providerOptions = ProviderTransform.providerOptions(input.model, {
        ...prepared.params.options,
        ...(input.nativeCompactionWindow
          ? {
              opencode: {
                version: 1,
                instructions: prepared.system.join("\n"),
                replayInput: input.nativeCompactionWindow.output,
              },
            }
          : {}),
      })

      return {
        type: "ai-sdk" as const,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks:
            input.model.providerID.includes("github-copilot") ||
            LLMNativeRuntime.usesOpenAITurnState({ model: input.model, turnState: input.turnState }),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions,
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: OpenAINativeCompaction.supportsModel(input.model) ? withRemoteCompactionV2(headers) : headers,
          maxRetries: input.retries ?? 0,
          // OpenAI OAuth carries the system prompt in `instructions`. Give AI SDK
          // a message to validate; the private provider contract removes it from input.
          messages:
            input.nativeCompactionWindow && prepared.messages.length === 0
              ? [{ role: "system", content: prepared.system.join("\n") }]
              : prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const compact: Interface["compact"] = Effect.fn("LLM.compact")(function* (input) {
      const [language, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow: false,
      })
      if (!OpenAINativeCompaction.supportsModel(input.model))
        return yield* Effect.fail(
          new Error("OpenAI Responses explicit compaction requires the official OpenAI provider"),
        )

      // The hidden compaction agent prompt belongs to text-summary fallback, not opaque compaction.
      const options = { ...prepared.params.options }
      delete options.instructions
      const bridge = yield* EffectBridge.make()
      const attempt = Effect.fnUntraced(function* () {
        const compactResult = yield* Effect.tryPromise({
          try: (abortSignal) => {
            const result = streamText({
              includeRawChunks: true,
              onError(error) {
                bridge.fork(Effect.logError("explicit compaction stream error", { error }))
              },
              temperature: prepared.params.temperature,
              topP: prepared.params.topP,
              topK: prepared.params.topK,
              providerOptions: ProviderTransform.providerOptions(input.model, {
                ...options,
                opencode: {
                  version: 1,
                  explicitCompaction: true,
                  ...(input.nativeCompactionWindow ? { replayInput: input.nativeCompactionWindow.output } : {}),
                },
              }),
              tools: {},
              maxOutputTokens: prepared.params.maxOutputTokens,
              headers: withRemoteCompactionV2({
                ...prepared.headers,
                ...LLMNativeRuntime.withTurnStateHeaders({ model: input.model, turnState: input.turnState }),
              }),
              maxRetries: 0,
              messages: prepared.messages.filter((message) => message.role !== "system"),
              model: wrapLanguageModel({
                model: language,
                middleware: [
                  {
                    specificationVersion: "v3" as const,
                    async transformParams(args) {
                      if (args.type === "stream") {
                        // @ts-expect-error
                        args.params.prompt = ProviderTransform.message(
                          args.params.prompt,
                          input.model,
                          prepared.messageTransformOptions,
                        )
                      }
                      return args.params
                    },
                  },
                ],
              }),
              abortSignal,
            })
            return LLMAISDK.collectExplicitCompaction(result, (metadata) =>
              LLMNativeRuntime.captureTurnState(input.turnState, metadata),
            )
          },
          catch: (error) =>
            error instanceof LLMAISDK.ExplicitCompactionError
              ? error
              : new LLMAISDK.ExplicitCompactionError({
                  message: "OpenAI Responses explicit compaction stream failed",
                  retryable: false,
                  cause: error,
                }),
        })
        LLMNativeRuntime.captureTurnState(input.turnState, compactResult.providerMetadata)
        return compactResult
      })

      for (let retry = 0; ; retry++) {
        const exit = yield* attempt().pipe(Effect.exit)
        if (exit._tag === "Success") return exit.value
        const found = Exit.findError(exit)
        const failure = Result.isSuccess(found) ? found.success : undefined
        if (!(failure instanceof LLMAISDK.ExplicitCompactionError) || !failure.retryable || retry >= 2)
          return yield* Effect.failCause(exit.cause)
        const delay = failure.retryAfterMs ?? 200 * 2 ** retry
        yield* Effect.sleep(`${delay} millis`)
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            if (result.type === "native") return result.stream

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
              Stream.tap((event) => Effect.sync(() => LLMNativeRuntime.captureTurnState(input.turnState, event))),
            )
          }),
        ),
      )

    return Service.of({ stream, compact })
  }),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

function withRemoteCompactionV2(headers: Record<string, string>) {
  const current = Object.entries(headers).find(([key]) => key.toLowerCase() === CODEX_BETA_FEATURES_HEADER)
  const features = (current?.[1] ?? "")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean)
  if (!features.includes(REMOTE_COMPACTION_V2_FEATURE)) features.push(REMOTE_COMPACTION_V2_FEATURE)
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== CODEX_BETA_FEATURES_HEADER)),
    [current?.[0] ?? CODEX_BETA_FEATURES_HEADER]: features.join(","),
  }
}

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
  ],
})

export * as LLM from "./llm"
