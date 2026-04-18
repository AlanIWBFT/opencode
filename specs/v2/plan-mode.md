# Plan Mode Migration Spec

Document the `plan_exit` and plan-mode migration onto official `v1.18.3`.

## Goal

- restore end-to-end `plan_exit` behavior for desktop, app, and CLI
- recover in-flight `plan_exit` questions after reconnect or restart
- make plan mode default-on again for supported interactive clients
- keep the migration aligned with the current `v1.18.3` HttpApi architecture instead of replaying the old stack verbatim

## Problem

On the upstream base, plan-mode pieces existed but the interactive desktop/app workflow was still incomplete:

- recovered `plan_exit` requests were not surfaced back through `Question.list/reply/reject`
- reconnecting after a running `plan_exit` could strand the flow
- desktop/app question UIs needed canonical `Yes` / `No` values even when labels were localized
- successful `plan_exit` approval did not fully restore the local build handoff flow
- plan tooling was still gated instead of always enabled for supported interactive clients

## Chosen Approach

Centralize recovered `plan_exit` state in one backend helper, then thread that helper through:

- tool execution
- question recovery
- server reply routes
- desktop/app question presentation

This keeps the migration smaller than a full rollback to the older implementation and better matches the current route and session structure in `v1.18.3`.

## Final Implementation

### Backend recovery path

`packages/opencode/src/tool/plan-state.ts` now centralizes:

- deterministic recovered question ids derived from `messageID + callID`
- canonical recovered question text
- build-handoff message creation
- completion and rejection updates for recovered `plan_exit` tool parts

`packages/opencode/src/question/index.ts` uses that helper so `list`, `reply`, and `reject` can recover a running `plan_exit` from persisted session state.

`packages/opencode/src/tool/plan.ts` uses the same helper for live execution, so recovered and non-recovered flows stay aligned.

### Server reply route resumes the loop

The Effect HttpApi question route now resumes the prompt loop after approving a recovered `plan_exit`:

- `packages/opencode/src/server/routes/instance/httpapi/handlers/question.ts`

On the migrated branch, the HttpApi handler uses `AppRuntime.runPromise(...)` for the background resume step rather than reviving the deleted legacy Hono route stack.

### Revert clears pending questions

`packages/opencode/src/session/revert.ts` now rejects pending questions belonging to the reverted session before performing the revert.

That prevents an old in-flight question from surviving after the session state has been rolled back.

### Plan mode is enabled for supported interactive clients

`packages/opencode/src/tool/registry.ts` now exposes `plan_exit` for `app`, `desktop`, and `cli` through `planEnabled(client)`.

`packages/opencode/src/effect/runtime-flags.ts` also treats `OPENCODE_EXPERIMENTAL_PLAN_MODE` as effectively always on for the migrated branch.

### App-side localized question flow

`packages/app/src/pages/session/composer/session-question-view.ts` separates display labels from submitted values so localized UI can still submit canonical `Yes` / `No` answers.

`packages/app/src/pages/session.tsx` and `packages/app/src/pages/session/session-model-helpers.ts` then switch the local agent to `build` when a `plan_exit` completes successfully.

## Files Changed

- `specs/v2/plan-mode.md`
- `packages/opencode/src/effect/runtime-flags.ts`
- `packages/opencode/src/question/index.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/question.ts`
- `packages/opencode/src/session/revert.ts`
- `packages/opencode/src/tool/plan-state.ts`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zh.ts`
- `packages/app/src/i18n/zht.ts`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/composer/session-question-dock.tsx`
- `packages/app/src/pages/session/composer/session-question-view.ts`
- `packages/app/src/pages/session/composer/session-question-view.test.ts`
- `packages/app/src/pages/session/session-model-helpers.ts`
- `packages/app/src/pages/session/session-model-helpers.test.ts`

## Current Verification

Focused verification on the migrated branch covered:

- `bun typecheck` in `packages/opencode`
- `bun test ./test/question/question.test.ts ./test/tool/question.test.ts ./test/session/prompt.test.ts` in `packages/opencode`
- `bun test ./test/tool/registry.test.ts --test-name-pattern "plan_exit|unsupported"` in `packages/opencode`
- `bun test --preload ./happydom.ts ./src/pages/session/composer/session-question-view.test.ts ./src/pages/session/session-model-helpers.test.ts` in `packages/app`
