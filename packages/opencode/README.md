# js

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

Single-target builds may set `OPENCODE_COMPILE_EXECUTABLE_PATH` to use an explicit Bun executable as the compiled runtime. Windows builds used only as non-interactive application children may pass `--windows-gui-subsystem`; this emits a GUI-subsystem executable that still supports explicitly redirected standard handles but is not suitable for normal terminal CLI or TUI use.

Windows source development and tests require the .NET SDK. Building the native
process broker also requires the Visual Studio 2022 C++ toolchain and an x64
Developer Shell. The package scripts build the managed Recycle Bin helper
automatically before starting development or tests.

## Managed startup protocol

When `OPENCODE_STARTUP_PROTOCOL=1` is present, database initialization writes
versioned lifecycle records to stdout before the server listening record:

```text
opencode lifecycle {"version":1,"type":"database-migration","state":"started"}
opencode lifecycle {"version":1,"type":"database-migration","state":"completed"}
```

Failures use `state: "failed"`. The protocol is opt-in so ordinary CLI output
is unchanged. Consumers may suspend their normal server-listening timeout after
`started`; `completed` is emitted only after all database migration transactions
and their journal markers have committed.

## Managed shutdown protocol

When `OPENCHAMBER_SHUTDOWN_PROTOCOL=1` is present, `opencode serve` reads its
private owner pipe from stdin. A version 1 `shutdown` message, or stdin EOF when
the owner exits, stops the HTTP listener and disposes the application runtime
before the CLI exits. Other invocations retain their existing stdin behavior.
Compiled CLIs that support this protocol include the sibling
`openchamber-shutdown-protocol.capability` marker.

This project was created using `bun init` in bun v1.2.12. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
