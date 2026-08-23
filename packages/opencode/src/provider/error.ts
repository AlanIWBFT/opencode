import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { isContextOverflow } from "@opencode-ai/llm"

export class HeaderTimeoutError extends Error {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(public readonly ms: number) {
    super(`Provider response headers timed out after ${ms}ms`)
  }
}

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function message(providerID: ProviderV2.ID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

function providerFailure(input: unknown) {
  const body = json(input)
  if (!isRecord(body)) return undefined
  const response = isRecord(body.response) ? body.response : undefined
  const error = isRecord(response?.error) ? response.error : isRecord(body.error) ? body.error : body
  return { body, error }
}

function providerCode(input: unknown) {
  const failure = providerFailure(input)
  if (!failure) return undefined
  const { body, error } = failure
  if (typeof error.code === "string") return error.code
  if (error === body && (error.type === "error" || error.type === "response.failed")) return undefined
  if (typeof error.type === "string") return error.type
  return undefined
}

export function retryAfterMs(input: { headers?: Record<string, string>; message: string }) {
  const headers = input.headers
  const milliseconds = header(headers, "retry-after-ms")
  if (milliseconds) {
    const value = Number(milliseconds)
    if (Number.isFinite(value)) return Math.max(0, Math.ceil(value))
  }
  const retryAfter = header(headers, "retry-after")
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000))
    const date = Date.parse(retryAfter)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  const match = /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)/i.exec(input.message)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  return match[2].toLowerCase() === "ms" ? Math.ceil(value) : Math.ceil(value * 1000)
}

function header(headers: Record<string, string> | undefined, name: string) {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]
}

export type APIErrorResolution = SessionV1.APIErrorResolution

export function resolve(input: {
  providerID?: ProviderV2.ID
  message: string
  isRetryable: boolean
  providerCode?: string
  statusCode?: number
  responseBody?: string
  responseHeaders?: Record<string, string>
  retryAfterMs?: number
}): { resolution?: APIErrorResolution; isRetryable: boolean } {
  const code = input.providerCode ?? providerCode(input.responseBody)
  const retryAfter =
    input.retryAfterMs !== undefined && Number.isFinite(input.retryAfterMs)
      ? Math.max(0, Math.ceil(input.retryAfterMs))
      : retryAfterMs({ headers: input.responseHeaders, message: input.message })
  const providerCodeData = code ? { providerCode: code } : {}
  const rateLimited = code === "rate_limit_exceeded" || code === "rate_limit_error"
  const serverError =
    code === "api_error" ||
    code === "internal_error" ||
    code === "overloaded_error" ||
    code === "server_error" ||
    code === "server_is_overloaded" ||
    code === "slow_down"
  const quotaExceeded =
    code === "insufficient_quota" || /insufficient[-_\s]?quota|quota[-_\s]?exceeded/i.test(`${input.message}\n${input.responseBody ?? ""}`)
  const resolution = iife(() => {
    if (rateLimited)
      return {
        kind: "rate_limited" as const,
        retry: "automatic" as const,
        action: "wait" as const,
        ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
        ...providerCodeData,
      }
    if (code === "usage_limit_reached")
      return {
        kind: "usage_limited" as const,
        retry: "never" as const,
        action: "switch_model" as const,
        ...providerCodeData,
      }
    if (code === "usage_not_included")
      return {
        kind: "plan_not_included" as const,
        retry: "never" as const,
        action: "switch_model" as const,
        ...providerCodeData,
      }
    if (quotaExceeded)
      return {
        kind: "quota_exceeded" as const,
        retry: "never" as const,
        action: "manage_billing" as const,
        ...providerCodeData,
      }
    if (input.statusCode === 429)
      return {
        kind: "rate_limited" as const,
        retry: "automatic" as const,
        action: "wait" as const,
        ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
        ...providerCodeData,
      }
    if (code === "cyber_policy" || code === "bio_policy")
      return {
        kind: "policy_blocked" as const,
        retry: "never" as const,
        action: "fix_input" as const,
        ...providerCodeData,
      }
    if (code === "invalid_prompt" || code === "invalid_request_error")
      return {
        kind: "invalid_input" as const,
        retry: "never" as const,
        action: "fix_input" as const,
        ...providerCodeData,
      }
    if (input.statusCode === 403 && /cloudflare.*blocked|blocked.*cloudflare/i.test(input.responseBody ?? ""))
      return { kind: "network" as const, retry: "never" as const, action: "check_network" as const, ...providerCodeData }
    if (input.statusCode === 401 || input.statusCode === 403)
      return { kind: "authentication" as const, retry: "never" as const, action: "reauthenticate" as const, ...providerCodeData }
    if (serverError || input.statusCode !== undefined && input.statusCode >= 500)
      return {
        kind: "server" as const,
        retry: "automatic" as const,
        action: "retry" as const,
        ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
        ...providerCodeData,
      }
    return undefined
  })
  return {
    resolution,
    isRetryable: code === "context_length_exceeded" ? false : resolution ? resolution.retry === "automatic" : input.isRetryable,
  }
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
      resolution?: APIErrorResolution
    }

export function parseStreamError(input: unknown, providerID?: ProviderV2.ID): ParsedStreamError | undefined {
  const raw = json(input)
  const body = isRecord(raw) && typeof raw.message === "string" ? (json(raw.message) ?? raw) : raw
  if (!isRecord(body) || (body.type !== "error" && body.type !== "response.failed")) return

  const responseBody = JSON.stringify(body)
  const failure = providerFailure(body)
  if (!failure) return
  const error = failure.error
  const code = providerCode(body)
  const message = typeof error.message === "string" ? error.message : undefined
  if (code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: "Input exceeds context window of this model",
      responseBody,
    }
  }

  const resolved = resolve({
    providerID,
    message: message ?? "Provider stream error",
    isRetryable: false,
    providerCode: code,
    responseBody,
  })
  if (!resolved.resolution)
    return {
      type: "api_error",
      message: message ?? "Server error.",
      isRetryable: true,
      responseBody,
    }
  return {
    type: "api_error",
    message:
      code === "insufficient_quota"
        ? "Quota exceeded. Check your plan and billing details."
        : code === "usage_not_included"
          ? "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus."
          : message ??
            (code === "invalid_prompt" || code === "invalid_request_error"
              ? "Invalid prompt."
              : resolved.resolution.kind === "server"
                ? "Server error."
                : code ?? "Provider error."),
    isRetryable: resolved.isRetryable,
    responseBody,
    resolution: resolved.resolution,
  }

}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
      resolution?: APIErrorResolution
    }

export function parseAPICallError(input: { providerID: ProviderV2.ID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.data) ?? json(input.error.responseBody)
  if (
    isContextOverflow(m) ||
    input.error.statusCode === 413 ||
    providerCode(body) === "context_length_exceeded"
  ) {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  const resolved = resolve({
    providerID: input.providerID,
    message: m,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    providerCode: providerCode(body),
    statusCode: input.error.statusCode,
    responseBody: input.error.responseBody,
    responseHeaders: input.error.responseHeaders,
  })
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: resolved.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
    ...(resolved.resolution ? { resolution: resolved.resolution } : {}),
  }
}

export * as ProviderError from "./error"
