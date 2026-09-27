export * as WebFetchTool from "./webfetch.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Duration, Effect, Schema } from "effect"
import { HttpClient, type HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import { Permission } from "../../permission.js"
import { convertHTMLToMarkdown, MAX_MARKDOWN_BYTES } from "../html-markdown.js"
import { collectBoundedResponseBody } from "../http-body.js"
import { WebPage } from "../web-page.js"
import { mainHTML, markdownBody } from "../web-content.js"

export const name = "webfetch"
export const MAX_RESPONSE_BYTES = MAX_MARKDOWN_BYTES
export const DEFAULT_TIMEOUT_SECONDS = 30
export const MAX_TIMEOUT_SECONDS = 120

export const description = `Open and inspect web pages. action=open (the default) fetches an HTTP(S) URL as markdown, text, or HTML, saves an immutable snapshot for 7 days, and returns a bounded preview with a ref. Readable formats prefer HTML main/article regions and reduce Markdown frontmatter to source metadata. Use format=html to inspect the unfiltered response. JavaScript is not executed.

Use action=find with ref and a literal pattern to locate evidence and see surrounding context. Use action=read with ref, offset, and limit to expand a passage or continue reading. Read/find use the same captured text without another network request. Offsets are zero-based UTF-16 character positions; follow returned offsets. Search snippets are not complete pages: verify important claims against the captured text. Use a more targeted tool when available.`

const Timeout = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS))

const OpenInput = Schema.Struct({
  action: Schema.optionalKey(Schema.Literal("open")),
  url: Schema.String.annotate({ description: "The HTTP or HTTPS URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({ description: "The format to return the content in. Defaults to markdown." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed("markdown" as const))),
  timeout: Schema.optionalKey(Timeout).annotate({
    description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS})`,
  }),
  offset: Schema.optionalKey(WebPage.Offset).annotate({ description: "Start position in captured text (default 0)." }),
  limit: Schema.optionalKey(WebPage.Limit).annotate({
    description: "Maximum characters to show (default 6000, maximum 12000).",
  }),
})
const ReadInput = Schema.Struct({
  action: Schema.Literal("read"),
  ref: WebPage.Ref,
  offset: Schema.optionalKey(WebPage.Offset),
  limit: Schema.optionalKey(WebPage.Limit),
})
const FindInput = Schema.Struct({
  action: Schema.Literal("find"),
  ref: WebPage.Ref,
  pattern: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Literal text to find, not a regular expression.",
  }),
  offset: Schema.optionalKey(WebPage.Offset),
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  context: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))).annotate({
    description:
      "Characters of context on each side (default 400). Overlapping windows are merged with all hit offsets listed.",
  }),
})
const OperationInput = Schema.Union([OpenInput, ReadInput, FindInput])
// Keep an object root for native function-calling providers. The operation
// schemas validate required fields and apply defaults at execution.
export const Input = Schema.Struct({
  action: Schema.optionalKey(Schema.Literals(["open", "read", "find"])).annotate({
    description: "Operation; defaults to open. open requires url; read/find require ref; find also requires pattern.",
  }),
  url: Schema.optionalKey(OpenInput.fields.url),
  ref: Schema.optionalKey(WebPage.Ref).annotate({
    description: "Snapshot ref returned by an earlier open; valid for 7 days.",
  }),
  format: Schema.optionalKey(WebPage.Format),
  timeout: OpenInput.fields.timeout,
  offset: OpenInput.fields.offset,
  limit: OpenInput.fields.limit,
  pattern: Schema.optionalKey(FindInput.fields.pattern),
  caseSensitive: FindInput.fields.caseSensitive,
  context: FindInput.fields.context,
})
const Output = Schema.Union([WebPage.Page, WebPage.Found])
type Format = typeof WebPage.Format.Type

const acceptHeader = (format: Format) => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
}

const headers = (format: Format, userAgent: string) => ({
  "User-Agent": userAgent,
  Accept: acceptHeader(format),
  "Accept-Language": "en-US,en;q=0.9",
})

const openCodeUserAgent =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OpenCode-User/1.0; +https://opencode.ai"

const isCloudflareChallenge = (error: HttpClientError.HttpClientError) => {
  if (error.reason._tag !== "StatusCodeError") return false
  const response = error.reason.response
  return response.status === 403 && response.headers["cf-mitigated"] === "challenge"
}

const request = (url: string, format: Format, userAgent = openCodeUserAgent) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers(format, userAgent)))

const assertHttpUrl = (url: URL) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://")
}

const execute = (http: HttpClient.HttpClient, url: string, format: Format, userAgent = openCodeUserAgent) =>
  http.execute(request(url, format, userAgent)).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))

const collectBody = (response: HttpClientResponse.HttpClientResponse) =>
  collectBoundedResponseBody(
    response,
    MAX_RESPONSE_BYTES,
    () => new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`),
  )

const mimeFrom = (contentType: string) => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
const isImageAttachment = (mime: string) =>
  mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
const isTextualMime = (mime: string) =>
  !mime ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript"
const convert = (content: string, contentType: string, format: Format) => {
  if (format === "html") return content
  const mime = mimeFrom(contentType)
  if (mime === "text/markdown" || mime === "text/x-markdown") return markdownBody(content)
  if (mime !== "text/html" && mime !== "application/xhtml+xml") return content
  const body = mainHTML(content)
  if (format === "markdown") return convertHTMLToMarkdown(body)
  if (format === "text") return extractTextFromHTML(body)
  return content
}

export const Plugin = {
  id: "opencode.tool.webfetch",
  effect: Effect.fn("WebFetchTool.Plugin")(function* (ctx: Context) {
    const http = yield* HttpClient.HttpClient
    const permission = yield* Permission.Service
    const pages = yield* WebPage.make

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: { namespace: "$opencode", concurrency: { group: "network", limit: 4 } } },
          description,
          input: Input,
          output: Output,
          execute: (raw, context) =>
            Effect.gen(function* () {
              const input = yield* Schema.decodeUnknownEffect(OperationInput)(raw)
              if (input.action === "read" || input.action === "find") {
                const snapshot = yield* pages.load(input.ref)
                yield* permission.assert({
                  action: name,
                  resources: [snapshot.url],
                  save: ["*"],
                  metadata: { ...input, url: snapshot.url },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                return yield* Effect.try(() => {
                  if (input.action === "find") {
                    const output = WebPage.find(
                      input.ref,
                      snapshot,
                      input.pattern,
                      input.offset,
                      input.caseSensitive,
                      input.context,
                    )
                    return {
                      output,
                      content: WebPage.renderFound(output),
                      metadata: { url: snapshot.url, ref: input.ref, truncated: output.nextOffset !== undefined },
                    }
                  }
                  const output = WebPage.read(input.ref, snapshot, input.offset, input.limit)
                  return {
                    output,
                    content: WebPage.renderPage(output),
                    metadata: { url: snapshot.url, ref: input.ref, truncated: output.nextOffset !== undefined },
                  }
                })
              }
              yield* Effect.try({
                try: () => assertHttpUrl(new URL(input.url)),
                catch: (error) => error,
              })

              yield* permission.assert({
                action: name,
                resources: [input.url],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })

              const { body, contentType } = yield* Effect.gen(function* () {
                const response = yield* execute(http, input.url, input.format).pipe(
                  Effect.catchIf(isCloudflareChallenge, () => execute(http, input.url, input.format, "opencode")),
                )
                const contentType = response.headers["content-type"] || ""
                const mime = mimeFrom(contentType)
                if (isImageAttachment(mime))
                  return yield* Effect.fail(new Error(`Unsupported fetched image content type: ${mime}`))
                if (!isTextualMime(mime))
                  return yield* Effect.fail(new Error(`Unsupported fetched file content type: ${mime}`))
                return { body: yield* collectBody(response), contentType }
              }).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.seconds(input.timeout ?? DEFAULT_TIMEOUT_SECONDS),
                  orElse: () => Effect.fail(new Error("Request timed out")),
                }),
              )
              const content = new TextDecoder().decode(body)
              const output = yield* Effect.try({
                try: () => convert(content, contentType, input.format),
                catch: (error) => error,
              })
              const saved = yield* pages.save({
                url: input.url,
                contentType,
                format: input.format,
                text: output,
              })
              const result = yield* Effect.try(() => WebPage.read(saved.ref, saved.snapshot, input.offset, input.limit))
              return {
                output: result,
                content: WebPage.renderPage(result),
                metadata: { contentType, url: input.url, ref: saved.ref, truncated: result.nextOffset !== undefined },
              }
            }).pipe(
              Effect.mapError((error) => new ToolFailure({ message: "Unable to open or inspect web page", error })),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

export function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}

export { convertHTMLToMarkdown }
