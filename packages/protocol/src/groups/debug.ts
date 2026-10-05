import { Location } from "@opencode/schema/location"
import { Schema, SchemaGetter } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"
import { ConflictError } from "../errors.js"

export const DebugGroup = HttpApiGroup.make("server.debug")
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
