export * as ProviderRecovery from "./provider-recovery.js"

import { AIError, isRetryable } from "@opencode/ai"
import type { SessionError } from "@opencode/schema/session-error"

export function resolution(reason: AIError["reason"]): SessionError.Resolution | undefined {
  const retry = isRetryable(new AIError({ reason })) ? "automatic" : "never"
  const common = { retry, ...(reason.providerCode === undefined ? {} : { providerCode: reason.providerCode }) } as const
  switch (reason._tag) {
    case "RateLimit":
    case "ProviderInternal": {
      const retryAfterMs = reason.retryAfterMs
      const delay = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? { retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) } : {}
      return reason._tag === "RateLimit"
        ? { ...common, ...delay, kind: "rate_limited", action: "wait" }
        : { ...common, ...delay, kind: "server", action: "retry" }
    }
    case "QuotaExceeded":
      if (reason.providerCode === "usage_limit_reached") return { ...common, kind: "usage_limited", action: "switch_model" }
      if (reason.providerCode === "usage_not_included") return { ...common, kind: "plan_not_included", action: "switch_model" }
      return { ...common, kind: "quota_exceeded", action: "manage_billing" }
    case "Authentication":
      return { ...common, kind: "authentication", action: "reauthenticate" }
    case "ContentPolicy":
      return { ...common, kind: "policy_blocked", action: "fix_input" }
    case "InvalidRequest":
      return { ...common, kind: "invalid_input", action: "fix_input" }
    case "Transport":
      return { ...common, kind: "network", action: "check_network" }
    default:
      return undefined
  }
}
