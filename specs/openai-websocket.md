# OpenAI Responses WebSocket (V2)

The V2 port uses the official `core/src/session/model-transport.ts` owner and
`ai/src/protocols/open-responses-continuation.ts` driver. The retired V1
fetch-to-WebSocket pool and patched AI SDK are not runtime dependencies.

## Selection and lifetime

- The official OpenAI provider defaults to WebSocket; provider `settings.transport`
  can explicitly select `http` or `websocket`.
- Primary requests and native compaction share the session connection. Title and
  standalone generate requests use their official HTTP paths.
- The official owner serializes exchanges, handles cancellation, rotates aged or
  changed-affinity connections, and commits continuation state only after successful
  outer stream completion. HTTP fallback discards the socket's continuation state.
- Keep official failure policy: one connect failure pins the owner to HTTP; repeated
  mid-stream losses use its existing failure budget. A connection-limit rejection
  rotates the socket and retries full through the model retry policy, without a
  separate legacy HTTP-switch counter.

## Local request-size policy

Only OpenAI Responses opts into the policy through `SessionModelRequest`:

1. After connection selection and the send interceptor, measure the final serialized
   frame in UTF-8 bytes, including incremental framing and turn-state metadata.
2. Above 15 MiB (or the learned lower limit), close the selected channel and send this
   request through HTTP. The oversized frame is never written to the socket.
3. On close code 1009, lower the owner limit to the lesser of the current limit and
   90% of that frame's bytes. Such closes do not consume the sticky stream-loss budget.
4. Retry immediately over HTTP only if the provider has emitted no event. After any
   provider event, report failure rather than replay potentially accepted output.
5. Later smaller requests may use WebSocket again. Owner reset clears the learned limit.

The preflight deliberately stays inside the official connection-selection state
machine: it may open a connection before deciding on HTTP, but does not add a second
driver preparation or risk replaying an incremental frame on a different connection.

## Turn state and diagnostics

`openai-turn-state.ts` preserves the first `x-codex-turn-state` per logical turn and
configured deployment. HTTP uses its header; WebSocket uses `client_metadata` on
each frame so learning a token does not change handshake affinity. New turns start
fresh, and title/generate calls do not share this state.

Size diagnostics include session ID, bytes, limit, full/incremental mode and connection
reuse. They never log prompt bodies, media, encrypted checkpoints or response IDs.
