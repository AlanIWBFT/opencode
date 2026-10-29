# @opencode/core

Core runtime services for OpenCode.

## Prompt-owned context

Compaction recovery retains completed `question` replies and submitted
`openchamber_render` page choices from the surviving transcript. Page recovery
includes the title, summary and JSON data, not the HTML, and labels them as
page-generated values submitted by the user rather than verbatim user text.
The title comes from the tool result's `openchamber.title`, resolved by the
server when the call omits it, with the original input title as a legacy fallback.
Unanswered pages are excluded. Intact calls and results already retained in the
model context are not duplicated.

`session.prompt` and prompt-producing commands accept `context`, an ordered
array of background text, descriptions and JSON metadata. Preparation validates
the prompt before committing a staged revert. Revert commit and admission share
one `Bus.publishAll` transaction, so rejected admission preserves the old history.

Context is stored inside the user inbox payload. Queue/steer changes and
cancellation apply to that single item. Promotion creates synthetic messages
in context order followed by the user message in one transaction, with
server-assigned context message IDs. Model execution cannot observe half of
that delivery. Repeating the user message ID preserves the original admission
and does not regenerate its context. Standalone synthetic inputs remain available
for independent notifications and compaction restoration.

`session.inbox.close` is stronger than ordinary cancellation: it waits for the
addressed user/synthetic ID's complete admission and wake, persists an admission
closure, then cancels the item only if it is still pending. It returns `closed`,
`cancelled`, or `delivered`; delivered history is never withdrawn. Late requests
and retries with that ID fail without waking the session, across backend restarts.
Other inbox work is untouched. Closure markers are operational KV state, removed
with the session, not messages or replayable conversation events. Ordinary
`session.inbox.cancel` still permits that ID to be admitted again.

## Patch input previews

The session runner broadcasts `patch` argument deltas through the existing
ephemeral `session.tool.input.delta` event, batched on the same 100 ms interval
as text and reasoning. Pending deltas flush before the next block starts and
before the input ends, including failure and interruption cleanup. The complete
input remains in the durable input-ended event; deltas do not write history.
Other tools retain end-only input publication, keeping live argument traffic
limited to the patch preview consumer.

## Conditional location release

Automatic UI cleanup calls `debug.location.evict` with `preserveExec: true`.
Existing exec owners reject it with HTTP 409 while any running, idle, or starting
lane remains. A free owner's launch admission closes before eviction, so a late
launch cannot recreate a shell inside the retiring owner. Explicit eviction
without the option, reload, and shutdown retain their normal cleanup semantics.
The backend's idle-location sweep uses the same conditional release, alongside
upstream execution and background-job protection.
Replacement locations may boot while the retired graph finishes cleanup. Exec
checks its own location lifecycle, so a detached boot cannot launch commands and
the retiring directory does not close its replacement's exec owner.

## Persistent exec control

Windows PowerShell lanes use `src/tool/exec-session/pipe.ts` for a generation-owned
named pipe. The fixed shell loader receives the runner in memory; subsequent
frames carry command source and return cwd. No runner, command, or cwd status
files or temporary directories are created on this path. TTY history uses a
generation-private path with `SaveNothing`, without precreating its directory;
if a command explicitly enables history saving, generation cleanup still owns
that path. Pipe stdin and ConPTY remain user-input channels.
The stdout done frame and matching pipe status must both arrive before an
execution completes, preserving output-tail ordering across the two transports.
Reset, stop, startup failure, and shell exit release the control endpoint with
the generation. Other shell adapters retain file-based runner transport.

## Code Mode selection

Code Mode follows upstream defaults: plugin tools use `execute` unless their
registration sets `options.codemode: false`. Built-in file/web tools and the four
persistent exec controls remain direct tools. There is no global experimental
environment toggle.

A plugin can opt a built-in into Script with the existing `tool.transform`
editor, updating its `options.codemode` to `{ namespace: "$opencode" }`.
For `edit`, `write`, and `patch`, use a shared concurrency policy
`{ group: "filesystem-write", limit: 1 }`; web tools can share
`{ group: "network", limit: 4 }`. Exec follow-ups use
`{ group: "exec-session", limit: 1, inputKey: "exec_id" }`. These policies belong
inside the `codemode` object. Preserve the registration's other options.
Lane launch serialization, child-call snapshots and Script-owned failure cleanup
remain in the runtime regardless of which tools a plugin opts into Code Mode.

## Web research tools

`websearch` accepts a natural-language `query` and optional `numResults` (1–20),
`includeDomains`, `excludeDomains`, `highlightsQuery`, and `maxCharacters`
(200–8000 per excerpt). Exa uses its advanced MCP search with query-focused
highlights, defaulting to 8 results and 1800 characters per result. Credentials
use the `x-api-key` header. Results identify the provider and distinguish
highlights from text previews; neither is a complete page.

Providers declare supported option names in their registration. Core rejects
unsupported options before making a provider request, including on random-mode
failover. It never silently drops filters. Provider capabilities and search
options are also available through the public web-search API and plugin hosts.

`webfetch` supports three operations:

- `open` (default): pass `url`, optionally `format`, `timeout`, `offset`, or
  `limit`. Fetches once and returns a bounded preview plus a snapshot `ref`.
- `read`: pass `ref`, optionally `offset` and `limit`, to read more captured text.
- `find`: pass `ref` and a literal `pattern`, optionally `offset`, `caseSensitive`,
  and `context`, to locate evidence with surrounding text. Matching defaults to
  case-insensitive. Follow `nextOffset` when more matches remain.

Find merges overlapping context windows and lists every returned hit in
`matchOffsets` (`matchOffset` remains the first hit in each window). Each response
allows 10 windows, 100 hits, and 10000 context characters, counting shared text
only once. Continuation starts at the first hit not included in the response.

Offsets are zero-based UTF-16 positions with exclusive end positions. Read
previews default to 6000 characters and allow up to 12000; a surrogate pair is
kept intact even with a one-character limit. Character paging also supports
minified HTML and long unbroken lines without losing the rest of a line.

Readable HTML prefers semantic `main` (including `role=main`) regions, then
`article` regions, falling back to the whole document. Sibling regions are kept.
Readable formats retain `noscript` fallback content because extraction does not
execute JavaScript; some sites place their entire readable page there.
Markdown responses reduce YAML frontmatter to title, canonical URL, description,
and dates. Invalid frontmatter remains intact. `format=html` preserves the raw
response for inspecting content outside the selected regions. Extraction happens
before persistence, so `find` and `read` share the same stable offsets.

Each open creates a new immutable extraction under the existing `tool-output`
directory (`tool_*.web.json`). Snapshots share its seven-day cleanup policy and
survive service restarts. Reads reject expired or unavailable refs rather than
refetching silently, and recheck the original URL's `webfetch` permission. All
operations are read-only with respect to the source site. Extraction uses HTTP
and does not execute JavaScript; the snapshot is the captured extraction, not a
claim that every part of the site was rendered or preserved.

HTTP failure messages carry JSON diagnostics (`source`, `status`, `failureKind`,
`evidence`, `suggestedAction`). Target-page browser challenges suggest headed
Playwright; ordinary 403 responses do not. Search-provider HTTP failures are
identified separately and suggest checking the provider rather than treating a
browser as an API repair. Evidence uses fixed strings, never raw response bodies
or cookies. Cloudflare detection uses `cf-mitigated: challenge` or a challenge
page title together with its challenge script marker; a recognized HTTP 200
challenge is rejected before snapshot persistence. The existing one-time
Cloudflare user-agent retry remains in place.
Explicit challenge headers are diagnosed without reading the body. Other HTTP
errors use at most the first 64 KiB of the body, retaining the prefix when the
stream fails and stopping without waiting for the remainder. If this diagnostic
read times out, the already received HTTP status and headers still determine the
failure instead of being replaced with a generic request timeout.

## Windows Recycle Bin helper

Persistent PowerShell filesystem deletion uses the protocol-2 helper under
`src/windows-recycle`. It refuses permanent-delete fallback and reports bounded
lock diagnostics after sharing violations, including mapped files/images and PIDs
where available. Diagnostics do not terminate blocking processes.

For checkout execution and focused tests, explicitly prepare the helper with
`bun run build:windows-recycle` from this package. Tests do not build it implicitly.
The Windows CLI packaging build prepares and copies the DLL next to the executable;
the coordinator must carry that sidecar into the packaged application.
