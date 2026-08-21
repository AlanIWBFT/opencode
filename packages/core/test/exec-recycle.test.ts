import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/schema/session-message"
import { ExecSession } from "@opencode/core/tool/exec-session"
import { persistentShellScript } from "@opencode/core/tool/exec-session/shell"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ExecSession.node, Session.node, Location.node]), [
    Location.node.replace(tempLocationLayer),
    SessionExecution.node.replace(SessionExecution.noopLayer),
  ]),
)
const assembly = fileURLToPath(
  new URL("../src/windows-recycle/bin/Release/netstandard2.0/OpenCode.Windows.RecycleBin.dll", import.meta.url),
)
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const setup = Effect.fnUntraced(function* (shell: string) {
  const location = yield* Location.Service
  const sessions = yield* Session.Service
  const executions = yield* ExecSession.Service
  const session = yield* sessions.create({ location: { directory: location.directory } })
  const invocation: ExecSession.Invocation = {
    sessionID: session.id,
    messageID: SessionMessage.ID.create(),
    display: "root",
    metadata: () => Effect.void,
  }
  const run = (command: string) =>
    executions.launch({
      command,
      shell,
      cwd: location.directory,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      invocation,
      yieldTimeMs: 10_000,
      prepare: () => Effect.succeed({ script: persistentShellScript(shell, { command }) }),
    })
  return { run, directory: location.directory, stop: sessions.stop(session.id) }
})

for (const name of ["pwsh", "powershell"]) {
  const shell = process.platform === "win32" ? Bun.which(name) : null
  const windowsTest = shell ? it.live : it.live.skip

  windowsTest(
    `recycles through the guarded aliases without locking the helper [${name}]`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup(shell!)
        const file = path.join(fixture.directory, "recycle.txt")
        const result = yield* fixture.run(`Set-StrictMode -Version Latest
Set-Content -LiteralPath ${quote(file)} -Value example
Get-Item -LiteralPath ${quote(file)} | Remove-Item -WhatIf
Write-Output ('whatif-kept:' + (Test-Path -LiteralPath ${quote(file)}))
rm -LiteralPath ${quote(file)}
Write-Output ('recycled:' + (-not (Test-Path -LiteralPath ${quote(file)})))
$env:OPENCODE_RECYCLE_TEST = 'value'
Remove-Item Env:OPENCODE_RECYCLE_TEST
Write-Output ('environment-removed:' + (-not (Test-Path Env:OPENCODE_RECYCLE_TEST)))
$stream = [IO.File]::Open(${quote(assembly)}, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$stream.Dispose()
$type = [OpenCode.Windows.RecycleBin].Assembly.GetType('OpenCode.Windows.FileOperationProgressSink')
$sink = [Activator]::CreateInstance($type, $true)
$hr = $type.GetMethod('PreDeleteItem').Invoke($sink, @([uint32]0, $null))
Write-Output ('unsafe-delete-denied:' + ($hr -lt 0))`)
        expect(result.error).toBeUndefined()
        expect(result.running).toBe(false)
        expect(result.exitCode).toBe(0)
        for (const text of [
          "whatif-kept:True",
          "recycled:True",
          "environment-removed:True",
          "unsafe-delete-denied:True",
        ])
          expect(result.output).toContain(text)
        yield* fixture.stop
      }),
    { timeout: 20_000 },
  )

  for (const kind of ["handle", "mapping", "image"] as const) {
    windowsTest(
      `diagnoses a ${kind} blocker and preserves the target [${name}]`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* setup(shell!)
          const target = path.join(fixture.directory, kind === "image" ? "loaded-image" : `${kind}.txt`)
          const file = kind === "image" ? path.join(target, "image.dll") : target
          const initialize =
            kind === "image"
              ? `New-Item -ItemType Directory -Path ${quote(target)} | Out-Null
Copy-Item -LiteralPath ${quote(assembly)} -Destination ${quote(file)}
$assembly = [Reflection.Assembly]::LoadFile(${quote(file)})`
              : `Set-Content -LiteralPath ${quote(file)} -Value locked
$stream = [IO.File]::Open(${quote(file)}, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, ${kind === "handle" ? "[IO.FileShare]::None" : "([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)"})
${
  kind === "mapping"
    ? `$mapping = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($stream, [System.Management.Automation.Language.NullString]::Value, 0, [IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite, [IO.HandleInheritability]::None, $false)
$view = $mapping.CreateViewAccessor()
$stream.Dispose()`
    : ""
}`
          const release =
            kind === "image" ? "" : kind === "mapping" ? "$view.Dispose(); $mapping.Dispose()" : "$stream.Dispose()"
          const result = yield* fixture.run(`${initialize}
try { Remove-Item -LiteralPath ${quote(target)} -Recurse } finally { ${release} }`)
          expect(result.running).toBe(false)
          expect(result.exitCode).not.toBe(0)
          expect(result.output).toContain("Deletion could not be completed safely")
          expect(result.output).toContain(file)
          expect(result.output).toContain(
            kind === "handle"
              ? "open handle denies deletion"
              : kind === "mapping"
                ? "memory-mapped file"
                : "loaded image",
          )
          expect(result.output).toContain("PID ")
          expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
          yield* fixture.stop
          // Release the image-owning process, then clean up through the guarded path as well.
          const cleaned = yield* fixture.run(`Remove-Item -LiteralPath ${quote(target)} -Recurse`)
          expect(cleaned.exitCode).toBe(0)
          yield* fixture.stop
        }),
      { timeout: 25_000 },
    )
  }
}
