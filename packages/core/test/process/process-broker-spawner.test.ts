import { expect } from "bun:test"
import { execFileSync } from "node:child_process"
import { Effect, Exit, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppProcess } from "@opencode/util/process"
import { WindowsProcessBroker } from "@opencode/util/windows-process-broker"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))
const git = WindowsProcessBroker.resolve("git", process.env)
const live = process.platform === "win32" && git && WindowsProcessBroker.available() ? it.live : it.live.skip
const blockingGit = () =>
  ChildProcess.make(git!, ["cat-file", "--batch"], {
    extendEnv: true,
    stdin: { stream: "pipe", endOnDone: false },
  })

live(
  "explicit kill cancels a broker-managed Git process",
  () =>
    Effect.gen(function* () {
      const svc = yield* AppProcess.Service
      const handle = yield* svc.spawn(blockingGit())
      expect(yield* handle.isRunning).toBe(true)
      yield* handle.kill()
      expect(yield* handle.isRunning).toBe(false)
    }),
  { timeout: 10_000 },
)

live(
  "broker disconnect fails a managed Git process",
  () =>
    Effect.gen(function* () {
      const svc = yield* AppProcess.Service
      const handle = yield* svc.spawn(blockingGit())
      const pid = Number(
        execFileSync(
          "pwsh",
          [
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid} AND Name = 'OpenCode.ProcessBroker.exe'" | Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId)`,
          ],
          { encoding: "utf8" },
        ).trim(),
      )
      expect(pid).toBeGreaterThan(0)
      process.kill(pid, "SIGKILL")
      expect(Exit.isFailure(yield* Effect.exit(handle.exitCode))).toBe(true)
    }),
  { timeout: 15_000 },
)

live("runs Git through the Windows process backend", () =>
  Effect.gen(function* () {
    const svc = yield* AppProcess.Service
    const result = yield* svc.run(ChildProcess.make("git", ["--version"], { extendEnv: true, stdin: "ignore" }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toStartWith("git version ")
  }),
)

live(
  "retains a Git blob while its output consumer is slow",
  () =>
    Effect.gen(function* () {
      const svc = yield* AppProcess.Service
      const tmp = yield* tmpdirScoped()
      const options = { cwd: tmp.path, extendEnv: true } as const
      const initialized = yield* svc.run(ChildProcess.make(git!, ["init", "--quiet"], options))
      expect(initialized.exitCode).toBe(0)
      const bytes = 4 * 1024 * 1024
      const stored = yield* svc.run(
        ChildProcess.make(git!, ["hash-object", "-w", "--stdin"], {
          ...options,
          stdin: Stream.make(Buffer.alloc(bytes, 97)),
        }),
      )
      expect(stored.exitCode).toBe(0)
      const handle = yield* svc.spawn(
        ChildProcess.make(git!, ["cat-file", "blob", stored.stdout.toString().trim()], {
          ...options,
          stdin: "ignore",
        }),
      )
      const received = yield* handle.stdout.pipe(
        Stream.tap(() => Effect.sleep("300 millis")),
        Stream.runFold(
          () => 0,
          (total, chunk) => total + chunk.length,
        ),
      )
      expect(received).toBe(bytes)
      expect(Number(yield* handle.exitCode)).toBe(0)
    }),
  { timeout: 40_000 },
)
