import type { Hooks } from "./registration.js"
import type { SessionID } from "@opencode/schema/session-id"

export interface ShellCreateBefore {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
}

export interface ShellHooks {
  readonly "create.before": ShellCreateBefore
  /** Persistent-command environment overlay. Changes require a new lane generation. */
  readonly "exec.env": {
    readonly cwd: string
    readonly sessionID: SessionID
    readonly callID: string
    env: Record<string, string>
  }
}

export interface ShellDomain {
  readonly hook: Hooks<ShellHooks>
}
