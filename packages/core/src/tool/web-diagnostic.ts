export * as WebDiagnostic from "./web-diagnostic.js"

// Only fixed evidence strings leave this boundary: challenge HTML and response
// headers can contain tokens, cookies, and reflected user input.
export function diagnose(input: {
  source: "target_page" | "search_provider"
  status: number
  headers: Readonly<Record<string, string>>
  body?: string
}) {
  const html = (input.body ?? "").slice(0, 64 * 1024)
  const evidence = [
    ...(input.headers["cf-mitigated"]?.toLowerCase() === "challenge" ? ["cf-mitigated: challenge"] : []),
    ...(/<title[^>]*>\s*(?:Just a moment|Attention Required!\s*\|\s*Cloudflare)[.!\s]*<\/title>/i.test(html) &&
    /(?:\/cdn-cgi\/challenge-platform\/|_cf_chl_opt)/i.test(html)
      ? ["Cloudflare challenge page title and challenge script"]
      : []),
  ]
  const failureKind = evidence.length
    ? "browser_challenge"
    : input.status === 401
      ? "authentication_required"
      : input.status === 429
        ? "rate_limited"
        : input.status === 403
          ? "access_denied"
          : "http_error"
  const suggestedAction = input.source === "search_provider"
    ? "check_search_provider"
    : failureKind === "browser_challenge"
      ? "browse_with_headed_playwright"
      : failureKind === "authentication_required"
        ? "check_authentication"
        : failureKind === "rate_limited"
          ? "wait_before_retrying"
          : "inspect_failure"
  return { source: input.source, status: input.status, failureKind, evidence, suggestedAction }
}

export function message(diagnostic: ReturnType<typeof diagnose>) {
  return JSON.stringify({
    ok: false,
    ...diagnostic,
    message: diagnostic.source === "search_provider"
      ? `Search provider request failed (HTTP ${diagnostic.status}); this is not a target-page fetch. Check provider credentials, quota, or service availability; opening a result in a browser does not repair the search API.`
      : diagnostic.failureKind === "browser_challenge"
        ? `Browser verification detected (HTTP ${diagnostic.status}). Try headed Playwright: this HTTP tool cannot execute the verification JavaScript. Browser access is not guaranteed.`
        : `Page request failed (HTTP ${diagnostic.status}). No browser-challenge evidence was detected; the status alone does not establish that Playwright will help.`,
  })
}
