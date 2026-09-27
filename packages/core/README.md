# @opencode/core

Core runtime services for OpenCode.

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

## Windows Recycle Bin helper

Persistent PowerShell filesystem deletion uses the protocol-2 helper under
`src/windows-recycle`. It refuses permanent-delete fallback and reports bounded
lock diagnostics after sharing violations, including mapped files/images and PIDs
where available. Diagnostics do not terminate blocking processes.

For checkout execution and focused tests, explicitly prepare the helper with
`bun run build:windows-recycle` from this package. Tests do not build it implicitly.
The Windows CLI packaging build prepares and copies the DLL next to the executable;
the coordinator must carry that sidecar into the packaged application.
