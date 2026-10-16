import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { ExecPipe } from "@opencode/core/tool/exec-session/pipe"
import {
  persistentShellBootstrapFrame,
  persistentShellPipeArgs,
  persistentShellRunnerScript,
  persistentShellScript,
} from "@opencode/core/tool/exec-session/shell"
import { tmpdir } from "./fixture/tmpdir"

for (const executable of ["pwsh", "powershell"]) {
  const shell = process.platform === "win32" ? Bun.which(executable) : null
  const windowsTest = shell ? test : test.skip
  windowsTest(
    `${executable} control pipe retains Unicode state across exit without command or status files`,
    async () => {
      await using dir = await tmpdir("opencode-exec-protocol-")
      const nonce = "protocoltest"
      const name = `opencode-test-${crypto.randomUUID()}`
      const channel = await ExecPipe.open(
        name,
        persistentShellRunnerScript(shell!, { nonce, tty: false, controlPipe: true }),
        () => {},
      )
      const commands = [
        "$value = '你好'; function Test-Persisted { '函数' }; [Console]::WriteLine('first'); exit 7",
        "[Console]::WriteLine($value + ':' + (Test-Persisted)); $env:OPENCODE_PROTOCOL_TEST = 'retained'",
        "cmd.exe /c exit 9",
        "[Console]::WriteLine($env:OPENCODE_PROTOCOL_TEST)",
        "Write-Error 'expected non-native failure'",
        `# ${"long source ".repeat(20_000)}\n[Console]::WriteLine('long-command-end')`,
      ]
      const child = Bun.spawn([shell!, ...persistentShellPipeArgs(name)], {
        cwd: dir.path,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      })
      let text = ""
      const output = (async () => {
        const decoder = new TextDecoder()
        for await (const chunk of child.stdout) text += decoder.decode(chunk, { stream: true })
        text += decoder.decode()
      })()
      const errors = new Response(child.stderr).text()
      const waitFor = async (marker: string) => {
        const deadline = Date.now() + 10_000
        while (!text.includes(marker) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10)
        expect(text).toContain(marker)
      }
      try {
        await waitFor(persistentShellBootstrapFrame(nonce, false))
        for (const [index, command] of commands.entries()) {
          expect(await channel.request(index + 1, persistentShellScript(shell!, { command }))).toBe(true)
          expect((await channel.completion(index + 1))?.toLowerCase()).toBe(dir.path.toLowerCase())
          await waitFor(`\x1e${nonce}:${index + 1}:done:`)
        }
        channel.close()
        expect(await child.exited).toBe(0)
        expect(await errors).toBe("")
        await output
        expect(text).toContain(persistentShellBootstrapFrame(nonce, false))
        expect(text).toContain("你好:函数")
        expect(text).toContain("retained")
        expect(text).toContain("long-command-end")
        expect(await readdir(dir.path)).toEqual([])
        for (const [index, code] of [7, 0, 9, 0, 1, 0].entries()) {
          expect(text).toContain(`\x1e${nonce}:${index + 1}:start\x1f`)
          expect(text).toContain(`\x1e${nonce}:${index + 1}:done:${code}\x1f`)
        }
      } finally {
        channel.close()
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    },
    20_000,
  )
}
