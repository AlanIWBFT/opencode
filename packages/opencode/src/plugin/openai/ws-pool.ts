import { isDeepStrictEqual } from "node:util"
import { APICallError } from "ai"
import WebSocket from "ws"
import { ProviderError } from "@/provider/error"
import { isRecord } from "@/util/record"
import { OpenAIWebSocket } from "./ws"

export const TITLE_HEADER = "x-opencode-title"

export interface CreateWebSocketFetchOptions {
  httpFetch?: typeof globalThis.fetch
  url?: string
  turnState?: TurnState
  diagnostic?: (message: string, extra: Record<string, unknown>) => void
  connectTimeout?: number
  idleTimeout?: number
  maxConnectionAge?: number
  maxMessageBytes?: number
  streamRetries?: number
}

type TurnState = { value?: string }

interface PoolEntry {
  socket?: WebSocket
  connectedAt?: number
  lastUsedAt: number
  busy: boolean
  fallback: boolean
  streamFailures: number
  maxMessageBytes: number
  continuationEpoch: number
  continuation?: Continuation
}

interface Continuation {
  responseID: string
  requestBody: Record<string, unknown>
  responseOutput: unknown[]
}

interface OutputTracker {
  indexed: Map<number, unknown>
  unordered: unknown[]
  terminal?: unknown[]
}

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const DEFAULT_MAX_MESSAGE_BYTES = 15 * 1024 * 1024
const FIRST_EVENT_GRACE_TIMEOUT = 100
const HEADER_TIMEOUT_BUFFER = 1_000
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached"
const TURN_STATE_HEADER = "x-codex-turn-state"

export function createWebSocketFetch(options?: CreateWebSocketFetchOptions) {
  const httpFetch = options?.httpFetch ?? globalThis.fetch
  const pool = new Map<string, PoolEntry>()
  const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
  const maxConnectionAge = options?.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const maxMessageBytes = options?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
  const streamRetries = options?.streamRetries ?? 5
  const pruneTimer = setInterval(() => prune(), Math.min(idleTimeout, 60_000))
  if (typeof pruneTimer === "object" && "unref" in pruneTimer && typeof pruneTimer.unref === "function") {
    pruneTimer.unref()
  }

  function websocketHeaderTimeout(input: RequestInfo | URL, init: RequestInit | undefined, timeout: number) {
    if (!websocketRequest(input, init)) return timeout
    return Math.max(timeout, connectTimeout + FIRST_EVENT_GRACE_TIMEOUT + HEADER_TIMEOUT_BUFFER)
  }

  async function websocketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const httpInit = withoutInternalHeaders(init)
    const request = websocketRequest(input, init)
    if (!request) {
      return httpFetch(input, httpInit)
    }
    const fallbackInit = withTurnStateHeader(httpInit, options?.turnState)
    const key = `${request.sessionID}:conversation`
    const useHttp = (reason: string, extra?: Record<string, unknown>) => {
      report("openai responses transport", {
        sessionID: request.sessionID,
        transport: "http",
        reason,
        ...extra,
      })
      return httpFetch(input, fallbackInit)
    }

    const entry = pool.get(key) ?? {
      lastUsedAt: Date.now(),
      busy: false,
      fallback: false,
      streamFailures: 0,
      maxMessageBytes,
      continuationEpoch: 0,
    }
    pool.set(key, entry)

    if (entry.fallback) {
      clearContinuation(entry)
      return useHttp("sticky-fallback")
    }
    if (entry.busy) {
      clearContinuation(entry)
      return useHttp("socket-busy")
    }

    entry.busy = true
    entry.lastUsedAt = Date.now()
    try {
      const reusedSocket = reusableSocket(entry, maxConnectionAge)
      if (!reusedSocket) invalidate(entry)
      const fullBody = bodyWithTurnState(request.body, options?.turnState, request.turnState)
      const body = continueRequest(entry.continuation, fullBody)
      const continuation = body !== fullBody
      const message = OpenAIWebSocket.responseCreateMessage(body)
      const messageBytes = Buffer.byteLength(message)
      if (messageBytes > entry.maxMessageBytes) {
        entry.busy = false
        entry.lastUsedAt = Date.now()
        invalidate(entry)
        return useHttp("message-too-large", {
          messageBytes,
          maxMessageBytes: entry.maxMessageBytes,
          continuation,
        })
      }

      entry.socket = await socket(
        entry,
        options?.url ?? request.url,
        OpenAIWebSocket.normalizeHeaders(httpInit?.headers),
        connectTimeout,
        maxConnectionAge,
        init?.signal,
      )
      report("openai responses transport", {
        sessionID: request.sessionID,
        transport: "websocket",
        socket: reusedSocket ? "reused" : "new",
        continuation,
        messageBytes,
        maxMessageBytes: entry.maxMessageBytes,
      })
      const requestEpoch = entry.continuationEpoch
      const output: OutputTracker = { indexed: new Map(), unordered: [] }
      let invalidConnection: OpenAIWebSocket.ConnectionInvalidInfo | undefined
      let resolveFirstEvent: (event: boolean | OpenAIWebSocket.WrappedError) => void = () => {}
      let rejectFirstEvent: (error: Error) => void = () => {}
      const firstEvent = new Promise<boolean | OpenAIWebSocket.WrappedError>((resolve, reject) => {
        resolveFirstEvent = resolve
        rejectFirstEvent = reject
      })
      const response = OpenAIWebSocket.streamResponsesWebSocket({
        socket: entry.socket,
        body,
        message,
        idleTimeout,
        signal: init?.signal ?? undefined,
        onEvent: (event) => {
          captureTurnState(options?.turnState, event)
          captureOutput(output, event)
        },
        onFirstEvent: (error) => resolveFirstEvent(error ?? true),
        onComplete: (event) => captureContinuation(entry, requestEpoch, fullBody, output, event),
        onTerminal: (event) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          if (event.type !== "response.completed" && event.type !== "response.done") {
            invalidate(entry)
          }
        },
        onConnectionInvalid: (_error, info) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          invalidConnection = info
          if (info.closeCode === OpenAIWebSocket.MESSAGE_TOO_BIG_CLOSE_CODE) {
            const previousMaxMessageBytes = entry.maxMessageBytes
            entry.maxMessageBytes = Math.min(entry.maxMessageBytes, Math.max(1, Math.floor(messageBytes * 0.9)))
            report("openai websocket message too large", {
              sessionID: request.sessionID,
              closeCode: info.closeCode,
              emitted: info.emitted,
              messageBytes,
              previousMaxMessageBytes,
              maxMessageBytes: entry.maxMessageBytes,
            })
          } else if (!entry.fallback) {
            recordStreamFailure(entry)
          }
          invalidate(entry)
          resolveFirstEvent(false)
        },
        onAbort: (error) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          invalidate(entry)
          rejectFirstEvent(error)
        },
        onRetryableTerminal: async (event) => {
          const error = connectionLimitError(event)
          if (!error) return undefined
          throw error
        },
      })
      // Preserve fast pre-stream error/fallback behavior without treating model
      // first-token latency as HTTP response-header latency.
      const first = await Promise.race([
        firstEvent,
        new Promise<true>((resolve) => setTimeout(() => resolve(true), FIRST_EVENT_GRACE_TIMEOUT)),
      ])
      if (first !== false) {
        if (first === true) {
          return retry1009Response(
            response,
            () =>
              useHttp("websocket-1009", {
                messageBytes,
                maxMessageBytes: entry.maxMessageBytes,
              }),
            () => invalidConnection,
            request.url,
            fullBody,
          )
        }
        if (first.status < 200 || first.status > 599) return response
        return new Response(first.body, {
          status: first.status,
          headers: { "content-type": "application/json", ...first.headers },
        })
      }
      if (invalidConnection?.closeCode === 1009 && !invalidConnection.emitted) {
        return useHttp("websocket-1009", {
          messageBytes,
          maxMessageBytes: entry.maxMessageBytes,
        })
      }
      if (!entry.fallback) return response
      return useHttp("websocket-failures")
    } catch (error) {
      entry.busy = false
      entry.lastUsedAt = Date.now()
      if (OpenAIWebSocket.isAbortError(error)) {
        entry.streamFailures = 0
        invalidate(entry)
        throw error
      }

      recordStreamFailure(entry)
      invalidate(entry)
      if (entry.fallback) return useHttp("websocket-failures")
      return failedResponse(
        new ProviderError.ResponseStreamError(error instanceof Error ? error.message : String(error), {
          cause: error,
        }),
      )
    }
  }

  function recordStreamFailure(entry: PoolEntry) {
    entry.streamFailures++
    // Codex counts retries after the initial failed WebSocket attempt.
    if (entry.streamFailures > streamRetries) entry.fallback = true
  }

  function report(message: string, extra: Record<string, unknown>) {
    try {
      options?.diagnostic?.(message, extra)
    } catch {}
  }

  function prune() {
    const now = Date.now()
    for (const [key, entry] of pool) {
      if (entry.busy) continue
      if (entry.fallback) continue
      if (now - entry.lastUsedAt < idleTimeout) continue
      invalidate(entry)
      pool.delete(key)
    }
  }

  function close() {
    clearInterval(pruneTimer)
    for (const entry of pool.values()) invalidate(entry)
    pool.clear()
  }

  function remove(sessionID: string) {
    const key = `${sessionID}:conversation`
    const entry = pool.get(key)
    if (!entry) return
    invalidate(entry)
    pool.delete(key)
  }

  return Object.assign(websocketFetch, { close, remove, providerHeaderTimeout: websocketHeaderTimeout })
}

function continueRequest(continuation: Continuation | undefined, body: Record<string, unknown>) {
  if (!continuation || hasPreviousResponse(body)) return body

  const previousInput = continuation.requestBody.input
  const currentInput = body.input
  if (!Array.isArray(previousInput) || !Array.isArray(currentInput)) return body
  if (!isDeepStrictEqual(requestContext(continuation.requestBody), requestContext(body))) {
    return body
  }
  if (currentInput.length < previousInput.length + continuation.responseOutput.length) {
    return body
  }
  for (let index = 0; index < previousInput.length; index++) {
    if (!isDeepStrictEqual(requestItem(previousInput[index]), requestItem(currentInput[index]))) {
      return body
    }
  }
  for (let index = 0; index < continuation.responseOutput.length; index++) {
    const current = currentInput[previousInput.length + index]
    if (!isDeepStrictEqual(responseOutputItem(continuation.responseOutput[index]), responseOutputItem(current))) {
      return body
    }
  }

  return {
    ...body,
    previous_response_id: continuation.responseID,
    input: currentInput.slice(previousInput.length + continuation.responseOutput.length),
  }
}

function captureContinuation(
  entry: PoolEntry,
  epoch: number,
  requestBody: Record<string, unknown>,
  output: OutputTracker,
  event: Record<string, unknown>,
) {
  if (entry.continuationEpoch !== epoch) return
  captureOutput(output, event)
  const response = isRecord(event.response) ? event.response : undefined
  const responseID = response?.id
  if (typeof responseID !== "string" || !Array.isArray(requestBody.input) || hasPreviousResponse(requestBody)) {
    clearContinuation(entry)
    return
  }

  entry.continuation = {
    responseID,
    requestBody,
    responseOutput:
      output.terminal ??
      [...output.indexed.entries()]
        .sort(([left], [right]) => left - right)
        .map((entry) => entry[1])
        .concat(output.unordered),
  }
}

function captureOutput(output: OutputTracker, event: Record<string, unknown>) {
  if (
    (event.type === "response.completed" || event.type === "response.done") &&
    isRecord(event.response) &&
    Array.isArray(event.response.output)
  ) {
    output.terminal = event.response.output
  }
  if (event.type !== "response.output_item.done" || !isRecord(event.item)) return
  if (typeof event.output_index === "number") {
    output.indexed.set(event.output_index, event.item)
    return
  }
  output.unordered.push(event.item)
}

function hasPreviousResponse(body: Record<string, unknown>) {
  return body.previous_response_id !== undefined && body.previous_response_id !== null
}

function requestContext(body: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key]) =>
        !["input", "previous_response_id", "client_metadata", "stream", "background", "stream_options"].includes(key),
    ),
  )
}

function requestItem(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(requestItem)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "internal_chat_message_metadata_passthrough")
      .map(([key, item]) => [key, requestItem(item)]),
  )
}

function responseOutputItem(value: unknown, topLevel = true): unknown {
  if (Array.isArray(value)) return value.map((item) => responseOutputItem(item, false))
  if (!isRecord(value)) return value
  const type = value.type
  if (topLevel && (type === "message" || (type === undefined && value.role === "assistant"))) {
    return {
      role: "assistant",
      content: responseOutputItem(value.content, false),
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(value.phase === "commentary" || value.phase === "final_answer" ? { phase: value.phase } : {}),
    }
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (key === "internal_chat_message_metadata_passthrough") return []
      if (topLevel && key === "status") return []
      if (topLevel && type === "function_call" && key === "id") return []
      if (key === "annotations" || key === "logprobs") return []
      if ((key === "phase" || key === "namespace") && item === null) return []
      if (topLevel && type === "reasoning" && key === "encrypted_content" && item === null) return []
      return [[key, responseOutputItem(item, false)]]
    }),
  )
}

function clearContinuation(entry: PoolEntry) {
  entry.continuation = undefined
  entry.continuationEpoch++
}

function bodyWithTurnState(body: Record<string, unknown>, state: TurnState | undefined, value: string | undefined) {
  const turnState = state?.value ?? value
  if (!turnState) return body
  const clientMetadata = isRecord(body.client_metadata) ? stringRecord(body.client_metadata) : {}
  return { ...body, client_metadata: { ...clientMetadata, [TURN_STATE_HEADER]: turnState } }
}

function withTurnStateHeader(init: RequestInit | undefined, state: TurnState | undefined) {
  if (!state?.value) return init
  const headers = new Headers(init?.headers)
  headers.set(TURN_STATE_HEADER, state.value)
  return init ? { ...init, headers } : { headers }
}

function captureTurnState(state: TurnState | undefined, event: Record<string, unknown>) {
  if (!state || state.value) return
  const headers = eventHeaders(event)
  const value = headers ? headerValue(headers, TURN_STATE_HEADER) : undefined
  if (value) state.value = value
}

function eventHeaders(event: Record<string, unknown>) {
  if (isRecord(event.headers)) return event.headers
  if (isRecord(event.metadata) && isRecord(event.metadata.headers)) return event.metadata.headers
  if (!isRecord(event.response)) return undefined
  if (isRecord(event.response.headers)) return event.response.headers
  if (isRecord(event.response.metadata) && isRecord(event.response.metadata.headers))
    return event.response.metadata.headers
  return undefined
}

function headerValue(headers: Record<string, unknown>, name: string) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  const value = found?.[1]
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string")
  return undefined
}

function stringRecord(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function websocketRequest(input: RequestInfo | URL, init: RequestInit | undefined) {
  const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url
  if (init?.method !== "POST" || !new URL(url).pathname.endsWith("/responses")) return

  const body = (() => {
    try {
      if (typeof init?.body !== "string") return undefined
      const parsed = JSON.parse(init.body)
      return typeof parsed === "object" && parsed !== null ? parsed : undefined
    } catch {
      return undefined
    }
  })()
  if (!body?.stream) return

  const internalHeaders = OpenAIWebSocket.normalizeHeaders(init.headers)
  if (internalHeaders[TITLE_HEADER] === "true") return

  const sessionID = internalHeaders["x-session-affinity"] ?? internalHeaders["session-id"]
  if (!sessionID) return
  return { url, body, sessionID, turnState: internalHeaders[TURN_STATE_HEADER] }
}

function connectionLimitError(event: Record<string, unknown>) {
  if (event.type !== "error" || !isRecord(event.error) || event.error.code !== CONNECTION_LIMIT_REACHED_CODE) return
  return new Error(typeof event.error.message === "string" ? event.error.message : CONNECTION_LIMIT_REACHED_CODE)
}

function failedResponse(error: ProviderError.ResponseStreamError) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error)
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

function retry1009Response(
  response: Response,
  fallback: () => Promise<Response>,
  invalidConnection: () => OpenAIWebSocket.ConnectionInvalidInfo | undefined,
  url: string,
  requestBodyValues: unknown,
) {
  if (!response.body) return response
  let reader = response.body.getReader()
  let retried = false

  async function read() {
    try {
      return await reader.read()
    } catch (error) {
      const invalid = invalidConnection()
      if (retried || invalid?.closeCode !== 1009 || invalid.emitted) throw error
      retried = true
      const next = await fallback()
      if (!next.ok) {
        const responseBody = await next.text()
        throw new APICallError({
          message: next.statusText || `HTTP ${next.status}`,
          url: next.url || url,
          requestBodyValues,
          statusCode: next.status,
          responseHeaders: Object.fromEntries(next.headers),
          responseBody,
        })
      }
      if (!next.body) return { done: true as const, value: undefined }
      reader = next.body.getReader()
      return reader.read()
    }
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await read()
          if (next.done) {
            controller.close()
            return
          }
          controller.enqueue(next.value)
        } catch (error) {
          controller.error(error)
        }
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  )
}

async function socket(
  entry: PoolEntry,
  url: string,
  headers: Record<string, string>,
  connectTimeout: number,
  maxConnectionAge: number,
  signal?: AbortSignal | null,
) {
  if (reusableSocket(entry, maxConnectionAge)) {
    return entry.socket
  }

  if (entry.socket || entry.connectedAt || entry.continuation) invalidate(entry)
  const next = await OpenAIWebSocket.connectResponsesWebSocket({
    url: OpenAIWebSocket.toWebSocketUrl(url),
    headers,
    timeout: connectTimeout,
    signal: signal ?? undefined,
  })
  entry.connectedAt = Date.now()
  return next
}

function reusableSocket(entry: PoolEntry, maxConnectionAge: number): entry is PoolEntry & { socket: WebSocket } {
  return Boolean(
    entry.socket?.readyState === WebSocket.OPEN &&
      entry.connectedAt &&
      Date.now() - entry.connectedAt < maxConnectionAge,
  )
}

function invalidate(entry: PoolEntry) {
  if (entry.socket) {
    entry.socket.on("error", () => {})
    entry.socket.terminate()
    entry.socket = undefined
  }
  entry.connectedAt = undefined
  clearContinuation(entry)
}

export function withoutInternalHeaders<T extends { headers?: HeadersInit }>(init: T | undefined): T | undefined {
  if (!init?.headers) return init
  if (init.headers instanceof Headers) {
    const headers = new Headers(init.headers)
    headers.delete(TITLE_HEADER)
    return { ...init, headers }
  }

  if (Array.isArray(init.headers)) {
    return { ...init, headers: init.headers.filter((item) => item[0].toLowerCase() !== TITLE_HEADER) }
  }

  return {
    ...init,
    headers: Object.fromEntries(Object.entries(init.headers).filter(([key]) => key.toLowerCase() !== TITLE_HEADER)),
  }
}

export * as OpenAIWebSocketPool from "./ws-pool"
