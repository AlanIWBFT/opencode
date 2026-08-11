# Unified Exec Redesign Plan

## Goal

Run every model command in one of a fixed number of persistent shell lane slots so ordinary serial work reuses shell state and explicit numeric slots provide bounded parallelism. Preserve deterministic shell execution boundaries, cwd, exit codes, stdin, polling, and termination without treating the lane as an unstructured terminal byte stream.

The model can:

- Reuse cwd, environment variables, functions, modules, and activated environments.
- Run commands concurrently in different numeric lane slots.
- Observe partial output before a command exits.
- Send input to the command currently running in a lane.
- Poll or terminate a running command.
- Destructively reset an idle slot to start a clean shell generation; lost slots rebuild automatically.

The core mechanism is early tool return. The host starts a command in its lane, waits for a short yield window, returns current output plus an `exec_id` when still running, and lets the model choose a follow-up tool.

## Non-Goals

- Do not retain a separate one-shot or isolated execution mode.
- Do not replace deterministic shell execution with prompt detection, quiet-period heuristics, or model-authored sentinels over a raw terminal.
- Do not port Codex sandboxing.
- Do not implement remote environments.
- Do not add crash recovery for live shell processes.
- Do not build a terminal emulator in the Desktop timeline.
- Do not classify, prevent, supervise, or causally attribute work that a command leaves running after its shell invocation completes.
- Do not promise cleanup for processes that escape the lane process tree or work delegated to service managers, containers, schedulers, or remote systems.

## Redesign Decisions

- Replace arbitrary lane names with fixed Session-local numeric slots `0..MAX_LANES_PER_SESSION-1`; slot `0` is the default serial lane.
- Keep `exec_id` as the identity of one framed command execution. Poll, stdin, and termination continue to address executions, never lane slots.
- Make reset destructive after permission and command preparation succeed. Reset or replacement startup failure does not restore the previous shell generation.
- When Session history is reverted, truncated, or rewritten, close every lane generation in each affected Session instead of tracking per-message lane ownership.
- Give pipe and PTY transports one realtime output/lifecycle interface. PTY command framing must consume an atomic replay-plus-live attachment rather than poll a bounded replay buffer.
- Support only explicit PowerShell, cmd, and recognized POSIX adapters. Reject unknown configured shells instead of assuming an undocumented custom POSIX protocol.
- Keep `poll_exec` as the only polling operation. `write_stdin` without non-empty `chars` or `close_stdin: true` is invalid.
- Retain command files, cwd status files, shell bootstrap, start/done framing, exit codes, output consumption, and pipe-by-default behavior because these are the shell semantics that distinguish `exec_command` from a raw terminal.

## Tool Protocol

### `exec_command`

```ts
{
  cmd: string
  lane_id?: number
  reset_lane?: boolean
  workdir?: string
  yield_time_ms?: number
  max_output_tokens?: number
  tty?: boolean
}
```

Every command runs in a fixed Session-local lane slot. `lane_id` defaults to `0` and must be an integer in `0..MAX_LANES_PER_SESSION-1`; the initial maximum is eight slots. Slot identity is scoped by the OpenCode Session and instance directory, so the same number in another Session refers to a different slot.

Commands in one slot are serial. Overlapping `exec_command` calls wait only until the earlier tool call returns from its initial yield window. If that command completed, the next call reuses the slot; if it returned with an active `exec_id`, the next call receives a busy result. Different slots can run concurrently. Fixed slots eliminate lane-name allocation, lane-name tombstones, name-count checks, and `too many lanes; reuse an existing lane` failures.

Direct and Code Mode calls use the same slot launch serialization. The queue protects only command preparation and the initial yield window; it never waits for a long-running command to exit. Follow-up controls remain serialized by `exec_id` so poll, stdin, and terminate cannot mutate one execution concurrently.

An empty slot creates generation 1 with or without `reset_lane`. An idle slot reuses its current generation unless `reset_lane: true` requests replacement. A lost slot automatically creates its next generation and returns a model-visible warning that inherited shell state was reset. Resetting an executing or reserved slot is rejected; the model must terminate or wait for its running command first.

Permission checks, shell AST scanning, `shell.env`, and in-memory command preparation occur before destructive replacement. Once those steps succeed, reset closes the old generation before spawning the new shell. Bootstrap or activation failure leaves the slot lost and does not restore the discarded generation. Generation increments only when a new shell is successfully committed.

The workspace uses eight live shell generations as an asynchronous soft target, not a launch-time capacity limit. Shell creation and reset are serialized by one spawn semaphore and never wait for capacity reclamation. After generation creation, reservation release, and command completion, a single background reaper atomically marks the least recently used unreserved idle generations lost until the target can be met, then releases their processes and files outside the lane lock. Busy or reserved generations may temporarily keep the workspace above the target; the existing limit of twenty-five running executions remains the hard bound on active commands. If no idle unreserved generation is available, reclamation waits for a later lifecycle trigger.

`tty` is a property of a lane generation. Changing it requires `reset_lane: true`; a mismatched request without reset is rejected without changing the existing lane. Use `tty: true` for REPLs, `Read-Host`, and full-screen terminal programs.

Every lane generation uses a small shell-specific runner file. PowerShell and POSIX shells source the runner once; cmd calls its runner for each command. The runner emits a nonce-scoped bootstrap acknowledgement only after it is available. Shell exit or bootstrap timeout releases the generation and reports bounded startup diagnostics. The runner, command scripts, and precreated cwd status files live in one lane-private temporary directory; POSIX permissions are restricted to `0700` for the directory and `0600` for its files. PowerShell reads and validates its FileSystem SessionState location, POSIX runs `pwd -P` and converts it with `cygpath` on Windows, and cmd runs `cd`; an empty, relative, non-filesystem, unconvertible, or unwritable status makes the slot lost instead of allowing an invalid cwd to persist. Only the short runner request is sent through the shell's stdin. PowerShell executes each command in a nested pipeline bound to the lane module's current runspace, so `exit` completes only that execution while variables, functions, modules, activated environments, and physical cwd remain reusable. A host-level exit such as `[Environment]::Exit(...)` still loses the generation. PowerShell compiles the command through `AddScript`, so normal PowerShell/AMSI inspection applies.

The runtime has explicit adapters for PowerShell 7, Windows PowerShell 5.1, cmd, and recognized POSIX shells (`bash`, `dash`, `ksh`, `sh`, and `zsh`, including recognized Git Bash paths on Windows). Any other configured shell fails with `unsupported persistent shell protocol`. Supporting another shell requires a reviewed adapter; generic one-shot `-c` compatibility is insufficient.

The `shell.env` result is immutable lane-generation configuration. A new or reset lane receives it only through the spawned shell process environment, and the runtime keeps an in-memory snapshot for equality checks. Reuse proceeds only when the current hook result matches that snapshot; any added, removed, or changed value rejects the command and requires explicit reset. The runtime never serializes those values into command files, runner files, metadata, or its own model output; a command can still explicitly read and print its environment. Windows environment keys compare case-insensitively; POSIX keys remain case-sensitive, and an absent key differs from an empty value.

cmd commands use batch-file syntax because each command is executed from a temporary `.cmd` file. Environment variables use `%NAME%`, and FOR variables use doubled percent signs such as `%%A`.

Pipe lanes use control-character frames and TTY lanes use random-nonce printable frames suitable for ConPTY. The runner emits a start frame before evaluating the command file and a done frame afterward. `write_stdin` input received before the start frame is buffered, then released only after the command owns stdin; this prevents shell startup and bootstrap parsing from consuming command input.

### Foreground And Output Semantics

The model owns the command's process and job-control semantics. An early tool return does not complete the shell invocation: a foreground command remains active, keeps its `exec_id`, and can be observed or controlled with `poll_exec`, `write_stdin`, and `terminate_exec`. A command may use internal parallelism as long as it joins that work before returning from the shell invocation.

Unified Exec does not inspect shell syntax or process trees to detect background work. Processes, jobs, runspaces, timers, event subscriptions, remote work, and externally managed services that survive the done frame are outside the execution contract. The model is responsible for their lifecycle and for interpreting any output they produce. Reset, termination, archive, and instance cleanup only make best-effort claims about resources still contained by the lane; they do not reclaim escaped or externally managed work.

Execution output means the control-sequence-free transcript derived from bytes observed on the shared lane while that framed execution is active. It is not proof that every byte was causally produced by the submitted command. Output emitted while no execution is active (for example from surviving background work after a done frame) is discarded. Output from unsupported surviving work may interleave with a later active execution and is returned without process-level attribution so the model can interpret it in context. Long-running work that requires reliable polling, input, termination, and transcript continuity should therefore remain in the foreground.

Each read of a running execution consumes only newly arrived output; the unread remainder stays buffered for later reads, so polling less frequently does not lose output. If bursts exceed the 256KB model buffer while an execution is running, the middle is dropped once and accounted with an explicit omitted-bytes marker. When an execution completes, its remaining buffered output (head and tail of the same buffer) is delivered and consumed by the result that reports `running: false`. Later `poll_exec` calls return the completion status without replaying that output.

### `poll_exec`

```ts
{
  exec_id: number
  yield_time_ms?: number
  max_output_tokens?: number
}
```

Polls unread output without writing to lane stdin.

### `write_stdin`

```ts
{
  exec_id: number
  chars?: string
  close_stdin?: boolean
  yield_time_ms?: number
  max_output_tokens?: number
}
```

Writes raw characters to the command currently running in the lane. The model must only send input the command is ready to consume: unconsumed bytes can be read by the lane protocol after the command returns and invalidate that lane. The call must provide non-empty `chars` or set `close_stdin: true`; polling belongs exclusively to `poll_exec`.

`close_stdin: true` sends EOF to a pipe-backed command after writing optional `chars`. Closing stdin also ends the lane generation, so the next command automatically starts a new generation and reports the state reset. TTY lanes do not support closing stdin. Retaining this EOF capability is an explicit first-redesign decision; usage should be measured before considering its later removal.

### `terminate_exec`

```ts
{
  exec_id: number
  yield_time_ms?: number
  max_output_tokens?: number
}
```

Terminates the lane shell that owns the running command and marks the lane lost. The next command automatically creates a new generation and reports the state reset.

## Lane State Machine

Each Session owns a fixed logical slot array. Empty and lost slots consume no shell process. A slot stores the last committed generation plus an optional preparation reservation:

```ts
type LaneSlot = {
  id: number
  generation: number
  committed: { type: "empty" } | { type: "live"; lane: Lane } | { type: "lost"; reason: string }
  preparation?: LanePreparation
  activeLaunch?: LaneLaunch
  launchQueue: LaneLaunch[]
}
```

A live lane generation has two command states:

- `idle`: the shell is alive and ready for a framed command.
- `executing`: the current framed command owns `write_stdin` and receives lane-observed output until its done frame.

The slot-level `lost` state retains only its fixed ID, last successful generation, and reason. It replaces the current lane-name tombstone map.

Legal transitions:

```text
empty ---------------------- create ----------------------> live/idle
live/idle ------------------ execute ---------------------> live/executing
live/executing ------------- done ------------------------> live/idle
live/idle ------------------ destructive reset ----------> live/idle | lost
live/idle ------------------ reaping/shell exit ----------> lost
live/executing ------------- terminate/protocol failure -> lost
lost ----------------------- next command ----------------> live/idle | lost
```

Each slot owns an explicit FIFO launch queue. Completing the active launch grants the next waiting launch; Session stop, archive, delete, and history rewrite remove all waiting launches and wake them immediately with invalidation. A Session lifecycle epoch also rejects calls that crossed a lifecycle boundary before they could enter a slot queue. `LanePreparation` prevents two launches from reserving one slot. Permission denial, plugin failure, or interruption before destructive replacement releases the reservation without changing an existing idle generation. After destructive replacement begins, failure leaves the slot lost. Only the runtime writes protocol frames while a lane is idle. Once the start frame is observed, `write_stdin` forwards raw input to the current command. The done frame returns stdin ownership to the scheduler.

## Transport Boundary

Pipe and PTY implementations expose one lifecycle instead of branching throughout `ExecSession`:

```ts
interface LaneTransport {
  readonly kind: "pipe" | "pty"
  readonly output: Stream.Stream<string>
  readonly supportsEOF: boolean

  write(data: Uint8Array): Effect.Effect<boolean>
  closeInput(): Effect.Effect<boolean>
  awaitExit(): Effect.Effect<{ exitCode?: number }>
  kill(): Effect.Effect<boolean>
  release(): Effect.Effect<void>
}
```

- Both transports publish ordered realtime output through `output`.
- Pipe transport wraps `ChildProcessSpawner` stdout/stderr and stdin queue behavior.
- PTY transport attaches at cursor 0 immediately after creation, applies retained replay, then activates live delivery atomically. Shell protocol parsing never depends on the PTY service's bounded retained buffer.
- `awaitExit` completes only after all output observed before transport termination has entered the ordered output stream.
- `release` is idempotent and owns stream detachment, process removal, queue shutdown, and transport scope cleanup.
- `ExecSession` parses bootstrap and command frames from this common stream and does not call transport-specific read or cursor APIs.

## Shell Protocol Boundary

Transport lifecycle and shell syntax remain separate. A reviewed adapter owns every shell-specific operation:

```ts
interface ShellProtocol {
  args(input: { tty: boolean }): string[]
  extension: string
  runner(input: RunnerInput): string
  bootstrap(input: BootstrapInput): Uint8Array
  command(input: CommandInput): Uint8Array
  script(input: ScriptInput): string
}
```

The initial adapter set is PowerShell 7, Windows PowerShell 5.1, cmd, and recognized POSIX shells. Adapter selection uses the resolved executable name, including recognized Git Bash paths. Unknown shells fail before slot reservation becomes destructive. Adding another shell requires protocol, quoting, cwd, stdin, exit-code, bootstrap, and TTY tests.

## Runtime Service

The instance-scoped `ExecSession` service:

- Allocates numeric `exec_id` values.
- Maps each Session to a fixed array of numeric lane slots.
- Uses pipes by default and the PTY service for TTY lanes.
- Tracks execution ownership by Session and original tool call without assigning message ownership to persistent lane state.
- Keeps separate unread model output and bounded UI transcript buffers.
- Supports stdin writes, output polling, termination, and session cleanup.
- Rejects cross-session follow-up calls, out-of-range slot IDs, and busy-slot submissions.
- Prunes retained completed execution records without killing idle lanes.
- Serializes shell creation/reset with one spawn semaphore and runs capacity reaping asynchronously outside launch.
- Keeps at most twenty-five running executions while treating eight live generations as a best-effort idle-shell target.
- Releases a Session's live slots when it is archived, rejects new commands until it is unarchived, and removes its entire slot array when it is deleted. Unarchiving does not recreate a generation immediately; the next command rebuilds the lost slot and reports the state reset.
- Closes all lane generations in every affected Session when history is reverted, truncated, or rewritten. Selective preservation based on message IDs is intentionally removed.
- Invalidates queued slot launches when a Session is stopped, archived, deleted, or rewritten, so commands admitted before the lifecycle boundary cannot execute afterward.

## Permissions

- `exec_command` requests the same `bash` permission as the shell tool for every command, including commands appended to an existing lane.
- External `workdir` values continue to require `external_directory` approval.
- `external_directory` is a UX authorization prompt, not filesystem confinement for shell execution. Best-effort AST scans can recognize some literal path arguments, but they cannot reliably detect access performed through variables, redirections, scripts, child programs, or runtime-generated paths.
- A lane's observed cwd helps resolve later relative paths and permission prompts; it is runtime state, not a security boundary. Once a shell command is allowed, it retains the host user's filesystem, process, and network authority.
- `write_stdin`, `poll_exec`, and `terminate_exec` can only target an execution owned by the current OpenCode session.
- Follow-up tools do not request a new full command approval.

## Model Decision Flow

1. Use default `lane_id: 0` for ordinary sequential work.
2. Use `lane_id: 1..7` only when a command must run concurrently with work already running in another slot.
3. Reuse the same numeric slot for cwd, environment variables, functions, modules, and activated environments.
4. Use `reset_lane: true` when a clean shell is required; reset deliberately discards an existing idle generation. Lost slots rebuild automatically.
5. If a busy slot must be reset, terminate its current execution first.
6. Use `poll_exec` for output, `write_stdin` only for expected input, and `terminate_exec` to stop a running command.
7. Keep long-running work in the foreground when it needs reliable lifecycle control; Unified Exec does not manage work that survives the shell invocation.

## Output And UI

`exec_command` is the sole visible execution card. Successful `poll_exec`, `write_stdin`, and `terminate_exec` controls merge into that card; failed follow-ups remain visible. Stdin text is never persisted in interaction metadata.

`processRunning` is the sole command-activity authority. An idle persistent shell does not keep a completed card active. `laneID`, `shellGeneration`, and `shellReused` are observational metadata. OpenChamber may retain a display-only fallback for historical persisted metadata that used string `lane`; new runtime metadata emits only the numeric field.

Model-facing unread output is bounded independently from the UI transcript. The runtime strips terminal control sequences, keeps a 30,000-character UI preview, retains bounded model head/tail output, and reports truncation explicitly. Both surfaces present lane-observed output for the active framed execution and must not imply process-level causal attribution.

## Test Plan

- `lane_id` defaults to 0, accepts every configured slot, and rejects negative, fractional, or out-of-range values in the tool input boundary.
- Fixed slots never fail because too many distinct lane names were previously used.
- Sequential commands reuse environment, functions, cwd, and shell generation.
- Stable `shell.env` output reuses a generation; added, removed, or changed output requires destructive reset.
- Lane temporary directories and files use private POSIX permissions, status files are created exclusively before launch, and cleanup removes the directory with the shell generation.
- Plugin environment values enter through process spawn only and never appear in temporary lane files or host-generated metadata/output.
- Native failures preserve exit codes without destroying a healthy lane.
- PowerShell `exit` and conventional `exit $LASTEXITCODE` propagation complete only the current execution, preserve their exit code, and keep the lane generation reusable.
- Isolated PowerShell executions preserve variables, functions, imported modules, activated environments, and physical cwd, while terminating errors return failure without losing the generation.
- PowerShell, cmd, and POSIX lanes use the same command-file runner lifecycle.
- Unknown configured shells fail explicitly before destructive replacement.
- Immediate pipe input is gated until the start frame for each supported shell family.
- Different numeric slots run concurrently; a busy slot rejects command and reset attempts.
- Overlapping short commands in one slot serialize through their initial tool calls; if the earlier call returns with a running `exec_id`, the next call receives busy.
- Termination marks a lane lost; the next command rebuilds it, increments its generation, and reports the state reset.
- Destructive reset startup failure leaves the requested slot lost and never restores the discarded generation.
- Exceeding the workspace live-shell soft target never blocks generation creation; the reaper eventually marks only least recently used unreserved idle slots lost and leaves busy or reserved slots intact.
- PowerShell, cmd, and POSIX generations acknowledge successful runner bootstrap; missing acknowledgements fail and release the generation.
- Mutable shell cwd variables do not override the physical cwd recorded for lane reuse and permission checks.
- Empty, non-filesystem, unconvertible, and unwritable cwd status loses the lane without suppressing its completion frame.
- Pipe and PTY transports feed identical ordered output lifecycle tests.
- TTY bursts larger than the PTY retained replay limit preserve start/done frames, report bounded model output, and keep a healthy lane reusable.
- TTY completion framing preserves the command's trailing newline.
- Interrupted pre-destructive reservations preserve an idle generation; interruption after replacement begins leaves the slot lost and releases all files.
- Pipe commands consume `write_stdin`; EOF completes the command and ends the generation.
- `write_stdin` without non-empty characters or explicit EOF is rejected rather than polling.
- TTY commands consume terminal input and preserve state for the next command.
- Changing a lane's TTY mode requires reset.
- Unknown and cross-session `exec_id` values are rejected.
- Output controls are sanitized and model/UI buffers remain bounded.
- Foreground commands that outlive the initial yield expose an `exec_id` and remain observable through `poll_exec`.
- Tests do not establish background-work supervision, cleanup, or causal output attribution; those behaviors are explicit non-goals.
- Session stop terminates all running lanes.
- Any Session history rewrite closes all lanes in that Session, including generations whose commands precede the rewrite boundary.
- Stop, archive, delete, and history rewrite invalidate commands waiting in a slot launch queue.
- Queue invalidation wakes every waiting call immediately and does not wait for the active preparation to finish.
- Session archive releases live slots; Session deletion removes the whole fixed slot array.

## Implementation Phases

1. Introduce numeric slot input and metadata, fixed slot arrays, range validation, and OpenChamber display compatibility for historical string-lane metadata.
2. Replace lane-name maps, tombstone maps, and message-ID lane ownership with fixed `LaneSlot` state and Session-wide invalidation on history mutation.
3. Make reset destructive, add asynchronous best-effort idle-shell reaping, and remove candidate rollback, candidate transfer, and old-generation preservation paths.
4. Introduce `LaneTransport`, migrate pipe output first, then migrate PTY to atomic replay-plus-live attachment, and remove PTY cursor polling from `ExecSession`.
5. Introduce explicit `ShellProtocol` adapters and reject unknown shells.
6. Make `poll_exec` the sole polling tool path and validate `write_stdin` action input.
7. Adapt Code Mode concurrency metadata, ACP projection, OpenChamber metadata/rendering, model descriptions, plans, and focused lifecycle tests.

Each phase must pass package typecheck and focused static formatting before tests. Do not run tests after a failing static check. Tests run from `packages/opencode` and must not trigger a build.

## Completion Criteria

- No arbitrary lane-name allocation, lane-name tombstone, or retained-name capacity logic remains.
- A fixed numeric slot has one committed state plus at most one preparation reservation.
- Reset failure has a documented destructive outcome with no generation rollback path; soft-target reaping never participates in launch transactions.
- Session history mutation invalidates lanes at Session granularity and no lane stores message IDs.
- Pipe and PTY implementations satisfy one ordered realtime transport contract.
- PTY framing is independent of bounded retained-output polling.
- Unknown shells are rejected unless they have an explicit tested adapter.
- `poll_exec` is the only no-input polling operation.
- Existing persistent shell state, cwd, exit-code, output, permission, stdin, termination, and UI semantics remain covered.

## Open Questions

- Should `terminate_exec` attempt a graceful interrupt before killing the lane shell?
- Should a future protocol provide a separate command-input channel so surplus stdin can never collide with scheduler frames?
