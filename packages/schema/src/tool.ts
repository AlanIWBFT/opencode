export * as Tool from "./tool.js"

import { Effect, JsonSchema, Schema } from "effect"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Agent } from "./agent.js"
import type { Session } from "./session.js"
import type { SessionMessage } from "./session-message.js"

export type Metadata = Readonly<Record<string, any>>

export const CallID = Schema.String.pipe(Schema.brand("Tool.CallID"))
export type CallID = typeof CallID.Type

export interface Context {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly messageID: SessionMessage.ID
  readonly id: CallID
  /** A host-managed child within the parent model call identified by `id`. */
  readonly childID?: string
  /** Register cleanup for work created by this invocation if its enclosing script fails. */
  readonly registerCleanup?: (cleanup: Effect.Effect<unknown>) => void
  readonly progress: (update: Metadata) => Effect.Effect<void>
}

export interface Namespace {
  readonly name: string
  readonly description: string
}

interface BaseOptions {
  readonly namespace?: string
  readonly permission?: string
}

export interface CodeModeOptions {
  /** Script-only namespace; the direct model tool keeps its normal name. */
  readonly namespace?: string
  readonly concurrency?: {
    readonly group: string
    readonly limit: number
    readonly inputKey?: string
  }
}

export type Options = BaseOptions &
  (
    | {
        readonly codemode?: true | CodeModeOptions
        readonly pinned?: boolean
      }
    | {
        readonly codemode: boolean
        readonly pinned?: never
      }
  )

export type ValueSchema<A = unknown> = Schema.Codec<A, any> | StandardSchemaV1<any, A> | JsonSchema.JsonSchema

type InputValue<S> = 0 extends 1 & S
  ? any
  : S extends Schema.Codec<infer A, any>
    ? A
    : S extends StandardSchemaV1<any, infer A>
      ? A
      : unknown
type OutputValue<S> = S extends undefined
  ? never
  : S extends Schema.Codec<infer A, any>
    ? A
    : S extends StandardSchemaV1<infer A, any>
      ? A
      : any

export class Error extends Schema.TaggedError<Error>()("Tool.Error", {
  message: Schema.String,
  error: Schema.optional(Schema.Defect()),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export interface TextContent extends Schema.Schema.Type<typeof TextContent> {}
export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
}).annotate({ identifier: "Tool.TextContent" })

export interface FileContent extends Schema.Schema.Type<typeof FileContent> {}
export const FileContent = Schema.Struct({
  type: Schema.Literal("file"),
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.optional(Schema.String),
}).annotate({ identifier: "Tool.FileContent" })

export const Content = Schema.Union([TextContent, FileContent])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Tool.Content" })
export type Content = Schema.Schema.Type<typeof Content>

export const ChildCall = Schema.Struct({
  id: Schema.String.pipe(Schema.optionalKey),
  tool: Schema.String,
  name: Schema.String.pipe(Schema.optionalKey),
  title: Schema.String.pipe(Schema.optionalKey),
  status: Schema.Literals(["running", "completed", "error"]),
  input: Schema.Record(Schema.String, Schema.Json).pipe(Schema.optionalKey),
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(Schema.optionalKey),
  content: Schema.Array(Content).pipe(Schema.optionalKey),
  error: Schema.String.pipe(Schema.optionalKey),
  time: Schema.Struct({
    start: Schema.Number,
    end: Schema.Number.pipe(Schema.optionalKey),
  }).pipe(Schema.optionalKey),
}).annotate({ identifier: "Tool.ChildCall" })
export type ChildCall = typeof ChildCall.Type

export interface Result<Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined> {
  readonly output?: OutputValue<Output>
  readonly content?: string | ReadonlyArray<Content>
  readonly metadata?: Metadata
}

export type Info<
  Input extends ValueSchema<any> = ValueSchema<any>,
  Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined,
> = {
  readonly name: string
  readonly input: Input
  readonly description: string
  readonly execute: (input: InputValue<Input>, context: Context) => Effect.Effect<Result<Output>, Error>
  readonly output?: Output
  readonly options?: Options
}
