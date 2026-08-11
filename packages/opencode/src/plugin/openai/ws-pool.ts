import WebSocket from "ws"
import { ProviderError } from "@/provider/error"
import { isRecord } from "@/util/record"
import { OpenAIWebSocket } from "./ws"

export const TITLE_HEADER = "x-opencode-title"

export interface CreateWebSocketFetchOptions {
  httpFetch?: typeof globalThis.fetch
  url?: string
  turnState?: TurnState
  connectTimeout?: number
  idleTimeout?: number
  maxConnectionAge?: number
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
}

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
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

    const entry = pool.get(key) ?? { lastUsedAt: Date.now(), busy: false, fallback: false, streamFailures: 0 }
    pool.set(key, entry)

    if (entry.fallback) {
      return httpFetch(input, fallbackInit)
    }
    if (entry.busy) {
      return httpFetch(input, fallbackInit)
    }

    entry.busy = true
    entry.lastUsedAt = Date.now()
    try {
      entry.socket = await socket(
        entry,
        options?.url ?? request.url,
        OpenAIWebSocket.normalizeHeaders(httpInit?.headers),
        connectTimeout,
        maxConnectionAge,
        init?.signal,
      )
      let resolveFirstEvent: (event: boolean | OpenAIWebSocket.WrappedError) => void = () => {}
      let rejectFirstEvent: (error: Error) => void = () => {}
      const firstEvent = new Promise<boolean | OpenAIWebSocket.WrappedError>((resolve, reject) => {
        resolveFirstEvent = resolve
        rejectFirstEvent = reject
      })
      const response = OpenAIWebSocket.streamResponsesWebSocket({
        socket: entry.socket,
        body: bodyWithTurnState(request.body, options?.turnState, request.turnState),
        idleTimeout,
        signal: init?.signal ?? undefined,
        onEvent: (event) => captureTurnState(options?.turnState, event),
        onFirstEvent: (error) => resolveFirstEvent(error ?? true),
        onTerminal: (event) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          if (event.type !== "response.completed" && event.type !== "response.done") {
            invalidate(entry)
          }
        },
        onConnectionInvalid: (_error, closeCode) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          if (closeCode === OpenAIWebSocket.MESSAGE_TOO_BIG_CLOSE_CODE) entry.fallback = true
          else if (!entry.fallback) recordStreamFailure(entry)
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
        if (first === true || first.status < 200 || first.status > 599) return response
        return new Response(first.body, {
          status: first.status,
          headers: { "content-type": "application/json", ...first.headers },
        })
      }
      if (!entry.fallback) return response
      return httpFetch(input, fallbackInit)
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
      if (entry.fallback) return httpFetch(input, fallbackInit)
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
  if (isRecord(event.response.metadata) && isRecord(event.response.metadata.headers)) return event.response.metadata.headers
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
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
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

async function socket(
  entry: PoolEntry,
  url: string,
  headers: Record<string, string>,
  connectTimeout: number,
  maxConnectionAge: number,
  signal?: AbortSignal | null,
) {
  if (
    entry.socket?.readyState === WebSocket.OPEN &&
    entry.connectedAt &&
    Date.now() - entry.connectedAt < maxConnectionAge
  ) {
    return entry.socket
  }

  invalidate(entry)
  const next = await OpenAIWebSocket.connectResponsesWebSocket({
    url: OpenAIWebSocket.toWebSocketUrl(url),
    headers,
    timeout: connectTimeout,
    signal: signal ?? undefined,
  })
  entry.connectedAt = Date.now()
  return next
}

function invalidate(entry: PoolEntry) {
  if (entry.socket) {
    entry.socket.on("error", () => {})
    entry.socket.terminate()
    entry.socket = undefined
  }
  entry.connectedAt = undefined
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
