import { Parser } from "htmlparser2"
import matter from "gray-matter"

// Select whole semantic regions, preserving markup for the existing renderer.
// Multiple articles (e.g. a forum) must not lose siblings.
export function mainHTML(html: string) {
  type Region = { start: number; end: number; kind: "main" | "article" }
  const regions: Region[] = []
  const stack: { hidden: boolean; region?: Region }[] = []
  const parser = new Parser({
    onopentag(name, attributes) {
      const hidden =
        (stack.at(-1)?.hidden ?? false) ||
        ["head", "script", "style", "template", "noscript"].includes(name) ||
        "hidden" in attributes ||
        attributes["aria-hidden"]?.toLowerCase() === "true"
      const kind = name === "main" || attributes.role === "main" ? "main" : name === "article" ? "article" : undefined
      const region: Region | undefined =
        !hidden && kind ? { start: parser.startIndex, end: html.length, kind } : undefined
      if (region) regions.push(region)
      stack.push({ hidden, region })
    },
    onclosetag(_name, implied) {
      const frame = stack.pop()
      if (frame?.region) frame.region.end = implied ? parser.startIndex : parser.endIndex + 1
    },
  })
  parser.end(html)
  const mains = regions.filter((region) => region.kind === "main")
  const candidates = mains.length ? mains : regions
  let end = -1
  const selected = candidates.filter((region) => {
    if (region.start < end) return false
    end = region.end
    return true
  })
  const content = selected.map((region) => html.slice(region.start, region.end)).join("\n")
  return content.replace(/<[^>]*>/g, "").trim() ? content : html
}

export function markdownBody(content: string) {
  if (!/^\uFEFF?---\r?\n/.test(content)) return content
  // A thematic break without a closing frontmatter delimiter is normal prose.
  if (!/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(content)) return content
  try {
    const parsed = matter(content.replace(/^\uFEFF/, ""), {})
    if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) return content
    if (!Object.keys(parsed.data).length) return content
    const metadata = ["title", "canonicalUrl", "description", "date", "lastUpdated", "ms.date"]
      .flatMap((key) => {
        const value: unknown = parsed.data[key]
        if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return []
        return [`${key}: ${value instanceof Date ? value.toISOString() : String(value).replace(/\s+/g, " ").trim()}`]
      })
      .join("\n")
    return [metadata, parsed.content.trimStart()].filter(Boolean).join("\n\n")
  } catch {
    // Invalid YAML is still readable source, not a failed HTTP request.
    return content
  }
}
