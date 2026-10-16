export * as ExecPipe from "./pipe.js"

import { createServer, type Socket } from "node:net"

/** One control connection per Windows PowerShell generation; stdin belongs only to user programs. */
export async function open(name: string, bootstrap: string, onDisconnect: () => void) {
  let socket: Socket | undefined
  let closed = false
  let pending:
    | { id: number; resolve: (cwd: string | undefined) => void; result: Promise<string | undefined>; received: boolean }
    | undefined
  const close = () => {
    if (closed) return
    closed = true
    pending?.resolve(undefined)
    socket?.destroy()
    server.close()
  }
  const disconnect = () => {
    if (closed) return
    close()
    onDisconnect()
  }
  const server = createServer((connection) => {
    if (socket || closed) {
      connection.destroy()
      return
    }
    socket = connection
    // No later connection may attach to this generation, including during shutdown.
    server.close()
    let buffered = Buffer.alloc(0)
    connection.on("error", disconnect)
    connection.on("close", disconnect)
    connection.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0)
        // Completion payloads contain only an exec ID and a Windows path.
        if (length < 4 || length > 1024 * 1024) return disconnect()
        if (buffered.length < length + 4) return
        const frame = buffered.subarray(4, length + 4)
        buffered = buffered.subarray(length + 4)
        if (!pending || pending.received || frame.readUInt32LE(0) !== pending.id) return disconnect()
        pending.received = true
        pending.resolve(frame.subarray(4).toString("utf8"))
      }
    })
    connection.write(encode(bootstrap), (error) => {
      if (error) disconnect()
    })
  })
  server.on("error", disconnect)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(`\\\\.\\pipe\\${name}`, () => {
      server.off("error", reject)
      resolve()
    })
  })
  return {
    close,
    async request(id: number, source: string) {
      if (closed || !socket || (pending && !pending.received)) return false
      const completion = Promise.withResolvers<string | undefined>()
      pending = { id, resolve: completion.resolve, result: completion.promise, received: false }
      const frame = encode(source, id)
      return new Promise<boolean>((resolve) => {
        socket!.write(frame, (error) => {
          if (error) disconnect()
          resolve(!error && !closed)
        })
      })
    },
    completion(id: number) {
      return pending?.id === id ? pending.result : Promise.resolve(undefined)
    },
  }
}

export type Channel = Awaited<ReturnType<typeof open>>

function encode(source: string, id?: number) {
  const text = Buffer.from(source, "utf8")
  const header = Buffer.alloc(id === undefined ? 4 : 8)
  header.writeUInt32LE(text.length + (id === undefined ? 0 : 4), 0)
  if (id !== undefined) header.writeUInt32LE(id, 4)
  return Buffer.concat([header, text])
}
