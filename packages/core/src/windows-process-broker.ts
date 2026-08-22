import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { statSync } from "node:fs"
import { connect, type Socket } from "node:net"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"

const MAGIC = 0x4250434f
const VERSION = 2
const HEADER_BYTES = 20
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
const BROKER_FAILURE_EXIT_CODE = -1
const OUTPUT_HIGH_WATER_MARK = 256 * 1024
const OUTPUT_INITIAL_CREDIT = 64 * 1024

const frameType = {
  hello: 1,
  helloOk: 2,
  spawn: 3,
  spawned: 4,
  stdin: 5,
  stdinClose: 6,
  stdout: 7,
  stderr: 8,
  exit: 9,
  close: 10,
  cancel: 11,
  error: 12,
  credit: 13,
  stdinAck: 14,
} as const

export interface SpawnOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdin: boolean
  readonly keepStdinOpen: boolean
}

class ManagedOutput extends PassThrough {
  private client: Client | undefined
  private id = 0n
  private outstanding = 0
  private pendingCredit = 0
  private waitingForDrain = false
  private finished = false
  private discarded = false

  constructor(private type: number) {
    super({ highWaterMark: OUTPUT_HIGH_WATER_MARK })
    this.once("close", () => {
      if (this.finished) return
      this.discarded = true
      this.flushCredit()
    })
  }

  attach(client: Client, id: bigint) {
    this.client = client
    this.id = id
    this.grant(OUTPUT_INITIAL_CREDIT)
  }

  output(payload: Buffer<ArrayBufferLike>) {
    if (this.finished || payload.length > this.outstanding) return false
    this.outstanding -= payload.length
    if (this.destroyed) this.discarded = true
    if (this.discarded || this.write(payload)) {
      this.grant(payload.length)
      return true
    }
    this.pendingCredit += payload.length
    if (!this.waitingForDrain) {
      this.waitingForDrain = true
      this.once("drain", () => {
        this.waitingForDrain = false
        this.flushCredit()
      })
    }
    return true
  }

  complete() {
    if (this.finished) return
    this.finished = true
    if (!this.destroyed) this.end()
  }

  fail() {
    if (this.finished) return
    this.finished = true
    this.destroy()
  }

  private grant(amount: number) {
    if (!this.client || this.finished || amount === 0) return
    this.outstanding += amount
    this.client.credit(this.id, this.type, amount)
  }

  private flushCredit() {
    const amount = this.pendingCredit
    this.pendingCredit = 0
    this.grant(amount)
  }
}

export class ManagedProcess extends EventEmitter {
  readonly stdout = new ManagedOutput(frameType.stdout)
  readonly stderr = new ManagedOutput(frameType.stderr)
  readonly stdin: Writable | null
  readonly stdio: [Writable | null, ManagedOutput, ManagedOutput]
  pid: number | undefined
  exitCode: number | null = null
  killed = false
  private client: Client | undefined
  private id = 0n
  private closed = false
  private pendingWrite: { payload: Buffer<ArrayBufferLike>; callback: (error?: Error | null) => void } | undefined
  private pendingClose: ((error?: Error | null) => void) | undefined
  private stdinCallback: ((error?: Error | null) => void) | undefined
  private pendingKill = false

  constructor(stdin: boolean) {
    super()
    this.stdin = stdin ? new Writable({
      write: (chunk: Buffer | string, encoding, callback) => {
        if (!this.client) {
          this.pendingWrite = {
            payload: Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding),
            callback,
          }
          return
        }
        this.startStdin(frameType.stdin, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding), callback)
      },
      final: (callback) => {
        if (!this.client) {
          this.pendingClose = callback
          return
        }
        this.startStdin(frameType.stdinClose, Buffer.alloc(0), callback)
      },
    }) : null
    this.stdio = [this.stdin, this.stdout, this.stderr]
  }

  attach(client: Client, id: bigint) {
    this.client = client
    this.id = id
    this.stdout.attach(client, id)
    this.stderr.attach(client, id)
    if (this.pendingWrite) {
      const pending = this.pendingWrite
      this.pendingWrite = undefined
      this.startStdin(frameType.stdin, pending.payload, pending.callback)
    }
    if (this.pendingClose) {
      const callback = this.pendingClose
      this.pendingClose = undefined
      this.startStdin(frameType.stdinClose, Buffer.alloc(0), callback)
    }
    if (this.pendingKill) client.write(frameType.cancel, id)
  }

  spawned(pid: number) {
    this.pid = pid
    this.emit("spawn")
  }

  output(type: number, payload: Buffer<ArrayBufferLike>) {
    const stream = type === frameType.stdout ? this.stdout : type === frameType.stderr ? this.stderr : undefined
    return stream?.output(payload) ?? false
  }

  stdinAcknowledged(code: number) {
    this.finishStdin(code === 0 ? undefined : Object.assign(new Error(`Windows process broker stdin write failed (${code})`), { code }))
  }

  exited(code: number) {
    this.exitCode = code
    this.emit("exit", code, null)
  }

  complete() {
    if (this.closed) return
    this.closed = true
    this.finishStdin(new Error("Windows process broker closed before stdin completed"))
    this.stdout.complete()
    this.stderr.complete()
    if (this.stdin && !this.stdin.destroyed) this.stdin.destroy()
    this.emit("close", this.exitCode, null)
  }

  fail(error: Error) {
    if (this.closed) return
    this.closed = true
    this.exitCode = BROKER_FAILURE_EXIT_CODE
    this.pendingWrite?.callback(error)
    this.pendingClose?.(error)
    this.pendingWrite = undefined
    this.pendingClose = undefined
    this.finishStdin(error)
    this.stdout.fail()
    this.stderr.fail()
    this.stdin?.destroy()
    this.emit("error", error)
    this.emit("close", this.exitCode, null)
  }

  kill() {
    if (this.closed) return false
    this.killed = true
    if (!this.client) {
      this.pendingKill = true
      return true
    }
    this.client.write(frameType.cancel, this.id)
    return true
  }

  ref() {
    return this
  }

  unref() {
    return this
  }

  private startStdin(type: number, payload: Buffer<ArrayBufferLike>, callback: (error?: Error | null) => void) {
    if (!this.client) {
      callback(new Error("Windows process broker stdin is not attached"))
      return
    }
    if (this.stdinCallback) {
      callback(new Error("Windows process broker received overlapping stdin writes"))
      return
    }
    this.stdinCallback = callback
    this.client.write(type, this.id, payload, (error) => {
      if (error) this.finishStdin(error)
    })
  }

  private finishStdin(error?: Error | null) {
    const callback = this.stdinCallback
    this.stdinCallback = undefined
    callback?.(error)
  }
}

class Client {
  private socket: Socket
  private input: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private nextID = 1n
  private commands = new Map<bigint, ManagedProcess>()
  private helloResolve: (() => void) | undefined
  private helloReject: ((error: Error) => void) | undefined
  readonly ready: Promise<void>
  closed = false

  constructor(socket: Socket) {
    this.socket = socket
    this.ready = new Promise<void>((resolve, reject) => {
      this.helloResolve = resolve
      this.helloReject = reject
    })
    socket.on("data", (chunk) => this.onData(chunk))
    socket.on("error", (error) => this.disconnect(error))
    socket.on("close", () => this.disconnect(new Error("Windows process broker disconnected")))
    this.write(frameType.hello, 0n)
  }

  spawn(process: ManagedProcess, executable: string, args: readonly string[], options: SpawnOptions) {
    const id = this.nextID++
    const environment = Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    const parts = [u32(options.keepStdinOpen ? 1 : 0), string(executable), string(options.cwd), u32(args.length)]
    for (const argument of args) parts.push(string(argument))
    parts.push(u32(environment.length))
    for (const [key, value] of environment) parts.push(string(key), string(value))
    this.socket.ref()
    this.commands.set(id, process)
    this.write(frameType.spawn, id, Buffer.concat(parts), (error) => {
      if (!error) return
      this.commands.delete(id)
      process.fail(error)
      if (this.commands.size === 0) this.socket.unref()
    })
    process.attach(this, id)
  }

  write(type: number, id: bigint, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0), callback?: (error?: Error | null) => void) {
    if (this.closed) {
      callback?.(new Error("Windows process broker is closed"))
      return
    }
    const header = Buffer.allocUnsafe(HEADER_BYTES)
    header.writeUInt32LE(MAGIC, 0)
    header.writeUInt16LE(VERSION, 4)
    header.writeUInt16LE(type, 6)
    header.writeBigUInt64LE(id, 8)
    header.writeUInt32LE(payload.length, 16)
    this.socket.write(payload.length === 0 ? header : Buffer.concat([header, payload]), callback)
  }

  credit(id: bigint, type: number, amount: number) {
    const payload = Buffer.allocUnsafe(6)
    payload.writeUInt16LE(type, 0)
    payload.writeUInt32LE(amount, 2)
    this.write(frameType.credit, id, payload)
  }

  private onData(chunk: Buffer<ArrayBufferLike>) {
    this.input = this.input.length === 0 ? chunk : Buffer.concat([this.input, chunk])
    while (this.input.length >= HEADER_BYTES) {
      if (this.input.readUInt32LE(0) !== MAGIC || this.input.readUInt16LE(4) !== VERSION) {
        this.socket.destroy(new Error("Invalid Windows process broker frame"))
        return
      }
      const size = this.input.readUInt32LE(16)
      if (size > MAX_PAYLOAD_BYTES) {
        this.socket.destroy(new Error("Windows process broker frame is too large"))
        return
      }
      if (this.input.length < HEADER_BYTES + size) return
      const type = this.input.readUInt16LE(6)
      const id = this.input.readBigUInt64LE(8)
      const payload = this.input.subarray(HEADER_BYTES, HEADER_BYTES + size)
      this.input = this.input.subarray(HEADER_BYTES + size)
      this.dispatch(type, id, payload)
    }
  }

  private dispatch(type: number, id: bigint, payload: Buffer<ArrayBufferLike>) {
    if (type === frameType.helloOk) {
      this.helloResolve?.()
      this.helloResolve = undefined
      this.helloReject = undefined
      return
    }
    const process = this.commands.get(id)
    if (!process && type === frameType.stdinAck) return
    if (!process) {
      this.socket.destroy(new Error(`Unknown Windows process broker command: ${id}`))
      return
    }
    if (type === frameType.spawned && payload.length === 4) {
      process.spawned(payload.readUInt32LE(0))
      return
    }
    if (type === frameType.stdinAck && payload.length === 4) {
      process.stdinAcknowledged(payload.readUInt32LE(0))
      return
    }
    if (type === frameType.stdout || type === frameType.stderr) {
      if (!process.output(type, Buffer.from(payload))) this.socket.destroy(new Error("Windows process broker exceeded output credit"))
      return
    }
    if (type === frameType.exit && payload.length === 4) {
      process.exited(payload.readUInt32LE(0))
      return
    }
    if (type === frameType.close) {
      this.commands.delete(id)
      process.complete()
      if (this.commands.size === 0) this.socket.unref()
      return
    }
    if (type === frameType.error) {
      this.commands.delete(id)
      process.fail(parseError(payload))
      if (this.commands.size === 0) this.socket.unref()
      return
    }
    this.socket.destroy(new Error(`Unexpected Windows process broker frame: ${type}`))
  }

  private disconnect(error: Error) {
    if (this.closed) return
    this.closed = true
    this.helloReject?.(error)
    this.helloResolve = undefined
    this.helloReject = undefined
    for (const process of this.commands.values()) process.fail(error)
    this.commands.clear()
  }

}

let active: Promise<Client> | undefined
let gitCache: { key: string; executable: string | undefined } | undefined

export const available = () => process.platform === "win32" && resolveExecutable() !== undefined

export const resolve = (command: string, env: NodeJS.ProcessEnv) => {
  if (process.platform !== "win32") return undefined
  const name = path.basename(command).toLowerCase()
  if (name === "git" || name === "git.exe") return resolveGit(command, env)
  return path.isAbsolute(command) && name === "rg.exe" ? command : undefined
}

export const prewarm = () => {
  if (!available()) return Promise.resolve(false)
  return client().then(
    () => true,
    () => false,
  )
}

export const launch = (executable: string, args: readonly string[], options: SpawnOptions) => {
  const process = new ManagedProcess(options.stdin)
  void client()
    .then((value) => value.spawn(process, executable, args, options))
    .catch((error) => process.fail(error instanceof Error ? error : new Error(String(error))))
  return process
}

const client = (): Promise<Client> => {
  if (active) {
    return active.then((value) => {
      if (!value.closed) return value
      active = undefined
      return client()
    })
  }
  active = start().catch((error) => {
    active = undefined
    throw error
  })
  return active
}

const start = async () => {
  const executable = resolveExecutable()
  if (!executable) throw new Error("Windows process broker executable was not found")
  const pipe = `\\\\.\\pipe\\opencode-process-${process.pid}-${randomBytes(16).toString("hex")}`
  const args = ["--pipe", pipe, "--parent-pid", String(process.pid)]
  const broker = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  broker.unref()
  const unavailable = new Promise<never>((_, reject) => {
    broker.once("error", reject)
    broker.once("exit", (code) => reject(new Error(`Windows process broker exited during startup (${code ?? "unknown"})`)))
  })
  let socket: Socket
  try {
    socket = await Promise.race([connectPipe(pipe, Date.now() + 5_000), unavailable])
  } catch (error) {
    broker.kill()
    throw error
  }
  const value = new Client(socket)
  await value.ready
  socket.unref()
  return value
}

const connectPipe = (pipe: string, deadline: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(pipe)
    const onConnect = () => {
      socket.off("error", onError)
      resolve(socket)
    }
    const onError = (error: NodeJS.ErrnoException) => {
      socket.off("connect", onConnect)
      socket.destroy()
      if (Date.now() >= deadline) {
        reject(error)
        return
      }
      setTimeout(() => connectPipe(pipe, deadline).then(resolve, reject), 10)
    }
    socket.once("connect", onConnect)
    socket.once("error", onError)
  })

const resolveExecutable = () => {
  const configured = process.env.OPENCODE_PROCESS_BROKER_PATH?.trim()
  const candidates = [
    configured,
    path.join(path.dirname(process.execPath), "OpenCode.ProcessBroker.exe"),
    path.resolve(import.meta.dirname, "../../opencode/src/windows-process-broker/bin/OpenCode.ProcessBroker.exe"),
  ]
  return candidates.find((candidate): candidate is string => Boolean(candidate && isFile(candidate)))
}

const resolveGit = (command: string, env: NodeJS.ProcessEnv) => {
  const key = `${command}\0${env.GIT_BINARY ?? ""}\0${env.PATH ?? env.Path ?? ""}\0${process.arch}`
  if (gitCache?.key === key) return gitCache.executable
  const explicit = env.GIT_BINARY?.trim()
  const names = explicit
    ? [explicit]
    : path.isAbsolute(command)
      ? [command]
      : (env.PATH ?? env.Path ?? "")
          .split(";")
          .map((directory) => directory.trim().replace(/^"|"$/g, ""))
          .filter(Boolean)
          .map((directory) => path.join(directory, "git.exe"))
  const executable = names.map(resolveGitRuntime).find((candidate) => candidate !== undefined)
  gitCache = { key, executable }
  return executable
}

const resolveGitRuntime = (candidate: string) => {
  if (!isFile(candidate)) return undefined
  const directory = path.dirname(candidate)
  const name = path.basename(directory).toLowerCase()
  const runtimeDirectories = ["clangarm64", "mingw32", "mingw64", "ucrt64"]
  if (name === "bin" && runtimeDirectories.includes(path.basename(path.dirname(directory)).toLowerCase())) return candidate
  if (name !== "cmd" && name !== "bin") return candidate
  const architectures = process.arch === "arm64"
    ? ["clangarm64", "mingw64", "ucrt64", "mingw32"]
    : process.arch === "ia32"
      ? ["mingw32", "mingw64", "ucrt64", "clangarm64"]
      : ["mingw64", "ucrt64", "clangarm64", "mingw32"]
  return architectures
    .map((architecture) => path.join(path.dirname(directory), architecture, "bin", "git.exe"))
    .find(isFile)
}

const isFile = (candidate: string) => {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

const u32 = (value: number) => {
  const output = Buffer.allocUnsafe(4)
  output.writeUInt32LE(value)
  return output
}

const string = (value: string) => {
  if (value.includes("\0")) throw new Error("Windows process arguments cannot contain NUL")
  const bytes = Buffer.from(value)
  return Buffer.concat([u32(bytes.length), bytes])
}

const parseError = (payload: Buffer<ArrayBufferLike>) => {
  if (payload.length < 12) return new Error("Windows process broker failed")
  const code = payload.readUInt32LE(0)
  const stageSize = payload.readUInt32LE(4)
  if (8 + stageSize + 4 > payload.length) return new Error("Windows process broker failed")
  const stage = payload.toString("utf8", 8, 8 + stageSize)
  const messageSizeOffset = 8 + stageSize
  const messageSize = payload.readUInt32LE(messageSizeOffset)
  const messageOffset = messageSizeOffset + 4
  if (messageOffset + messageSize !== payload.length) return new Error("Windows process broker failed")
  return Object.assign(new Error(`${stage}: ${payload.toString("utf8", messageOffset)} (${code})`), { code, stage })
}

export * as WindowsProcessBroker from "./windows-process-broker"
