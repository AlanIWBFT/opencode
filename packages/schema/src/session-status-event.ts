export * as SessionStatusEvent from "./session-status-event"

import { Schema, SchemaGetter } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"

const APIErrorResolutionFields = {
  retry: Schema.Literals(["automatic", "never"]),
  action: Schema.Literals([
    "switch_model",
    "wait",
    "manage_billing",
    "reauthenticate",
    "fix_input",
    "check_network",
    "retry",
  ]),
  retryAfterMs: optional(NonNegativeInt),
  providerCode: optional(Schema.String),
}

const CurrentAPIErrorResolution = Schema.Struct({
  kind: Schema.Literals([
    "rate_limited",
    "usage_limited",
    "plan_not_included",
    "quota_exceeded",
    "policy_blocked",
    "authentication",
    "invalid_input",
    "network",
    "server",
  ]),
  ...APIErrorResolutionFields,
})

const LegacyAPIErrorResolution = Schema.Struct({
  kind: Schema.Literal("model_capacity"),
  ...APIErrorResolutionFields,
})

export const APIErrorResolution = Schema.Union([CurrentAPIErrorResolution, LegacyAPIErrorResolution]).pipe(
  Schema.decodeTo(CurrentAPIErrorResolution, {
    decode: SchemaGetter.transform((value) =>
      value.kind === "model_capacity"
        ? { ...value, kind: "server" as const, retry: "automatic" as const, action: "retry" as const }
        : value,
    ),
    encode: SchemaGetter.transform((value) => value),
  }),
).annotate({ identifier: "APIErrorResolution" })
export interface APIErrorResolution extends Schema.Schema.Type<typeof APIErrorResolution> {}

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: optional(Schema.String),
      }),
    ),
    resolution: optional(APIErrorResolution),
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Status = Event.define({
  type: "session.status",
  schema: {
    sessionID: SessionID,
    status: Info,
  },
})

// deprecated
export const Idle = Event.define({
  type: "session.idle",
  schema: {
    sessionID: SessionID,
  },
})

export const Definitions = Event.inventory(Status, Idle)
