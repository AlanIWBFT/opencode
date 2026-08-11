import { expect, test } from "bun:test"
import path from "node:path"
import {
  persistentShellArgs,
  persistentShellBootstrapFrame,
  persistentShellBootstrapRequest,
  persistentShellRequest,
  persistentShellRunnerScript,
  persistentShellScript,
} from "@opencode/core/tool/exec-session/shell"
import { tmpdir } from "./fixture/tmpdir"

const pwsh = process.platform === "win32" ? Bun.which("pwsh") : null
const windowsTest = pwsh ? test : test.skip

windowsTest(
  "PowerShell framed commands retain Unicode state across exit and report native failure",
  async () => {
    await using dir = await tmpdir("opencode-exec-protocol-")
    const shell = pwsh!
    const nonce = "protocoltest"
    const runnerFile = path.join(dir.path, "runner.ps1")
    await Bun.write(runnerFile, persistentShellRunnerScript(shell, { nonce, tty: false }))
    const commands = [
      "$value = '你好'; function Test-Persisted { '函数' }; [Console]::WriteLine('first'); exit 7",
      "[Console]::WriteLine($value + ':' + (Test-Persisted)); $env:OPENCODE_PROTOCOL_TEST = 'retained'",
      "cmd.exe /c exit 9",
      "[Console]::WriteLine($env:OPENCODE_PROTOCOL_TEST)",
    ]
    const requests = [persistentShellBootstrapRequest(shell, runnerFile, false)!]
    const statusFiles: string[] = []
    for (const [index, command] of commands.entries()) {
      const commandFile = path.join(dir.path, `command '${index}.ps1`)
      const statusFile = path.join(dir.path, `status ${index}.txt`)
      statusFiles.push(statusFile)
      await Bun.write(commandFile, persistentShellScript(shell, { command }))
      await Bun.write(statusFile, "")
      requests.push(
        persistentShellRequest(shell, {
          executionID: index + 1,
          commandFile,
          runnerFile,
          statusFile,
          nonce,
          tty: false,
        }),
      )
    }
    const child = Bun.spawn([shell, ...persistentShellArgs(shell, false, runnerFile)], {
      cwd: dir.path,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    })
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    try {
      for (const request of requests) child.stdin.write(request)
      child.stdin.end()
      expect(await child.exited).toBe(0)
      expect(await errors).toBe("")
      const text = await output
      expect(text).toContain(persistentShellBootstrapFrame(nonce, false))
      expect(text).toContain("你好:函数")
      expect(text).toContain("retained")
      for (const [index, code] of [7, 0, 9, 0].entries()) {
        expect(text).toContain(`\x1e${nonce}:${index + 1}:start\x1f`)
        expect(text).toContain(`\x1e${nonce}:${index + 1}:done:${code}\x1f`)
        expect((await Bun.file(statusFiles[index]).text()).toLowerCase()).toBe(dir.path.toLowerCase())
      }
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  },
  15_000,
)
