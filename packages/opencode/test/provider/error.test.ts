import { describe, expect, test } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { APICallError } from "ai"
import { ProviderError } from "../../src/provider/error"

const openai = ProviderV2.ID.make("openai")
const testProvider = ProviderV2.ID.make("test")

function responseFailed(code: string, message = code) {
  return {
    type: "response.failed",
    sequence_number: 1,
    response: { error: { code, message } },
  }
}

describe("provider error resolution", () => {
  test("retries overloaded server errors", () => {
    expect(
      ProviderError.resolve({
        providerID: openai,
        message: "Our servers are currently overloaded. Please try again later.",
        isRetryable: true,
        providerCode: "server_is_overloaded",
      }),
    ).toStrictEqual({
      isRetryable: true,
      resolution: {
        kind: "server",
        retry: "automatic",
        action: "retry",
        providerCode: "server_is_overloaded",
      },
    })
    expect(
      ProviderError.resolve({
        providerID: openai,
        message: "Our servers are currently overloaded. Please try again later.",
        isRetryable: true,
        providerCode: "slow_down",
      }),
    ).toMatchObject({
      isRetryable: true,
      resolution: { kind: "server", retry: "automatic", action: "retry", providerCode: "slow_down" },
    })
    expect(
      ProviderError.resolve({
        providerID: testProvider,
        message: "The upstream provider is overloaded.",
        isRetryable: true,
        providerCode: "server_is_overloaded",
      }),
    ).toStrictEqual({
      isRetryable: true,
      resolution: {
        kind: "server",
        retry: "automatic",
        action: "retry",
        providerCode: "server_is_overloaded",
      },
    })
  })

  test("classifies native Anthropic retryable stream errors", () => {
    expect(
      ProviderError.resolve({
        providerID: testProvider,
        message: "rate_limit_error: Slow down",
        isRetryable: true,
        providerCode: "rate_limit_error",
      }),
    ).toStrictEqual({
      isRetryable: true,
      resolution: {
        kind: "rate_limited",
        retry: "automatic",
        action: "wait",
        providerCode: "rate_limit_error",
      },
    })
    expect(
      ProviderError.resolve({
        providerID: testProvider,
        message: "overloaded_error: Overloaded",
        isRetryable: true,
        providerCode: "overloaded_error",
      }),
    ).toStrictEqual({
      isRetryable: true,
      resolution: {
        kind: "server",
        retry: "automatic",
        action: "retry",
        providerCode: "overloaded_error",
      },
    })
  })

  test("uses the provider retry delay for rate limits", () => {
    expect(
      ProviderError.resolve({
        providerID: openai,
        message: "Rate limit reached. Please try again in 1.5s.",
        isRetryable: true,
        providerCode: "rate_limit_exceeded",
      }),
    ).toStrictEqual({
      isRetryable: true,
      resolution: {
        kind: "rate_limited",
        retry: "automatic",
        action: "wait",
        retryAfterMs: 1500,
        providerCode: "rate_limit_exceeded",
      },
    })
  })

  test("uses the provider retry delay for server errors", () => {
    expect(
      ProviderError.resolve({
        providerID: openai,
        message: "Our servers are overloaded. Please try again in 30s.",
        isRetryable: false,
        providerCode: "server_is_overloaded",
      }),
    ).toStrictEqual({
      isRetryable: true,
      resolution: {
        kind: "server",
        retry: "automatic",
        action: "retry",
        retryAfterMs: 30_000,
        providerCode: "server_is_overloaded",
      },
    })
  })

  test("omits unavailable provider metadata", () => {
    expect(
      ProviderError.resolve({
        providerID: testProvider,
        message: "Too many requests",
        isRetryable: true,
        statusCode: 429,
      }),
    ).toStrictEqual({
      isRetryable: true,
      resolution: {
        kind: "rate_limited",
        retry: "automatic",
        action: "wait",
      },
    })
  })

  test("does not retry quota errors without a provider code", () => {
    expect(
      ProviderError.resolve({
        providerID: testProvider,
        message: "Provider request failed with HTTP 429: quota exceeded",
        isRetryable: true,
        statusCode: 429,
      }),
    ).toStrictEqual({
      isRetryable: false,
      resolution: {
        kind: "quota_exceeded",
        retry: "never",
        action: "manage_billing",
      },
    })
  })

  test("stops retries for usage limits and policy blocks", () => {
    expect(
      ProviderError.resolve({
        providerID: openai,
        message: "Usage limit reached",
        isRetryable: true,
        providerCode: "usage_limit_reached",
        statusCode: 429,
      }),
    ).toMatchObject({
      isRetryable: false,
      resolution: { kind: "usage_limited", retry: "never", action: "switch_model" },
    })
    expect(
      ProviderError.resolve({
        providerID: openai,
        message: "Quota exceeded",
        isRetryable: true,
        providerCode: "insufficient_quota",
        statusCode: 429,
      }),
    ).toMatchObject({
      isRetryable: false,
      resolution: { kind: "quota_exceeded", retry: "never", action: "manage_billing" },
    })
    expect(
      ProviderError.resolve({
        providerID: testProvider,
        message: "This request was blocked.",
        isRetryable: true,
        providerCode: "cyber_policy",
      }),
    ).toMatchObject({
      isRetryable: false,
      resolution: { kind: "policy_blocked", retry: "never", action: "fix_input" },
    })
    expect(
      ProviderError.resolve({
        providerID: openai,
        message: "Invalid input",
        isRetryable: true,
        providerCode: "invalid_request_error",
      }),
    ).toStrictEqual({
      isRetryable: false,
      resolution: {
        kind: "invalid_input",
        retry: "never",
        action: "fix_input",
        providerCode: "invalid_request_error",
      },
    })
  })

  test("directs models excluded by the current plan to model selection", () => {
    expect(
      ProviderError.resolve({
        providerID: openai,
        message: "Upgrade to Plus to use this model.",
        isRetryable: false,
        providerCode: "usage_not_included",
        statusCode: 429,
      }),
    ).toMatchObject({
      isRetryable: false,
      resolution: { kind: "plan_not_included", retry: "never", action: "switch_model" },
    })
  })

  test("classifies provider codes from parsed API error data", () => {
    const parsed = ProviderError.parseAPICallError({
      providerID: openai,
      error: new APICallError({
        message: "Service unavailable",
        url: "https://example.test/v1/responses",
        requestBodyValues: {},
        statusCode: 503,
        data: { error: { code: "server_is_overloaded", message: "Try another model" } },
      }),
    })
    expect(parsed).toMatchObject({
      type: "api_error",
      isRetryable: true,
      resolution: { kind: "server", retry: "automatic", action: "retry", providerCode: "server_is_overloaded" },
    })
  })

  test("classifies provider codes nested in response.failed API errors", () => {
    const parse = (code: string, statusCode = 500) =>
      ProviderError.parseAPICallError({
        providerID: openai,
        error: new APICallError({
          message: code,
          url: "https://example.test/v1/responses",
          requestBodyValues: {},
          statusCode,
          data: responseFailed(code),
          responseBody: JSON.stringify(responseFailed(code)),
          isRetryable: false,
        }),
      })

    expect(parse("server_is_overloaded", 503)).toMatchObject({
      type: "api_error",
      isRetryable: true,
      resolution: { kind: "server", retry: "automatic", action: "retry", providerCode: "server_is_overloaded" },
    })
    expect(parse("usage_not_included")).toMatchObject({
      type: "api_error",
      isRetryable: false,
      resolution: { kind: "plan_not_included", retry: "never", action: "switch_model", providerCode: "usage_not_included" },
    })
    expect(parse("usage_limit_reached")).toMatchObject({
      type: "api_error",
      isRetryable: false,
      resolution: { kind: "usage_limited", retry: "never", action: "switch_model", providerCode: "usage_limit_reached" },
    })
    expect(parse("cyber_policy")).toMatchObject({
      type: "api_error",
      isRetryable: false,
      resolution: { kind: "policy_blocked", retry: "never", action: "fix_input", providerCode: "cyber_policy" },
    })
  })

  test("classifies response.failed stream payloads after output", () => {
    expect(ProviderError.parseStreamError(responseFailed("server_is_overloaded", "Overloaded"), openai)).toMatchObject({
      type: "api_error",
      message: "Overloaded",
      isRetryable: true,
      resolution: { kind: "server", retry: "automatic", action: "retry", providerCode: "server_is_overloaded" },
    })
    expect(ProviderError.parseStreamError(responseFailed("slow_down"), openai)).toMatchObject({
      type: "api_error",
      isRetryable: true,
      resolution: { kind: "server", retry: "automatic", action: "retry", providerCode: "slow_down" },
    })
    expect(ProviderError.parseStreamError(responseFailed("usage_not_included"), openai)).toMatchObject({
      type: "api_error",
      isRetryable: false,
      resolution: { kind: "plan_not_included", retry: "never", action: "switch_model", providerCode: "usage_not_included" },
    })
  })

  test("does not retry context overflow provider codes", () => {
    expect(
      ProviderError.resolve({
        providerID: openai,
        message: "Input is too large",
        isRetryable: true,
        providerCode: "context_length_exceeded",
      }),
    ).toMatchObject({ isRetryable: false })
  })
})

describe("provider stream errors", () => {
  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })
})
