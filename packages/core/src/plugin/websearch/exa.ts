export * as WebSearchExa from "./exa.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema, Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { WebSearchMcp } from "./mcp.js"
import { WebSearch } from "@opencode/schema/websearch"

export const endpoint = "https://mcp.exa.ai/mcp"

const McpInput = Schema.Struct({
  query: Schema.String,
  numResults: Schema.Number,
  includeDomains: Schema.optionalKey(Schema.Array(Schema.String)),
  excludeDomains: Schema.optionalKey(Schema.Array(Schema.String)),
  enableHighlights: Schema.Boolean,
  highlightsQuery: Schema.String,
  highlightsMaxCharacters: Schema.Number,
  textMaxCharacters: Schema.Number,
})

const McpOutput = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  content: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("text"),
      text: Schema.String,
      _meta: Schema.Struct({ searchTime: Schema.Number }).pipe(Schema.optional),
    }),
  ),
})

const SearchResponse = Schema.fromJsonString(
  Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        url: Schema.String,
        title: Schema.optionalKey(Schema.String),
        publishedDate: Schema.optionalKey(Schema.String),
        text: Schema.optionalKey(Schema.String),
        highlights: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
  }),
)

export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  id: "opencode.websearch.exa",
  effect: Effect.fn("WebSearchExa.Plugin")(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    yield* ctx.integration.transform((editor) => {
      editor.update("exa", (integration) => (integration.name = "Exa"))
      editor.method.update({
        integrationID: "exa",
        method: { type: "key" },
      })
      editor.method.update({
        integrationID: "exa",
        method: { type: "env", names: ["EXA_API_KEY"] },
      })
    })
    yield* ctx.websearch.transform((editor) => {
      editor.add({
        id: "exa",
        name: "Exa",
        options: ["numResults", "includeDomains", "excludeDomains", "highlightsQuery", "maxCharacters"],
        execute: (input) =>
          Effect.gen(function* () {
            const connection = yield* ctx.integration.connection.active("exa")
            const credential = connection ? yield* ctx.integration.connection.resolve(connection) : undefined
            const url = new URL(endpoint)
            url.searchParams.set("tools", "web_search_advanced_exa")
            const result = yield* WebSearchMcp.call(
              http,
              url.toString(),
              "web_search_advanced_exa",
              { input: McpInput, output: McpOutput },
              {
                query: input.query,
                numResults: input.numResults ?? 8,
                ...(input.includeDomains !== undefined && { includeDomains: input.includeDomains }),
                ...(input.excludeDomains !== undefined && { excludeDomains: input.excludeDomains }),
                enableHighlights: true,
                highlightsQuery: input.highlightsQuery ?? input.query,
                highlightsMaxCharacters: input.maxCharacters ?? 1800,
                textMaxCharacters: input.maxCharacters ?? 1800,
              },
              credential?.type === "key" ? { "x-api-key": credential.key } : {},
              // Twenty results can contain both 8000-character text and highlights,
              // plus JSON escaping and multibyte text. Model excerpts remain bounded below.
              2 * 1024 * 1024,
            )
            const content = result?.content.find((item) => item.text)
            if (result?.isError || !content)
              return yield* Effect.fail(new Error(content?.text ?? "Exa returned no search payload"))
            const response = yield* Schema.decodeUnknownEffect(SearchResponse)(content.text)
            return response.results.map((item): WebSearch.Result => {
              const highlights = item.highlights?.filter(Boolean).join("\n\n")
              const published = item.publishedDate ? Date.parse(item.publishedDate) : undefined
              const excerpt = highlights || item.text || ""
              // Enforce the model-facing budget even if the remote service exceeds its requested limit.
              const content = Array.from(excerpt)
                .slice(0, input.maxCharacters ?? 1800)
                .join("")
              return {
                url: item.url,
                ...(item.title && { title: item.title }),
                ...(content && { content, contentKind: highlights ? "highlights" : "text-preview" }),
                time: { ...(published !== undefined && Number.isFinite(published) ? { published } : {}) },
              }
            })
          }),
      })
    })
  }),
})
