export * as SessionError from "./session-error.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export interface Resolution extends Schema.Schema.Type<typeof Resolution> {}
export const Resolution = Schema.Struct({
  kind: Schema.Literals(["rate_limited", "usage_limited", "plan_not_included", "quota_exceeded", "policy_blocked", "authentication", "invalid_input", "network", "server"]),
  retry: Schema.Literals(["automatic", "never"]),
  action: Schema.Literals(["switch_model", "wait", "manage_billing", "reauthenticate", "fix_input", "check_network", "retry"]),
  retryAfterMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(optional),
  providerCode: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Error.Resolution" })

export interface Error extends Schema.Schema.Type<typeof Error> {}
export const Error = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })).pipe(optional),
  response: Schema.Struct({ body: Schema.String }).pipe(optional),
  resolution: Resolution.pipe(optional),
  /** Legacy local records; new errors use response.body. */
  responseBody: Schema.String.pipe(optional),
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(optional),
  url: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.StructuredError" })
