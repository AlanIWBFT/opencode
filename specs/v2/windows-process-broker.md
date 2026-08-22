# Windows process broker

The local Node subprocess adapter routes Git and ripgrep through the broker in
`packages/util/src/windows-process-broker`. Each command owns a Windows Job and
independent stdin/output state; other executables use the upstream process adapter.

Stdin failures stay command-local. A write or close arriving after spawn failure
or command completion receives a broken-pipe acknowledgement rather than closing
the shared connection. Cancellation after completion is harmless. Malformed
protocol frames still close the connection.

Broker output uses credit-based backpressure. Because command completion already
terminates descendants in its Job, broker streams are exempt from the ordinary
adapter's one-second post-exit output deadline and drain completely instead.

Build the individual NativeAOT helper using `bun run --cwd packages/util build:windows-process-broker`
from a Visual Studio Developer Shell. `OPENCODE_PROCESS_BROKER_PATH` can select a
helper for focused tests; packaged CLI builds stage it beside the CLI executable.
Real-process integration tests live in `packages/core/test/process`.
