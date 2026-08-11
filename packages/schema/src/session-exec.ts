export * as SessionExec from "./session-exec.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"
import { Tool } from "./tool.js"

export interface Metadata extends Schema.Schema.Type<typeof Metadata> {}
export const Metadata = Schema.Struct({
  command: Schema.String,
  output: Schema.String,
  interactions: Schema.Array(Schema.Struct({ type: Schema.Literals(["stdin", "terminate"]), time: Schema.Number })),
  execID: NonNegativeInt.pipe(optional),
  laneID: NonNegativeInt.pipe(optional),
  shellGeneration: NonNegativeInt.pipe(optional),
  shellReused: Schema.Boolean.pipe(optional),
  cwd: Schema.String.pipe(optional),
  sessionExposed: Schema.Boolean.pipe(optional),
  startedAt: Schema.Number.pipe(optional),
  durationMs: Schema.Number.pipe(optional),
  processRunning: Schema.Boolean,
  exitCode: Schema.Number.pipe(optional),
  outputError: Schema.String.pipe(optional),
  truncated: Schema.Boolean,
  terminationRequested: Schema.Boolean.pipe(optional),
  execDisplay: Schema.Literals(["root", "poll", "stdin", "terminate"]),
  execError: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Exec.Metadata" })

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  sessionID: SessionID,
  assistantMessageID: SessionMessage.ID,
  id: Tool.CallID,
  childID: Schema.String.pipe(optional),
  /** Orders live snapshots only; message order is the official durable creation sequence. */
  revision: NonNegativeInt,
  metadata: Metadata,
}).annotate({ identifier: "Session.Exec.Snapshot" })

/** Parent presentation needed to recover Script children before the model call settles. */
export interface ScriptSnapshot extends Schema.Schema.Type<typeof ScriptSnapshot> {}
export const ScriptSnapshot = Schema.Struct({
  sessionID: SessionID,
  assistantMessageID: SessionMessage.ID,
  id: Tool.CallID,
  revision: NonNegativeInt,
  toolCalls: Schema.Array(Tool.ChildCall),
}).annotate({ identifier: "Session.Script.Snapshot" })
