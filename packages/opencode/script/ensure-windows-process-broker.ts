import { $ } from "bun"
import { copyFile, mkdir } from "node:fs/promises"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")

export const windowsProcessBrokerSource = path.join(root, "src", "windows-process-broker", "process-broker.cs")
export const windowsProcessBroker = path.join(root, "src", "windows-process-broker", "bin", "OpenCode.ProcessBroker.exe")
const publishDirectory = path.join(path.dirname(windowsProcessBroker), "publish")
const publishedProcessBroker = path.join(publishDirectory, "OpenCode.ProcessBroker.exe")

export async function buildWindowsProcessBroker() {
  if (process.env.OPENCODE_WINDOWS_PROCESS_BROKER_PREBUILT !== "1") {
    await mkdir(publishDirectory, { recursive: true })
    const result = await $`dotnet publish ${windowsProcessBrokerSource} --runtime win-x64 --self-contained true --configuration Release --output ${publishDirectory} -p:PublishAot=true`.quiet().nothrow()
    if (result.exitCode !== 0) {
      if (result.stdout.length > 0) process.stderr.write(result.stdout)
      if (result.stderr.length > 0) process.stderr.write(result.stderr)
      throw new Error("Failed to build the Windows process broker")
    }
    await copyFile(publishedProcessBroker, windowsProcessBroker)
  }
  const protocol = await $`${windowsProcessBroker} --protocol-version`.quiet().text()
  if (protocol.trim() !== "2") throw new Error(`Unexpected Windows process broker protocol version: ${protocol.trim() || "(empty)"}`)
  const runtime = await $`${windowsProcessBroker} --runtime-kind`.quiet().text()
  if (runtime.trim() !== "nativeaot") throw new Error(`Windows process broker is not NativeAOT: ${runtime.trim() || "(empty)"}`)
}

if (import.meta.main && process.platform === "win32") {
  await buildWindowsProcessBroker()
}
