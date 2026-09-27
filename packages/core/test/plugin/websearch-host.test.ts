import { expect } from "bun:test"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { WebSearch } from "@opencode/core/websearch"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const search = {
  query: "file name lookup",
  numResults: 3,
  includeDomains: ["example.com/docs"],
  excludeDomains: ["example.com/old"],
  highlightsQuery: "lookup by file ID",
  maxCharacters: 800,
}

const setup = Effect.gen(function* () {
  const plugins = yield* Plugin.Service
  const websearch = yield* WebSearch.Service
  const calls: WebSearch.ProviderInput[] = []
  const providerID = WebSearch.ID.make("host-search-test")
  yield* websearch.transform((editor) => {
    editor.add({
      id: providerID,
      name: "Host search test",
      options: ["numResults", "includeDomains", "excludeDomains", "highlightsQuery", "maxCharacters"],
      execute: (input) =>
        Effect.sync(() => {
          calls.push(input)
          return [{ url: "https://example.com/docs", content: "Evidence", time: {} }]
        }),
    })
    editor.default.set(providerID)
  })
  return { host: yield* PluginHost.make(plugins), providerID, calls }
})

it.effect("Effect host strips location while forwarding every search option", () =>
  Effect.gen(function* () {
    const fixture = yield* setup
    const result = yield* fixture.host.websearch.query({
      ...search,
      providerID: fixture.providerID,
      location: { directory: fixture.host.location.directory },
    })
    expect(fixture.calls).toEqual([search])
    expect(result.data.providerID).toBe(fixture.providerID)
    expect(result.data.results[0]?.content).toBe("Evidence")
    expect(result.location.directory).toBe(fixture.host.location.directory)

    yield* fixture.host.websearch.query({ query: "plain search" })
    expect(fixture.calls[1]).toEqual({ query: "plain search" })
  }),
)

it.effect("Promise host accepts location and preserves search controls through endpoint decoding", () =>
  Effect.gen(function* () {
    const fixture = yield* setup
    yield* PluginPromise.fromPromise({
      id: "search-host-regression",
      async setup(context) {
        const result = await context.websearch.query({
          ...search,
          providerID: fixture.providerID,
          location: { directory: context.location.directory },
        })
        expect(result.data.providerID).toBe(fixture.providerID)
        expect(result.data.results[0]?.content).toBe("Evidence")
      },
    }).effect(fixture.host)
    expect(fixture.calls).toEqual([search])
  }),
)
