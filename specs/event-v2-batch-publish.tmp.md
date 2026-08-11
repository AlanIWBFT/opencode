# EventV2 Batch Publish

## Scope

Speed up Session fork and reverted-history cleanup by committing a same-aggregate
group of durable events in one database transaction. Preserve existing durable
event history, projectors, SSE event types, and Desktop/Web/TUI client behavior.

This change does not add a batch wire event and does not attempt to hide the
client-visible progression while individual compatibility events are consumed.
It requires no database migration or public Protocol change.

## EventV2 API

Add an explicitly constructed heterogeneous publish item and a batch operation
to `packages/core/src/event.ts`:

```ts
export type PublishItem = {
  readonly definition: Definition
  readonly data: unknown
  readonly options?: PublishOptions
}

export function publishItem<D extends Definition>(
  definition: D,
  data: Data<D>,
  options?: PublishOptions,
): PublishItem

export interface Interface {
  readonly publishBatch: (
    items: readonly PublishItem[],
  ) => Effect.Effect<readonly Payload[]>
}
```

`publishItem()` preserves type checking when heterogeneous events are assembled
into one array.

The initial API has these constraints:

- Every item must be durable.
- Every item must belong to the same aggregate.
- An empty batch returns an empty array without opening a transaction.
- A live event or mixed aggregate fails before any database write.
- Each item retains its own `id`, `metadata`, `location`, and `commit` hook.
- Duplicate event IDs in one batch fail before any database write.

Live events are excluded because they cannot participate in transaction
rollback semantics.

## Transaction Semantics

Before entering the database transaction, `publishBatch()`:

1. Resolves each item into a payload.
2. Encodes and validates each event payload.
3. Extracts and validates the common aggregate ID.
4. Rejects duplicate event IDs.
5. Resolves each item's location.

The batch then uses one `BEGIN IMMEDIATE` transaction:

1. Read the aggregate's current `event_sequence` once.
2. Assign consecutive durable event sequences in input order.
3. Run the matching projectors for each event in input order.
4. Run each event's local `commit(seq)` hook.
5. Insert each durable event row.
6. Advance `event_sequence` consistently with the committed prefix, ending at
   the last assigned sequence.
7. Roll back the complete batch if any projector, commit hook, validation, or
   database operation fails.

After the transaction commits:

1. Wake durable subscribers for the aggregate once.
2. Call the existing `notify()` once per event in input order.
3. Return the committed payloads with durable sequence metadata.

No notification may occur before commit. When a client receives the first
event, every projection in the batch must already be readable from the
database.

The implementation should share internal durable commit logic with ordinary
single-event `publish()` so the two paths do not diverge. `replay()` and
`replayAll()` remain unchanged in this work because their explicit sequence,
owner claim, and idempotent replay semantics require separate treatment.

## EventV2Bridge

`packages/opencode/src/event-v2-bridge.ts` must explicitly wrap
`publishBatch()`. Inheriting it through `Service.of({ ...events, publish })`
would bypass the bridge's implicit Instance location handling.

For each item without an explicit location, inject the current:

- directory
- workspace ID
- project identity

Then delegate to the underlying `EventV2.publishBatch()`.

The payload data object passed through each projector must be the same object
later passed to notification listeners. This preserves
`SessionProjector.projectedSequence(event)`, which associates the locally
allocated message or part sequence with the projected event data through a
`WeakMap`.

## Session Fork

Change `Session.fork()` in `packages/opencode/src/session/session.ts` to build
the complete cloned history before publishing it.

Retain the existing standalone `createNext()` call for the destination Session.
Then:

1. Select the exact source range by authoritative message order.
2. Allocate all destination message IDs.
3. Build a complete source-to-destination message ID map.
4. Rewrite assistant `parentID` values through that map.
5. Allocate destination part IDs.
6. Rewrite compaction `tail_start_id` through the message map.
7. Build one ordered array of `MessageUpdated` and `PartUpdated` publish items.
8. Call `events.publishBatch(items)` once.

Preserve the existing event order:

```text
message.updated
all message.part.updated events for that message
next message.updated
...
```

The expected transaction count changes from:

```text
1 + message count + part count
```

to:

```text
2
```

The two transactions are the destination `session.created` event and the
history batch. If history projection fails, the destination Session may remain
empty, but no partial cloned history may remain. Removing that empty Session is
an optional follow-up and is not required for this optimization.

## Revert Cleanup

Clicking undo only establishes a revert boundary. Physical deletion occurs
when a later prompt, shell command, or compaction invokes
`SessionRevert.cleanup()`.

Change cleanup in `packages/opencode/src/session/revert.ts` to:

1. Keep the existing reverse chronological message deletion order.
2. Construct `MessageRemoved` items for the reverted suffix.
3. For a part boundary, append the required `PartRemoved` items in their
   current order.
4. Commit all removals through one `events.publishBatch(items)` call.
5. Clear the Session revert marker only after the batch succeeds.

Reverse message deletion is mandatory because the current projector rejects
deleting a user message while an assistant child still exists.

Usage subtraction remains owned by the existing `MessageRemoved` and
`PartRemoved` projectors. Do not introduce a second aggregate recomputation or
direct database deletion path.

The expected transaction count changes from:

```text
removed message count + removed part count + 1
```

to at most:

```text
2
```

These are one removal batch and one Session update that clears the revert
marker.

## Client And Transport Behavior

Do not change:

- Protocol contracts
- generated SDK event contracts
- compatibility event schemas
- Desktop/Web reducers
- TUI reducers
- SSE event types

After committing a batch, `EventV2Bridge` continues to emit the existing
single compatibility events and durable `sync` events. Desktop/Web and TUI
already group incoming events over approximately one rendering frame, so many
batch notifications may naturally render together, but this implementation
does not guarantee an atomic visual update.

If completely hiding incremental rendering becomes necessary, design a batch
wire event or commit-complete refresh separately rather than coupling it to the
database optimization.

## Verification

### EventV2

- A same-aggregate batch receives consecutive durable sequences.
- Projectors execute in input order.
- Listeners and streams receive notifications in input order after commit.
- The first notification can read every projection in the batch.
- A projector failure in the middle rolls back projections, event rows, and
  aggregate sequence state.
- A commit-hook failure in the middle rolls back the complete batch.
- A failed batch emits no listener, stream, or durable-subscriber notification.
- A live event is rejected before writes.
- Mixed aggregates are rejected before writes.
- Duplicate event IDs are rejected before writes.
- Concurrent single publish and batch publish cannot allocate duplicate or
  discontinuous sequences.
- Durable subscribers wake once and read the complete committed batch.
- Empty batches do not write or notify.

### EventV2Bridge

- Batch items inherit current directory, workspace, and project location.
- An explicit item location is preserved.
- Message and part notifications retain access to their projected local
  sequence.

### Session Fork

- Forked messages and parts match the selected source range.
- Message IDs, assistant parents, and compaction tail IDs are remapped.
- Durable event history is complete and ordered.
- The first forked-message notification observes the complete cloned history.
- A batch failure leaves no partial destination history.
- Fork runtime no longer scales with one database transaction per message or
  part.

### Revert Cleanup

- The complete reverted suffix is deleted.
- Assistant children are deleted before their user parents.
- Part-boundary cleanup deletes the correct part suffix.
- Existing Session cost and token subtraction remains correct.
- A failure during the removal batch restores every message, part, sidecar,
  usage aggregate, event row, and aggregate sequence.
- The revert marker is retained when deletion fails and cleared only after a
  successful batch.

## Implementation Order

1. Implement and test `EventV2.publishItem()` and `publishBatch()`.
2. Add the explicit `EventV2Bridge.publishBatch()` location wrapper.
3. Convert Session fork history projection to one batch.
4. Convert reverted-history cleanup to one batch.
5. Run Core and OpenCode tests covering events, projection, fork, prompt,
   compaction, and revert cleanup.
6. Run relevant Desktop/Web App and TUI event and hydration tests.
7. Benchmark a long Session before and after the change for both fork and
   cleanup latency.
