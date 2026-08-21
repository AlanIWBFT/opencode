# @opencode/core

Core runtime services for OpenCode.

## Windows Recycle Bin helper

Persistent PowerShell filesystem deletion uses the protocol-2 helper under
`src/windows-recycle`. It refuses permanent-delete fallback and reports bounded
lock diagnostics after sharing violations, including mapped files/images and PIDs
where available. Diagnostics do not terminate blocking processes.

For checkout execution and focused tests, explicitly prepare the helper with
`bun run build:windows-recycle` from this package. Tests do not build it implicitly.
The Windows CLI packaging build prepares and copies the DLL next to the executable;
the coordinator must carry that sidecar into the packaged application.
