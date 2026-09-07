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

## Linux unified exec

On Linux, `exec_command` always uses Bash resolved from OpenCode's PATH, independently of `config.shell` and `$SHELL`. Bash is required; missing Bash produces an explicit error rather than falling back to `/bin/sh`. Commands use Bash syntax, including arrays, `[[ ... ]]`, process substitution, and `pipefail`.

Both transports use non-interactive `bash --noprofile --norc -p`: pipes read commands with `-s`, while PTYs use `/dev/stdin` as the script filename so attaching a terminal does not enable interactive Bash behavior. The child program still receives a real terminal. The host requires equal real/effective user and group IDs before using `-p`; it does not grant additional OS privileges.

Bash's `-p` startup mode ignores inherited shell options, exported functions, `CDPATH`, and `GLOBIGNORE`, and does not process `BASH_ENV`/`ENV` startup scripts. The lane inherits the ordinary OpenCode/plugin environment with `BASH_ENV`, `ENV`, `HISTFILE`, and `BASH_COMPAT` empty, then explicitly leaves POSIX mode before loading its protocol runner. Login files, bashrc, prompt hooks and persistent shell history do not run automatically. This establishes an initial state, not a per-command reset: explicit `source`, cwd changes, variables, functions, activated environments and shell options persist in the lane. The runner uses forced redirection for its own cwd status file so enabling `noclobber` still protects user files without breaking execution completion.

Another interpreter can be invoked explicitly, but changes to its shell state do not propagate back to the Bash parent. A child REPL has terminal I/O without making the protocol shell interactive. Ctrl+C may end the lane generation; the next command can rebuild it. Interactive-parent prompt/history/job-control behavior is not part of the lane contract. Commands that explicitly exit or disable their shell can lose the lane rather than preserving arbitrary shell state.

This contract is specific to Linux unified exec. The integrated terminal and other shell consumers retain their existing configuration, as do Windows and macOS execution paths.

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
