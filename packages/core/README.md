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

## Windows Recycle Bin helper

Persistent PowerShell filesystem deletion uses the protocol-2 helper under
`src/windows-recycle`. It refuses permanent-delete fallback and reports bounded
lock diagnostics after sharing violations, including mapped files/images and PIDs
where available. Diagnostics do not terminate blocking processes.

For checkout execution and focused tests, explicitly prepare the helper with
`bun run build:windows-recycle` from this package. Tests do not build it implicitly.
The Windows CLI packaging build prepares and copies the DLL next to the executable;
the coordinator must carry that sidecar into the packaged application.
