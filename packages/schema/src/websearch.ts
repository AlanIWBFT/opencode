export * as WebSearch from "./websearch.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"

export const ID = Schema.String.pipe(Schema.brand("WebSearch.ID"))
export type ID = typeof ID.Type

export const OptionName = Schema.Literals([
  "numResults",
  "includeDomains",
  "excludeDomains",
  "highlightsQuery",
  "maxCharacters",
]).annotate({ identifier: "WebSearch.OptionName" })
export type OptionName = typeof OptionName.Type
const Domains = Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMaxLength(20))
export interface Options extends Schema.Schema.Type<typeof Options> {}
export const Options = Schema.Struct({
  numResults: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))
    .pipe(optional)
    .annotate({ description: "Number of results (1-20; Exa defaults to 8)." }),
  includeDomains: Domains.pipe(optional).annotate({
    description: "Only search these domains or domain paths. Prefer this to site: in the query.",
  }),
  excludeDomains: Domains.pipe(optional).annotate({ description: "Exclude these domains or domain paths." }),
  highlightsQuery: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
    .pipe(optional)
    .annotate({ description: "What evidence to extract from each page; may differ from the search query." }),
  maxCharacters: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 8000 }))
    .pipe(optional)
    .annotate({ description: "Character budget per result excerpt (200-8000; Exa defaults to 1800)." }),
}).annotate({ identifier: "WebSearch.Options" })

export interface Provider extends Schema.Schema.Type<typeof Provider> {}
export const Provider = Schema.Struct({
  id: ID,
  name: Schema.String,
  options: Schema.Array(OptionName).pipe(optional),
}).annotate({ identifier: "WebSearch.Provider" })

export interface Input extends Schema.Schema.Type<typeof Input> {}
export const Input = Schema.Struct({
  query: Schema.String,
  ...Options.fields,
  providerID: ID.pipe(optional),
}).annotate({ identifier: "WebSearch.Input" })
export type ProviderInput = Omit<Input, "providerID">

export interface Result extends Schema.Schema.Type<typeof Result> {}
export const Result = Schema.Struct({
  url: Schema.String,
  title: Schema.String.pipe(optional),
  content: Schema.String.pipe(optional),
  contentKind: Schema.Literals(["highlights", "text-preview"]).pipe(optional),
  time: Schema.Struct({
    published: Schema.Finite.pipe(optional).annotate({
      description: "Publication time in milliseconds since the Unix epoch",
    }),
  }),
}).annotate({ identifier: "WebSearch.Result" })

export class Response extends Schema.Class<Response>("WebSearch.Response")({
  providerID: ID,
  results: Schema.Array(Result),
}) {}

const Updated = ephemeral({
  type: "websearch.updated",
  schema: {},
})
export const Event = { Updated, Definitions: inventory(Updated) }
