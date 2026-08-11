# js

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

## Managed shutdown protocol

When `OPENCHAMBER_SHUTDOWN_PROTOCOL=1` is present, `opencode serve` reads its
private owner pipe from stdin. A version 1 `shutdown` message, or stdin EOF when
the owner exits, stops the HTTP listener and disposes the application runtime
before the CLI exits. Other invocations retain their existing stdin behavior.
Compiled CLIs that support this protocol include the sibling
`openchamber-shutdown-protocol.capability` marker.

This project was created using `bun init` in bun v1.2.12. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
