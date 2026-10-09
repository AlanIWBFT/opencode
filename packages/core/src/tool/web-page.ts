export * as WebPage from "./web-page.js"

import path from "path"
import { Clock, Duration, Effect, Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { ToolOutput } from "../tool-output.js"

export const Ref = Schema.String.check(Schema.isPattern(/^tool_[0-9a-f]{12}[A-Za-z0-9]{14}$/))
export const Format = Schema.Literals(["text", "markdown", "html"])
export const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12000 }))
const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  url: Schema.String,
  contentType: Schema.String,
  format: Format,
  fetchedAt: Schema.Number,
  text: Schema.String,
})
export type Snapshot = typeof Snapshot.Type
export const Page = Schema.Struct({
  ref: Ref,
  url: Schema.String,
  contentType: Schema.String,
  format: Format,
  fetchedAt: Schema.Number,
  totalCharacters: Schema.Number,
  offset: Schema.Number,
  end: Schema.Number,
  output: Schema.String,
  nextOffset: Schema.optionalKey(Schema.Number),
})
export const Match = Schema.Struct({
  offset: Schema.Number,
  end: Schema.Number,
  output: Schema.String,
  matchOffset: Schema.Number,
  matchOffsets: Schema.Array(Schema.Number),
})
export const Found = Schema.Struct({
  ref: Ref,
  url: Schema.String,
  fetchedAt: Schema.Number,
  pattern: Schema.String,
  matches: Schema.Array(Match),
  nextOffset: Schema.optionalKey(Schema.Number),
})

// Files share ToolOutput's seven-day retention, but are written on every open,
// not only when a model preview overflows. A ref always addresses one immutable extraction.
export const make = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const directory = path.join(global.data, ToolOutput.DIRECTORY)
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot))
  return {
    save: Effect.fn("WebPage.save")(function* (input: Omit<Snapshot, "version" | "fetchedAt">) {
      const ref = ToolOutput.fileName()
      const snapshot = { ...input, version: 1 as const, fetchedAt: yield* Clock.currentTimeMillis }
      yield* fs.ensureDir(directory)
      yield* fs.writeFileString(path.join(directory, `${ref}.web.json`), JSON.stringify(snapshot))
      return { ref, snapshot }
    }),
    load: Effect.fn("WebPage.load")(function* (ref: string) {
      // Validate again at the storage boundary; a ref must never become an arbitrary path.
      yield* Schema.decodeUnknownEffect(Ref)(ref)
      const snapshot = yield* fs.readFileString(path.join(directory, `${ref}.web.json`)).pipe(
        Effect.flatMap(decode),
        Effect.mapError(
          () => new Error("Web snapshot is unavailable. Open its original URL again to obtain a new ref."),
        ),
      )
      if ((yield* Clock.currentTimeMillis) - snapshot.fetchedAt >= Duration.toMillis(ToolOutput.RETENTION))
        return yield* Effect.fail(new Error("Web snapshot has expired after 7 days. Open its original URL again."))
      return snapshot
    }),
  }
})

// Offsets are UTF-16 positions in the captured text. Never split a surrogate pair.
function boundary(text: string, offset: number) {
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(offset)) && /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)))
    return offset - 1
  return offset
}

export function read(ref: string, snapshot: Snapshot, offset = 0, limit = 6000): typeof Page.Type {
  if (offset > snapshot.text.length) throw new Error(`Offset ${offset} exceeds snapshot length ${snapshot.text.length}`)
  const start = boundary(snapshot.text, offset)
  const boundaryEnd = boundary(snapshot.text, Math.min(snapshot.text.length, start + limit))
  const end = boundaryEnd === start && start < snapshot.text.length ? start + 2 : boundaryEnd
  return {
    ref,
    url: snapshot.url,
    contentType: snapshot.contentType,
    format: snapshot.format,
    fetchedAt: snapshot.fetchedAt,
    totalCharacters: snapshot.text.length,
    offset: start,
    end,
    output: snapshot.text.slice(start, end),
    ...(end < snapshot.text.length && { nextOffset: end }),
  }
}

export function find(
  ref: string,
  snapshot: Snapshot,
  pattern: string,
  offset = 0,
  caseSensitive = false,
  context = 400,
): typeof Found.Type {
  if (offset > snapshot.text.length) throw new Error(`Offset ${offset} exceeds snapshot length ${snapshot.text.length}`)
  const expression = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu")
  expression.lastIndex = boundary(snapshot.text, offset)
  const matches: Array<typeof Match.Type> = []
  let characters = 0
  let count = 0
  let nextOffset: number | undefined
  for (let match = expression.exec(snapshot.text); match; match = expression.exec(snapshot.text)) {
    const start = boundary(snapshot.text, Math.max(0, match.index - context))
    const end = boundary(snapshot.text, Math.min(snapshot.text.length, match.index + match[0].length + context))
    const previous = matches.at(-1)
    const overlaps = previous !== undefined && start < previous.end
    const added = overlaps ? Math.max(0, end - previous.end) : end - start
    if (count === 100 || (!overlaps && matches.length === 10) || characters + added > 10000) {
      nextOffset = match.index
      break
    }
    if (overlaps) {
      const mergedEnd = Math.max(previous.end, end)
      matches[matches.length - 1] = {
        ...previous,
        end: mergedEnd,
        matchOffsets: [...previous.matchOffsets, match.index],
        output: snapshot.text.slice(previous.offset, mergedEnd),
      }
    } else {
      matches.push({
        offset: start,
        end,
        matchOffset: match.index,
        matchOffsets: [match.index],
        output: snapshot.text.slice(start, end),
      })
    }
    characters += added
    count++
  }
  return {
    ref,
    url: snapshot.url,
    fetchedAt: snapshot.fetchedAt,
    pattern,
    matches,
    ...(nextOffset !== undefined && { nextOffset }),
  }
}

export function renderPage(page: typeof Page.Type) {
  return `URL: ${page.url}\nSnapshot: ${page.ref}\nFetched: ${new Date(page.fetchedAt).toISOString()}\nContent: ${page.format} extracted from HTTP (no JavaScript rendering)\nCharacters: ${page.offset}-${page.end} of ${page.totalCharacters} (end exclusive; UTF-16 offsets)\n${page.nextOffset !== undefined ? `Continue: webfetch action=read ref=${page.ref} offset=${page.nextOffset}` : "End of captured text."}\n\n${page.output}`
}

export function renderFound(found: typeof Found.Type) {
  const matches = found.matches
    .map(
      (match) => `Matches at ${match.matchOffsets.join(", ")}; context ${match.offset}-${match.end}:\n${match.output}`,
    )
    .join("\n\n")
  return `URL: ${found.url}\nSnapshot: ${found.ref}\nFetched: ${new Date(found.fetchedAt).toISOString()}\nLiteral search: ${JSON.stringify(found.pattern)}\n${found.matches.length ? matches : "No matches in the captured text from the requested offset."}${found.nextOffset !== undefined ? `\n\nMore matches: webfetch action=find ref=${found.ref} pattern=${JSON.stringify(found.pattern)} offset=${found.nextOffset}` : ""}`
}
