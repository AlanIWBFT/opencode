# OpenAI Responses WebSocket

Enabled by default on `local`, `dev`, and `beta`. On `latest` and `prod`, set `OPENCODE_EXPERIMENTAL_WEBSOCKETS=true`.

## Flow

1. A streamed `POST /responses` request arrives.
2. If it has no `session-id` or `x-session-affinity` header, use HTTP.
3. Title requests use HTTP.
4. If that session's socket is busy or already in fallback mode, use HTTP.
5. On the same healthy socket, use `previous_response_id` when the new input is a conservative extension of the completed response.
6. Serialize the final `response.create`; if it exceeds 15 MiB, use HTTP for this request.
7. Otherwise, reuse the open socket or open a new one and return WebSocket events as SSE.

## Lifetime

- Connect timeout: 15 seconds.
- Idle timeout: 5 minutes.
- After a completed response, keep the socket for reuse.
- Reuse a socket for up to 55 minutes, then replace it on the next request.
- Continuation state belongs to one live socket. HTTP, reconnect, failure, abort, and cancellation clear it, so a new socket sends full input.

## Retries

- Retry WebSocket stream/setup failures up to 5 times, then use HTTP until the session is removed or the pool closes.
- `websocket_connection_limit_reached` consumes the same retry budget and HTTP fallback.
- A close with code `1009` retries the current request over HTTP when no response event was emitted. It lowers that session's byte threshold but does not enable sticky HTTP fallback.
- Oversized preflight fallback is per request. Later requests are measured again and can return to WebSocket when their serialized frame is smaller.
- If a WebSocket fails after its first event, fail it as retryable rather than replaying partial output in transport.
- Abort or cancel closes the socket.

## Diagnostics

- Transport decisions are logged at info level with service `openai.websocket`.
- Decision logs include the session ID, HTTP reason or socket reuse, continuation usage, serialized frame bytes, and the current byte limit.
- Close code `1009` logs whether an event was already emitted and both the previous and adjusted byte limits.
- Request bodies, prompts, media, and response IDs are never logged.

## Next Steps

- Optional second WebSocket for concurrent requests in one session. Currently these use HTTP.
