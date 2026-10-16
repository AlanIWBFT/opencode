import { expect, test } from "bun:test"
import { createConnection } from "node:net"
import { ExecPipe } from "@opencode/core/tool/exec-session/pipe"

const windowsTest = process.platform === "win32" ? test : test.skip

windowsTest("exec control pipe reassembles fragmented Unicode status and releases waiters on disconnect", async () => {
  const name = `opencode-test-${crypto.randomUUID()}`
  const disconnected = Promise.withResolvers<void>()
  const channel = await ExecPipe.open(name, "bootstrap", disconnected.resolve)
  const client = createConnection(`\\\\.\\pipe\\${name}`)
  client.on("error", () => {})
  // Reading the bootstrap proves the server has accepted the connection before the first request.
  await new Promise<void>((resolve) => client.once("data", () => resolve()))
  try {
    expect(await channel.request(71, "Write-Output 'hello' ")).toBe(true)
    const cwd = Buffer.from("C:\\目录\\😀", "utf8")
    const frame = Buffer.alloc(8 + cwd.length)
    frame.writeUInt32LE(4 + cwd.length)
    frame.writeUInt32LE(71, 4)
    cwd.copy(frame, 8)
    for (const byte of frame) {
      await new Promise<void>((resolve, reject) =>
        client.write(Buffer.from([byte]), (error) => (error ? reject(error) : resolve())),
      )
    }
    expect(await channel.completion(71)).toBe("C:\\目录\\😀")
    expect(await channel.request(72, "Start-Sleep 60")).toBe(true)
    client.destroy()
    await disconnected.promise
    expect(await channel.completion(72)).toBeUndefined()
    expect(await channel.request(73, "must not run")).toBe(false)
  } finally {
    client.destroy()
    channel.close()
  }
})

windowsTest("exec control pipe rejects a completion from another execution", async () => {
  const name = `opencode-test-${crypto.randomUUID()}`
  const disconnected = Promise.withResolvers<void>()
  const channel = await ExecPipe.open(name, "bootstrap", disconnected.resolve)
  const client = createConnection(`\\\\.\\pipe\\${name}`)
  client.on("error", () => {})
  await new Promise<void>((resolve) => client.once("data", () => resolve()))
  try {
    expect(await channel.request(41, "command")).toBe(true)
    const frame = Buffer.alloc(8)
    frame.writeUInt32LE(4)
    frame.writeUInt32LE(42, 4)
    client.write(frame)
    await disconnected.promise
    expect(await channel.completion(41)).toBeUndefined()
  } finally {
    client.destroy()
    channel.close()
  }
})
