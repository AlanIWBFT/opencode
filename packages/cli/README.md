# Local OpenChamber integration

Managed OpenChamber children use the upstream `opencode serve --stdio` lifetime:
the CLI reports its listening URL as JSON, and stdin EOF closes its server scope
and application resources before exit. The parent keeps the stdin pipe open
until shutdown. There is no local shutdown JSON protocol or capability marker.

The local packaged CLI uses channel `dev` and defaults to `opencode-dev.db`.
Explicit `OPENCODE_DB` and `OPENCODE_DISABLE_CHANNEL_DB` settings retain their
upstream behavior. Moving existing databases into the shared default is not part
of this migration.

## Explicit Bun compile runtime

Single-target builds may set `OPENCODE_COMPILE_EXECUTABLE_PATH` to an existing Bun executable to use as the compiled runtime. This explicit local path takes precedence over `BUN_COMPILE_RELEASE`; without it, the upstream release-selection behavior is unchanged.

## Windows native sidecars

The Windows Git/ripgrep process backend also uses `OpenCode.ProcessBroker.exe`, built explicitly with `bun run --cwd packages/util build:windows-process-broker` from a Visual Studio 2022 x64 Developer Shell (.NET NativeAOT). CLI Windows builds stage it beside the executable; `OPENCODE_WINDOWS_PROCESS_BROKER_PREBUILT=1` reuses an existing helper after checking its protocol and NativeAOT identity. Runtime lookup honors `OPENCODE_PROCESS_BROKER_PATH`, then the executable directory, then the Util source helper directory. Missing helpers use the ordinary process backend; failures of active broker commands are reported, not silently rerun.

Broker-managed Git/rg commands retain complete backpressured output after exit; their Job owns descendant cleanup. Other processes retain the upstream one-second output-close deadline for inherited descendant pipes.

Windows builds used only as non-interactive application children may pass `--windows-gui-subsystem`. This emits a GUI-subsystem executable supporting explicitly redirected standard handles, rather than normal terminal CLI/TUI use.

Windows packaging also builds Core's `OpenCode.Windows.RecycleBin.dll` and places
it beside the CLI executable. Preserve this sidecar when staging the CLI.
