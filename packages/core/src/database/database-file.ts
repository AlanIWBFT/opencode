import { isAbsolute, join } from "path"
import { xdgData } from "xdg-basedir"
import { InstallationChannel } from "../installation/version"

const configured = process.env.OPENCODE_DB

export function resolve() {
  const data = join(xdgData!, "opencode")
  if (configured) {
    if (configured === ":memory:" || isAbsolute(configured)) return configured
    return join(data, configured)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(data, "opencode.db")
  return join(data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export * as DatabaseFile from "./database-file"
