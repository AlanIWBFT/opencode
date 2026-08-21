# Local OpenChamber integration

Managed OpenChamber children use the upstream `opencode serve --stdio` lifetime:
the CLI reports its listening URL as JSON, and stdin EOF closes its server scope
and application resources before exit. The parent keeps the stdin pipe open
until shutdown. There is no local shutdown JSON protocol or capability marker.

The local packaged CLI uses channel `dev` and defaults to `opencode-dev.db`.
Explicit `OPENCODE_DB` and `OPENCODE_DISABLE_CHANNEL_DB` settings retain their
upstream behavior. Moving existing databases into the shared default is not part
of this migration.

## Windows native sidecars

Windows packaging also builds Core's `OpenCode.Windows.RecycleBin.dll` and places
it beside the CLI executable. Preserve this sidecar when staging the CLI.
