import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FileSystem } from "../src/filesystem"
import { SessionStatusEvent } from "../src/session-status-event"
import { SessionV1 } from "../src/v1/session"

describe("schema compatibility", () => {
  test("moved class schemas remain constructible", () => {
    const input = new FileSystem.FindInput({ query: "src" })
    expect(input).toBeInstanceOf(FileSystem.FindInput)
    expect(input.query).toBe("src")
  })

  test("maps legacy model capacity resolutions to retryable server errors", () => {
    const resolution = Schema.decodeUnknownSync(SessionStatusEvent.APIErrorResolution)({
      kind: "model_capacity",
      retry: "never",
      action: "switch_model",
      retryAfterMs: 250,
      providerCode: "server_is_overloaded",
    })

    expect(resolution).toEqual({
      kind: "server",
      retry: "automatic",
      action: "retry",
      retryAfterMs: 250,
      providerCode: "server_is_overloaded",
    })
    expect(Schema.encodeSync(SessionStatusEvent.APIErrorResolution)(resolution)).toEqual(resolution)
  })

  test("keeps API error retryability consistent after legacy resolution decoding", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)({
      name: "APIError",
      data: {
        message: "overloaded",
        isRetryable: false,
        resolution: { kind: "model_capacity", retry: "never", action: "switch_model" },
      },
    })

    expect(error.data).toMatchObject({
      isRetryable: true,
      resolution: { kind: "server", retry: "automatic", action: "retry" },
    })
    expect(Schema.encodeSync(SessionV1.APIError.Schema)(error)).toEqual(error)
  })
})
