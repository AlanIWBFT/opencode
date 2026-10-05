import { Location } from "@opencode/schema/location"
import { Schema, SchemaGetter } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { InvalidRequestError, UnknownError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"
import { ConflictError } from "../errors.js"

export const DebugGroup = HttpApiGroup.make("server.debug")
  .add(
    HttpApiEndpoint.post("debug.heapDump", "/api/debug/heap-dump", {
      query: Schema.Struct({
        directory: Schema.String.pipe(
          Schema.optional,
          Schema.annotate({
            description:
              "Absolute server-local directory to write the snapshot into, created when missing. Defaults to the server's log directory.",
          }),
        ),
      }),
      success: Schema.Struct({
        path: Schema.String,
        pid: Schema.Int,
        memory: Schema.Struct({
          rss: Schema.Number,
          heapTotal: Schema.Number,
          heapUsed: Schema.Number,
          external: Schema.Number,
          arrayBuffers: Schema.Number,
        }).annotate({
          description:
            "The server process's memory in bytes, read just before the snapshot (Node's process.memoryUsage()). rss covers native memory the snapshot cannot show.",
        }),
      }),
      error: [InvalidRequestError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "debug.heapDump",
        summary: "Write a heap snapshot",
        description:
          "Write a JavaScript heap snapshot of the server process into its log directory, or the requested directory, and return the server-local path once the file is complete. Pauses the server while the heap serializes and can temporarily increase its memory use. The snapshot can contain credentials, prompts, and file contents.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("debug.location", "/api/debug/location", {
      success: Schema.Array(Location.PublicRef),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "debug.location.list",
        summary: "List loaded locations",
        description: "List locations currently loaded by the server.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("debug.location.evict", "/api/debug/location", {
      query: Schema.Struct({
        ...LocationQuery.fields,
        preserveExec: Schema.Literals(["true", "false"]).pipe(
          Schema.decodeTo(Schema.Boolean, {
            decode: SchemaGetter.transform((value) => value === "true"),
            encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
          }),
          Schema.optional,
        ),
      }),
      success: HttpApiSchema.NoContent,
      error: ConflictError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "debug.location.evict",
          summary: "Evict a loaded location",
          description:
            "Dispose the requested location's cached services so its next use boots them fresh. With preserveExec, live or starting persistent command slots prevent disposal (409).",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "debug" }))
