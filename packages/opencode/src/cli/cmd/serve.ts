import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

const SHUTDOWN_PROTOCOL_ENV = "OPENCHAMBER_SHUTDOWN_PROTOCOL"
const SHUTDOWN_PROTOCOL_MESSAGE = JSON.stringify({ version: 1, type: "shutdown" })

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  disposeRuntime: true,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    yield* waitForShutdownProtocol().pipe(Effect.ensuring(Effect.promise(() => server.stop(true))))
  }),
})

function waitForShutdownProtocol() {
  if (process.env[SHUTDOWN_PROTOCOL_ENV] !== "1") return Effect.never
  return Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        let buffer = ""
        const cleanup = () => {
          process.stdin.off("data", onData)
          process.stdin.off("end", finish)
          process.stdin.off("error", finish)
        }
        const finish = () => {
          cleanup()
          resolve()
        }
        const onData = (chunk: Buffer) => {
          buffer = `${buffer}${chunk.toString()}`.slice(-256)
          if (buffer.includes(SHUTDOWN_PROTOCOL_MESSAGE)) finish()
        }
        process.stdin.on("data", onData)
        process.stdin.on("end", finish)
        process.stdin.on("error", finish)
        process.stdin.resume()
        if (process.stdin.readableEnded || process.stdin.destroyed) finish()
      }),
  )
}
