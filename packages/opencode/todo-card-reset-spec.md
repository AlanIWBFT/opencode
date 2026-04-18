# Todo Card Reset Spec

Document the migration that clears stale live todos when a new turn starts.

## Goal

- clear stale live todo state when a new prompt or shell turn starts
- keep historical `todowrite` transcript cards untouched
- keep the fix on the authoritative backend state rather than in temporary app cache only

## Problem

An unfinished `todowrite` result could leave persisted live todos behind.

If the next turn started before the old list was cleared, the live todo dock could reopen with stale items even though those items belonged to an earlier turn.

## Investigation Outcome

A frontend-only cache reset was not sufficient because session refresh could re-read the same stale todo rows from backend state.

That meant the fix had to happen where todos are persisted.

## Final Implementation

`packages/opencode/src/session/prompt.ts` now clears persisted todos at the start of:

- `prompt(...)`
- `shellImpl(...)`

This keeps all new-turn entry points aligned because command-driven turns already route through `prompt(...)`.

The migration intentionally does not change transcript rendering.

## Current Migration Note

The original line also carried dedicated stale-todo regression tests.

Those dedicated tests were not reintroduced in this migration pass, so this spec reflects the backend behavior that was migrated rather than claiming the original test coverage moved over unchanged.

## Files Changed

- `packages/opencode/todo-card-reset-spec.md`
- `packages/opencode/src/session/prompt.ts`

## Suggested Verification

- seed a stale live todo list
- start a new prompt turn and confirm the live todo list is cleared
- start a new shell turn and confirm the live todo list is cleared
- confirm historical `todowrite` cards in the transcript remain unchanged
