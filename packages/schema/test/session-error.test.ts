import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionError } from "../src/session-error.js"

describe("SessionError", () => {
  test("exports one identified open envelope", () => {
    expect(SessionError.Error.ast.annotations?.identifier).toBe("Session.StructuredError")
    expect(Object.keys(SessionError).filter((key) => key !== "SessionError").sort()).toEqual(["Error", "Resolution"])
  })

  test("round trips current and future error types through JSON", () => {
    const values: SessionError.Error[] = [
      { type: "provider.rate-limit", message: "Slow down" },
      { type: "provider.rate-limit", message: "Slow down", status: 429, response: { body: '{"error":{}}' } },
      { type: "provider.auth", message: "Authentication failed" },
      { type: "provider.future-condition", message: "A future provider failure" },
      { type: "unknown", message: "Unexpected" },
    ]
    const codec = Schema.fromJsonString(SessionError.Error)

    for (const value of values) {
      const encoded = Schema.encodeSync(codec)(value)
      expect(Schema.decodeUnknownSync(codec)(encoded)).toEqual(value)
    }
  })

  test("accepts future fields while exposing only the stable envelope", () => {
    expect(
      Schema.decodeUnknownSync(SessionError.Error)({
        type: "provider.timeout",
        message: "Timeout",
        retryAfterMs: 2_500,
      }),
    ).toEqual({ type: "provider.timeout", message: "Timeout" })
  })

  test("rejects missing envelope fields", () => {
    expect(() => Schema.decodeUnknownSync(SessionError.Error)({ type: "provider.auth" })).toThrow()
    expect(() => Schema.decodeUnknownSync(SessionError.Error)({ message: "Missing type" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(SessionError.Error)({ type: "provider.auth", message: "Failed", response: {} }),
    ).toThrow()
  })
})

test("session errors round-trip recovery hints and response diagnostics", () => {
  const value: SessionError.Error = {
    type: "provider.quota",
    message: "Usage limit reached",
    status: 429,
    resolution: { kind: "usage_limited", retry: "never", action: "switch_model", providerCode: "usage_limit_reached" },
    responseBody: '{"error":{"code":"usage_limit_reached"}}',
    responseHeaders: { "x-request-id": "request-1" },
    url: "https://example.com/responses",
  }
  expect(Schema.decodeUnknownSync(SessionError.Error)(Schema.encodeSync(SessionError.Error)(value))).toEqual(value)
})

test("session errors omit absent optional diagnostics", () => {
  expect(Schema.encodeSync(SessionError.Error)({ type: "unknown", message: "error", resolution: undefined })).toEqual({ type: "unknown", message: "error" })
  expect(SessionError.Resolution.ast.annotations?.identifier).toBe("Session.Error.Resolution")
})
