import { NodeStream } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Stream } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WindowsProcessBroker } from "@opencode-ai/core/windows-process-broker"

const run = (executable: string, args: string[], options?: { stdin?: string }) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = WindowsProcessBroker.launch(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      stdin: options?.stdin !== undefined,
      keepStdinOpen: options?.stdin !== undefined,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }))
    if (options?.stdin !== undefined) child.stdin?.end(options.stdin)
  })

const waitForFile = async (file: string) => {
  for (let attempt = 0; attempt < 500; ++attempt) {
    try {
      return await fs.readFile(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await Bun.sleep(10)
    }
  }
  throw new Error(`Timed out waiting for ${file}`)
}

const git = process.platform === "win32" ? WindowsProcessBroker.resolve("git", process.env) : undefined
const rg = process.platform === "win32" ? Bun.which("rg") : null

describe.skipIf(process.platform !== "win32")("WindowsProcessBroker", () => {
  test("emits a failure close exactly once after a broker failure", () => {
    const child = new WindowsProcessBroker.ManagedProcess(false)
    const events: string[] = []
    child.on("error", () => events.push("error"))
    child.on("close", (code) => events.push(`close:${code}`))

    child.exited(0)
    child.fail(new Error("broker disconnected"))
    child.fail(new Error("duplicate disconnect"))

    expect(child.exitCode).toBe(-1)
    expect(events).toEqual(["error", "close:-1"])
  })

  test("settles an active output reader after a broker failure", async () => {
    const child = new WindowsProcessBroker.ManagedProcess(false)
    child.on("error", () => {})
    const result = Effect.runPromiseExit(
      Stream.runCollect(
        NodeStream.fromReadable({
          evaluate: () => child.stdout,
          onError: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
      ).pipe(Effect.timeout("1 second")),
    )

    expect(child.stdout.listenerCount("close")).toBeGreaterThan(1)
    child.fail(new Error("broker disconnected"))

    const exit = await result
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("Expected output reader to fail")
    const error = Cause.squash(exit.cause)
    expect(error instanceof Error ? error.message : String(error)).toBe("Readable closed before emitting 'end'")
  })

  test("limits central process routing to Git and ripgrep", () => {
    expect(WindowsProcessBroker.resolve(process.execPath, process.env)).toBeUndefined()
    if (git) {
      expect(WindowsProcessBroker.resolve("git", process.env)).toBe(git)
      expect(WindowsProcessBroker.resolve(git, process.env)).toBe(git)
    }
    if (rg) expect(WindowsProcessBroker.resolve(rg, process.env)).toBe(rg)
  })

  test("captures stdout, stderr, stdin, and the exit code", async () => {
    const script = "process.stdin.on('data',c=>{process.stdout.write(c);process.stderr.write('err')})"
    const result = await run(process.execPath, ["-e", script], { stdin: "hello" })
    expect(result).toEqual({ code: 0, stdout: "hello", stderr: "err" })
  }, 10_000)

  test("runs four commands concurrently", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) => run(process.execPath, ["-e", `process.stdout.write('${index}')`])),
    )
    expect(results.map((result) => result.stdout).sort()).toEqual(["0", "1", "2", "3"])
    expect(results.every((result) => result.code === 0)).toBe(true)
  }, 10_000)

  test.skipIf(!git)("resolves and runs the Git for Windows runtime directly", async () => {
    const runtime = path.basename(path.dirname(path.dirname(git!))).toLowerCase()
    expect(["clangarm64", "mingw32", "mingw64", "ucrt64"]).toContain(runtime)
    const result = await run(git!, ["--version"])
    expect(result.code).toBe(0)
    expect(result.stdout).toStartWith("git version ")
  }, 10_000)

  test.skipIf(!rg)("runs an absolute ripgrep executable", async () => {
    const result = await run(rg!, ["--version"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("ripgrep")
  }, 10_000)

  test("applies backpressure while transferring large output", async () => {
    const bytes = 100 * 1024 * 1024
    const child = WindowsProcessBroker.launch(process.execPath, ["-e", `process.stdout.write(Buffer.alloc(${bytes},97))`], {
      cwd: process.cwd(),
      env: process.env,
      stdin: false,
      keepStdinOpen: false,
    })
    const closed = new Promise<number>((resolve, reject) => {
      let received = 0
      child.once("error", reject)
      child.once("close", () => resolve(received))
      setTimeout(() => child.stdout.on("data", (chunk) => (received += chunk.length)), 200)
    })
    expect(await closed).toBe(bytes)
  }, 30_000)

  test("keeps streams and commands independent under output backpressure", async () => {
    const noisy = "const chunk=Buffer.alloc(65536,97);const write=()=>{while(process.stdout.write(chunk));process.stdout.once('drain',write)};write()"
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(noisy)}],{stdio:['ignore',1,'ignore']});setTimeout(()=>process.stderr.write('ready'),50);setInterval(()=>{},60000)`
    const child = WindowsProcessBroker.launch(
      process.execPath,
      ["-e", script],
      {
        cwd: process.cwd(),
        env: process.env,
        stdin: false,
        keepStdinOpen: false,
      },
    )
    const failed = new Promise<never>((_, reject) => child.once("error", reject))
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
    const marker = new Promise<void>((resolve) => child.stderr.once("data", () => resolve()))
    const withTimeout = <T>(task: Promise<T>, stage: string) => new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${stage}`)), 3_000)
      task.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
    try {
      await withTimeout(Promise.race([marker, failed]), "independent stderr")
      const result = await withTimeout(Promise.race([
        run(process.execPath, ["-e", "process.stdout.write('independent')"]),
        failed,
      ]), "independent command")
      expect(result).toEqual({ code: 0, stdout: "independent", stderr: "" })
      const flowing = new Promise<void>((resolve) => child.stdout.once("data", () => resolve()))
      child.stdout.resume()
      await withTimeout(Promise.race([flowing, failed]), "continuous output")
      const fair = await withTimeout(Promise.race([
        run(process.execPath, ["-e", "process.stdout.write('fair')"]),
        failed,
      ]), "fair command")
      expect(fair).toEqual({ code: 0, stdout: "fair", stderr: "" })
    } finally {
      child.kill()
      await closed
    }
  }, 10_000)

  test("cancels while the child is blocked without reading stdin", async () => {
    const child = WindowsProcessBroker.launch(process.execPath, ["-e", "setInterval(()=>{},60000)"], {
      cwd: process.cwd(),
      env: process.env,
      stdin: true,
      keepStdinOpen: true,
    })
    child.stdin?.on("error", () => {})
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", () => resolve())
    })
    child.stdin?.write(Buffer.alloc(8 * 1024 * 1024))
    await Bun.sleep(100)
    expect(child.kill()).toBe(true)
    await closed
  }, 10_000)

  test("cancellation terminates descendants in the command job", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-process-broker-"))
    const childPidFile = path.join(directory, "child.pid")
    const childScript = "setInterval(()=>{},60000)"
    const rootScript = `const {spawn}=require('node:child_process');const fs=require('node:fs');const p=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(childPidFile)},String(p.pid));setInterval(()=>{},60000)`
    try {
      const child = WindowsProcessBroker.launch(process.execPath, ["-e", rootScript], {
        cwd: directory,
        env: process.env,
        stdin: false,
        keepStdinOpen: false,
      })
      const closed = new Promise<void>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", () => resolve())
      })
      const descendantPid = Number(await waitForFile(childPidFile))
      expect(child.kill()).toBe(true)
      await closed
      await Bun.sleep(100)
      expect(() => process.kill(descendantPid, 0)).toThrow()
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 10_000)
})
