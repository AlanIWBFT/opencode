import { Effect, Stream } from "effect"
import { HttpClientResponse } from "effect/http"

// Error-page diagnostics need a prefix, not an all-or-nothing download. Stop
// consuming at the limit and retain received bytes if the remaining stream fails.
export const collectResponsePrefix = (response: HttpClientResponse.HttpClientResponse, maximumBytes: number) =>
  Effect.gen(function* () {
    const body = Buffer.allocUnsafe(maximumBytes)
    let size = 0
    yield* Stream.runForEachWhile(response.stream, (chunk) =>
      Effect.sync(() => {
        const prefix = chunk.subarray(0, maximumBytes - size)
        body.set(prefix, size)
        size += prefix.byteLength
        return size < maximumBytes
      }),
    ).pipe(Effect.catch(() => Effect.void))
    return body.subarray(0, size)
  })

export const collectBoundedResponseBody = (
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes: number,
  tooLarge: () => Error,
) =>
  Effect.gen(function* () {
    const contentLength = response.headers["content-length"]
    const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined
    const declaredSize =
      parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined
    if (declaredSize !== undefined && declaredSize > maximumBytes) return yield* Effect.fail(tooLarge())
    let body = Buffer.allocUnsafe(Math.min(maximumBytes, declaredSize || 64 * 1024))
    let size = 0
    yield* Stream.runForEach(response.stream, (chunk) => {
      if (chunk.byteLength === 0) return Effect.void
      if (size + chunk.byteLength > maximumBytes) return Effect.fail(tooLarge())
      if (size + chunk.byteLength > body.byteLength) {
        const grown = Buffer.allocUnsafe(Math.min(maximumBytes, Math.max(size + chunk.byteLength, body.byteLength * 2)))
        body.copy(grown, 0, 0, size)
        body = grown
      }
      body.set(chunk, size)
      size += chunk.byteLength
      return Effect.void
    })
    return body.subarray(0, size)
  })
