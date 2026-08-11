# OpenAI Explicit Compaction Design And Implementation Notes

> The explicit compaction request is implemented in the OpenAI AI SDK adapter.
> The old native `@opencode-ai/llm` compact route was intentionally removed;
> the session checkpoint and replay semantics described here remain active.

## Goal

Implement OpenAI native compaction with the same history semantics as Codex RemoteCompactionV2, not just a compatible request shape.

The target behavior is:

- Compact through ordinary OpenAI Responses requests with a final `{ "type": "compaction_trigger" }` input item.
- Persist a replacement replay window that contains retained pre-compaction user history plus the returned encrypted compaction item.
- Resume provider execution with `retained user history + compaction item + retained post-checkpoint tail`, without creating a synthetic "Continue if..." user prompt.
- Keep UI-visible compaction markers separate from the provider replay window.
- Keep durable prompt admission and model execution behavior unchanged outside native OpenAI compaction.

## Current State

opencode now has the following pieces for Codex-style explicit compaction:

- The patched `@ai-sdk/openai` provider sends explicit compaction through ordinary `/responses`, forces `store: false`, enables streaming, and appends a unique `{ type: "compaction_trigger" }` item.
- `packages/opencode/src/session/llm/ai-sdk.ts` owns the private terminal envelope and returns the normalized request input plus the opaque output item.
- `packages/opencode/src/session/llm.ts` passes replay input through the AI SDK provider options rather than through the native LLM route.
- `packages/opencode/src/session/openai-native-compaction.ts` stores encrypted compaction output in checkpoint metadata.
- `packages/opencode/src/session/compaction.ts` skips synthetic auto-continue prompts for native compaction.
- `packages/opencode/src/session/prompt.ts` can resume after an auto native checkpoint with no retained tail by using an old user only as execution metadata.

The main mismatch is history semantics. Current no-tail native replay sends provider input as checkpoint-only: the old user message is used for agent/model/tool metadata but is not included in `request.messages`, so the provider sees the encrypted compaction item without the original task text.

## Codex Reference Behavior

Codex RemoteCompactionV2 does three distinct things.

First, it compacts with ordinary `/v1/responses` input plus a final compaction trigger:

```text
codex-rs/core/src/compact_remote_v2.rs
  prompt_input = history.for_prompt(...)
  input = prompt_input.clone()
  input.push(ResponseItem::CompactionTrigger {})
```

Second, after the compact stream returns one `ResponseItem::Compaction`, Codex builds replacement history from the compact request input rather than from the raw compact response alone:

```text
build_v2_compacted_history(prompt_input, compaction_output):
  retained = prompt_input
    .filter(is_retained_for_remote_compaction_v2)
    .filter(should_keep_compacted_history_item)
  retained = truncate_retained_messages_for_remote_compaction(retained, 64_000)
  retained.push(compaction_output)
```

Third, Codex installs that replacement history into the session. The next sampling request is built from session history, so the model sees retained user context before the compaction item.

Important details from Codex:

- RemoteCompactionV2 retains only `user`, `developer`, and `system` messages from compact request input before filtering.
- `should_keep_compacted_history_item` drops developer messages and non-real user wrapper messages, keeps real user messages, assistant messages if the compact output ever emits them, agent messages, and compaction items.
- RemoteCompactionV2 appends exactly the new compaction item after retained messages.
- Retained message text is capped at a 64k approximate-token budget, scanning from newest to oldest and truncating an over-budget retained text item if needed.
- Mid-turn compaction reinjects initial context above the last real user or, if no real user remains, above the compaction item so the compaction item stays last.
- Manual and pre-turn compaction clear the reference context baseline; the following ordinary user turn reinjects canonical context after the compaction item.
- Codex can have an old remote compaction item in the compact request input, but after installing a new RemoteCompactionV2 checkpoint, replacement history converges to retained messages plus the latest compaction item.

## Desired opencode Semantics

opencode should persist native compaction metadata as a provider replay window, not as raw compact output only.

For an auto native compaction with no retained tail:

```text
durable user:        "before compact"
durable marker:      user compaction part
durable summary:     assistant summary with native checkpoint metadata

provider replay:     [user "before compact", compaction encrypted_content]
provider messages:   []
final provider input [system/context, user "before compact", compaction encrypted_content]
```

For an auto native compaction with retained tail:

```text
durable user:        "Research the plan"
durable assistant:   unfinished/tool-call tail
durable marker:      user compaction part with tail_start_id = durable user id
durable summary:     assistant summary with native checkpoint metadata

provider replay:     [retained pre-compaction user messages, compaction encrypted_content]
provider messages:   [tail user "Research the plan", unfinished assistant/tool items]
final provider input [system/context, retained user history, compaction, tail]
```

Manual native compaction remains admit-only from the user's perspective. It should install a checkpoint but should not auto-run the model without a new user input unless there is an explicit retained unfinished tail that requires continuation.

## Data Model Changes

Extend native checkpoint metadata to distinguish raw compact output from the installed replay window.

Recommended schema shape:

```ts
const Window = Schema.Struct({
  version: Schema.Literal(2),
  output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  compactOutput: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
})
```

Field semantics:

- `output` is the provider replay window passed through the OpenAI AI SDK adapter.
- `compactOutput` is the raw compact response output for diagnostics. It is optional because `output` is enough to replay.
- Version `1` means legacy metadata where `output` is raw compact output, usually just `[compaction]`.
- Version `2` means `output` is already Codex-style replacement replay history.

Compatibility rules:

- Decode v1 checkpoints and synthesize a v2 replay window at read time when possible.
- Do not migrate persisted data eagerly.
- If a v1 checkpoint has retained tail, synthesize using the durable messages before the marker and the legacy compaction item.
- If synthesis cannot find a real user for an auto no-tail checkpoint, keep existing safe behavior: log and stop instead of creating a synthetic user prompt.

## LLM Package Boundary

The low-level `@opencode-ai/llm` package remains responsible for ordinary
OpenAI Responses parsing and native LLM streaming. It does not own explicit
compaction. The old `openai-responses-compact` protocol, `LLMClient.compact`,
and `LLMClient.compactWithInput` APIs were removed because they duplicated the
AI SDK provider path without serving another runtime.

The session-owned AI SDK adapter now exposes the narrow result needed by
checkpoint installation:

```ts
type ExplicitCompactionResult = {
  readonly output: readonly Record<string, unknown>[]
  readonly input: readonly unknown[]
  readonly providerMetadata?: ProviderMetadata
}
```

`collectExplicitCompaction(...)` validates the private terminal envelope,
returns the request input without the trigger, captures turn state, and maps
failed, incomplete, aborted, and prematurely closed streams into the session
retry policy. Ordinary Responses streams continue to ignore unexpected
server-sent compaction items.

Turn-state headers are owned by the session LLM service for both ordinary
OpenAI requests and explicit compaction requests. The native runtime continues
to support ordinary opt-in streaming and tool dispatch, but no longer carries
checkpoint replay or compaction transport state.

## Session Work

### 1. Build Codex replacement replay windows

Add a function in `packages/opencode/src/session/openai-native-compaction.ts` or a sibling module:

```ts
buildReplacementWindow(input: {
  readonly compactInput: readonly Record<string, unknown>[]
  readonly compactOutput: readonly Record<string, unknown>[]
  readonly mode: "pre-turn" | "mid-turn" | "manual"
}): Window
```

Responsibilities:

- Drop any `compaction_trigger` items.
- Keep only supported retained messages from the compact input.
- Filter retained messages to real user messages for the first implementation unless developer/system retention is deliberately needed.
- Append exactly one returned compaction item.
- Enforce one compaction output item with `encrypted_content`.
- Apply a retained-message token budget compatible with Codex.

Start minimal and safe:

- Retain real user messages only.
- Preserve input images in retained user messages.
- Drop developer/system because opencode already injects current system/context separately through `LLMRequestPrep.prepare`.
- Drop assistant/tool artifacts from replacement window; retained tail still carries unfinished assistant/tool state through normal `msgs`.

Then add Codex-complete retention if tests prove a gap:

- Preserve developer/system only when they represent chronological session context that is not otherwise injected.
- Preserve assistant messages emitted by compact output if OpenAI starts returning them.
- Preserve agent messages if opencode gains an equivalent wire item.

### 2. Store replacement window in checkpoint metadata

In `packages/opencode/src/session/compaction.ts`:

- Change `tryNativeCompaction` to receive `{ output, compactInput }` from `llm.compact`.
- Build `OpenAINativeCompaction.Window` from `compactInput` and `output`.
- Pass the replacement window into `storeNativeCheckpoint`.
- Store raw compact output only as optional diagnostics.

The native checkpoint text part should still render as `OpenAINativeCompaction.PLACEHOLDER`.

### 3. Use replacement window for continuation

In `packages/opencode/src/session/prompt.ts`:

- Keep `nativeContinuationUser` or equivalent for execution metadata: agent, selected model, tools, format, system additions.
- Do not inject a synthetic durable user message for native no-tail auto continuation.
- Pass `nativeReplay.checkpoint.window` to the LLM request.
- Ensure `msgs` only contains retained post-checkpoint tail messages, not marker/summary.
- Ensure `title(...)` and task handling use durable or replay-safe history without moving the UI compaction divider.

Expected no-tail behavior after this change:

- `activeLatest.user` is absent.
- `continuationUser` is the previous durable user and provides metadata.
- Provider messages are empty, but `nativeCompactionWindow.output` contains the retained original user and compaction item.
- Assistant parent remains the marker id, preserving UI grouping.

### 4. Legacy v1 checkpoint synthesis

For checkpoints whose stored window is just `[compaction]`, synthesize a Codex-style replay window before sending to the provider:

```text
retained = durable messages before marker, filtered to real user messages and capped
window.output = retained + legacyWindow.output
```

This synthesis can live in `OpenAINativeCompaction.replayMessages(...)` if it gets the full durable message list, or in `prompt.ts` where durable `compacted` messages are already available.

Rules:

- Only synthesize for auto checkpoints or explicit continuation after a retained unfinished tail.
- Manual no-tail checkpoint with no new prompt should still stop.
- Do not persist the synthesized v2 window unless there is a specific migration reason.

### 5. Retained tail behavior

Preserve opencode's existing `tail_start_id` semantics:

- The replacement window represents compacted head.
- Messages at or after `tail_start_id` remain as normal session messages.
- Replay input is `replacement window + lowered tail messages`; the patched OpenAI AI SDK provider places the replay window before the ordinary session messages.
- Do not include tail messages in `replacement window`, or they will be duplicated.

### 6. Manual compaction behavior

Manual native compaction should match Codex standalone compaction semantics:

- Compact existing history and install a checkpoint.
- Stop the loop after the checkpoint if there is no retained unfinished tail.
- The next user prompt should produce provider input `compaction replay window + new user message`.
- The new user prompt, not the old compacted user, should control agent/model metadata unless opencode intentionally adopts Codex's reconstructed previous-turn settings behavior.

### 7. Initial context placement

Codex treats initial context placement differently by phase:

- Pre-turn/manual compaction: context is reinjected after compaction on the next normal turn.
- Mid-turn compaction: context is inserted before the last real user or before the compaction item so the compaction item stays last.

opencode does not store canonical context as raw `ResponseItem`s in the same way. For parity at the provider input level:

- Rely on `LLMRequestPrep.prepare` to inject current system/context before replay input.
- Do not store opencode system/context in the native replay window initially.
- If OpenAI behavior requires the compaction item to be physically last for mid-turn continuation, add a phase-aware option to the patched AI SDK provider. Do this only with a failing test or live provider evidence.

## Tests

### LLM and adapter tests

`packages/llm/test/provider/openai-responses.test.ts` covers ordinary
Responses lowering, stream parsing, and ignoring unexpected server compaction
items. `packages/opencode/test/session/llm.test.ts` covers the AI SDK explicit
compaction trigger, private terminal envelope, replay input, retries, and turn
state. `packages/opencode/test/session/llm-native.test.ts` covers only the
ordinary opt-in native stream and tool bridge; it intentionally has no compact
transport tests.

### Session compaction tests

Update `packages/opencode/test/session/compaction.test.ts`:

- Native auto compaction stores a v2 replay window containing retained real user messages and the returned compaction item.
- Native auto compaction does not store `compaction_trigger` in metadata.
- A second native compaction replaces the previous replay window with retained messages plus the latest compaction item.
- Retained-message budget drops old retained users first and truncates an over-budget newest user message.
- Plugin-customized compaction still falls back to summary compaction.
- Summary compaction behavior and synthetic auto-continue remain unchanged for non-native compaction.

### Session prompt tests

Update `packages/opencode/test/session/prompt.test.ts`:

- No-tail auto native checkpoint resumes with provider body containing both encrypted compaction item and original user text.
- No-tail auto native checkpoint still does not create a synthetic `compaction_continue` user part.
- The assistant created after checkpoint has parent id equal to the compaction marker id.
- Manual no-tail native checkpoint exits cleanly and does not auto-run.
- Manual checkpoint followed by a new user prompt sends `replacement window + new user`.
- Retained unfinished tail sends `replacement window + tail user/assistant/tool state`, with no duplicate tail user inside replacement window.
- Legacy v1 checkpoint with only `[compaction]` synthesizes retained user replay for auto continuation.
- Legacy v1 checkpoint with no recoverable user stops safely.

### Snapshot or request-shape tests

Add compact request shape snapshots mirroring Codex scenarios:

- Pre-turn explicit compaction excludes incoming user from the compact request, then follow-up includes `retained users + compaction + incoming user`.
- Mid-turn explicit compaction after tool output includes the selected history in the compact request, then continuation includes the replacement window and retained tail if needed.
- Manual compaction with prior history installs checkpoint, then follow-up includes `compaction + new user` or `retained user + compaction + new user` depending on the retention phase decision.

## Migration And Compatibility

Persisted native checkpoints may already exist with metadata version 1.

Compatibility requirements:

- Version 1 checkpoints remain readable.
- Version 1 replay should be upgraded in memory to Codex-style input when possible.
- Version 2 checkpoints should be written for all new native compactions.
- Do not alter non-native summary compaction metadata.
- Do not regenerate SDKs unless the public protocol changes. Native checkpoint metadata is internal message-part metadata and should not require protocol generation unless exposed through public schemas.

Potential compatibility risk:

- Existing tests or user sessions may rely on checkpoint-only replay. The new behavior sends retained original user text to OpenAI again. This matches Codex but changes provider input shape.
- If retained original user contains large images or text, token use increases. The retained budget and truncation are mandatory before enabling broadly.

## Rollout Phases

### Completed: Build and store replacement windows

- Collect compact input in the AI SDK adapter.
- Build v2 replacement windows in session compaction.
- Store v2 checkpoint metadata for new native compactions.
- Keep legacy v1 replay compatible.
- Remove the unused low-level native compact route and its tests.

### Completed: Replay replacement windows in prompt loop

- Change no-tail auto native continuation to rely on v2 replay window containing retained user messages.
- Update prompt tests to assert original user text is in provider input.
- Preserve no synthetic prompt behavior.
- Preserve marker-parent UI grouping.

### Completed: Legacy synthesis and retained budget

- Add v1 checkpoint in-memory synthesis.
- Implement Codex-style retained-message token budget and truncation.
- Add tests for over-budget retained history.

### Future: Codex edge parity

- Add phase-aware initial-context placement if needed.
- Add turn-state replay for OpenAI OAuth/ChatGPT if route metadata exposes it.
- Add snapshots for pre-turn, mid-turn, manual, and resume scenarios.

## Acceptance Criteria

- New native OpenAI compactions persist a replay window, not raw compact output only.
- Auto no-tail checkpoint continuation provider input includes retained original user text and encrypted compaction item.
- Retained tail continuation provider input includes the replay window and tail exactly once.
- Manual no-tail native compaction does not auto-continue.
- No native compaction path creates synthetic "Continue if..." prompts.
- Provider input never includes stale compaction triggers outside compact requests.
- Replacement windows contain at most one latest compaction item.
- Existing summary compaction tests still pass.
- `bun test test/session/prompt.test.ts`, `bun test test/session/compaction.test.ts`, relevant `packages/llm` provider tests, and `bun typecheck` pass from their package directories.

## Open Questions

- Should opencode retain developer/system messages in the v2 window, or should it rely entirely on current `LLMRequestPrep.prepare` system/context injection? Start with real user retention only unless provider evidence requires exact wire parity.
- Should manual compact replacement windows include retained old user messages before the compaction item? Codex V2 does, but existing opencode UX may prefer the next user prompt to be the only visible task context outside the encrypted item.
- Does OpenAI require the compaction item to be the last replay item for mid-turn continuation, or is `replay input + tail` accepted? Current tests can validate shape, but live provider validation is needed for confidence.
- Is turn-state replay required for API-key OpenAI, or only ChatGPT/OAuth/websocket transports? Implement only when the transport exposes the relevant headers/metadata.
