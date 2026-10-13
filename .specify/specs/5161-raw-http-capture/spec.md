# Spec 5161

| Field | Value |
| ----- | ----- |
| Title | Raw HTTP capture for single-source debug runs |
| Status | Implemented |
| Package | `packages/common`, `packages/models`, `apps/api` |

## Problem

When a source plugin under- or mis-harvests a board, the only evidence is the
final `JobPostDto[]` and a one-line diagnostic — there is no way to see the
requests the plugin actually made or the payloads the site returned. Debugging
means re-running the source by hand outside the service.

## Proposal

`POST /api/jobs/search` gains an `include_raw=true` query parameter that
records every HTTP attempt the selected source makes — both through the shared
axios client and through the browser pool — and returns the entries as
`raw_by_source` on the response envelope.

## Contracts

### API

- `include_raw` is a query parameter on `POST /api/jobs/search`; default off.
  A query param on a POST matches `dedup`/`diagnostics`, which already work
  that way.
- `include_raw` is valid only when the request resolves to **exactly one**
  source — a `siteType`/`companyDomain`/`companySlug`/`companyUrl` selection
  naming a single plugin. Zero or multiple resolved sources return
  `400 Bad Request` ("include_raw requires exactly one source; got N").
- When enabled, the response gains
  `raw_by_source: Record<string, RawHttpEntry[]>` keyed by site. Only sources
  that started appear as keys (see Service below).
- The cache **read** is skipped when `include_raw` is set. The cache write is
  unchanged — it stores only the `JobPostDto[]` fan-out, which carries no
  capture data.
- When disabled, the response shape and behavior are unchanged and no capture
  buffers are allocated.
- Scope is the REST search route only. The GraphQL `jobs` resolver,
  `POST /api/jobs/analyze`, and `JobsAggregator.aggregate` call `searchJobs`,
  which unwraps `.jobs` — they are unchanged and emit no capture.

### Types

```ts
interface RawHttpEntry {
    seq: number;
    attempt: number;            // 0-based; always 0 for browser traffic
    method: string;
    url: string;                // redacted
    final_url?: string;         // last hop of a redirect chain, when different
    status: number | null;      // null when the request failed
    error?: string;
    elapsed_ms: number;
    content_type?: string;
    request_body?: unknown;     // JSON only, sensitive keys redacted
    body?: unknown;
    body_bytes: number;
    truncated: boolean;
}

interface RawCaptureSink {
    entries: RawHttpEntry[];
    retained_bytes: number;
    pending: Promise<void>[];   // in-flight body reads
    closed: boolean;            // set when the response ships; late writes dropped
}
```

## Changes

- `packages/models` — export `RawHttpEntry` / `RawCaptureSink`. No `raw` field
  is added to `JobResponseDto`; nothing reads it and plugin response objects
  stay untouched.
- `packages/common/src/context/request-context.ts` — `RequestContext` gains an
  optional `rawCapture` sink; `runWithRawCapture(sink, fn)` runs `fn` in a
  child async context preserving `requestId`; `getRawCapture()` returns the
  in-scope sink.
- `packages/common/src/http/http-client.ts` — `request()` reads the context
  sink and records each attempt (success, HTTP error, network error, retry)
  before returning or rethrowing; skips recording entirely when `sink.closed`
  is set. `seq` is assigned when the attempt starts, `elapsed_ms` when it
  finishes. Response bodies are captured on non-2xx too — error payloads
  usually carry the actual diagnostic. JSON bodies are stored parsed,
  text/HTML as strings; binary and streams are omitted. `final_url` is set
  only when it differs from `url`. The request/response supplied to the plugin
  is never mutated.
- `packages/common/src/browser/browser-pool.ts` — exports
  `attachRawCapture(page)`, which `getPage()` applies to every page it
  returns:
    - The sink is read **once** at attach time and closed over by the
      listeners. Playwright runs `page.on(...)` handlers on its connection's
      message loop where the async context is not active, so a handler that
      looks the sink up at event time would usually find nothing.
    - Listeners attach to the **page**, never the context — persistent
      contexts are shared across sources.
    - Entries are created on `requestfinished` / `requestfailed` (`response`
      never fires on network failure); `elapsed_ms` comes from
      `request.timing().responseEnd`.
    - Body reads start on the `response` event so they are queued before the
      plugin's `page.close()`; each read is tracked in `sink.pending`.
    - Only `document`, `xhr`, and `fetch` resource types are recorded — page
      assets (js/css/img/font/analytics) would exhaust the source budget
      without diagnostic value.
    - `request_body` comes from `request.postData()`, kept only when it
      parses as JSON; a redirect chain (linked by `redirectedFrom`) becomes
      one entry with the last hop's URL as `final_url`; a failed body read
      keeps the entry with `truncated: true`.
    - Entries share the enclosing source's sink, so `seq` interleaves with
      http-client entries in wall-clock order.
- `apps/api/src/jobs/jobs.service.ts`
    - `searchJobsWithDiagnostics(input, options?: { captureRaw?: boolean })`.
      The flag is an options parameter, not a `ScraperInputDto` field —
      `input` is spread into the controller's `cacheParams` and into every
      plugin's `scraperInput`, so a field would leak into the cache key and
      reach plugins.
    - The single-source check runs **before** the
      `selectedScrapers.length === 0` early return, so a zero-source capture
      request returns 400 rather than an empty 200.
    - Sinks are created in the worker loop —
      `sinks[index] = captureRaw ? createRawCaptureSink() : undefined` —
      and `scrapeOne(site, scraper, input, sink)` wraps only the
      `scraper.scrape(scraperInput)` call in `runWithRawCapture()` inside the
      circuit-breaker lambda. The deadline path and the rejected path both
      need sink access, and neither can see `scrapeOne`'s locals.
    - `withDeadline` does not cancel: a timed-out scrape keeps running and
      writing to its sink after the response is sent. Browser plugins end
      with a `page.goto`, parse, then close the page — so the response that
      mattered most often has its body read still pending. Before
      snapshotting, the service awaits `Promise.allSettled(sink.pending)`
      with a short cap (~2 s, only when capture is enabled), then sets
      `sink.closed` and snapshots `entries.slice()`.
    - `searchJobsWithDiagnostics` returns a third field
      `rawBySource: Record<Site, RawHttpEntry[]>` populated from the
      snapshots. This path — not `JobResponseDto` — carries capture because
      the controller never receives per-source results, and a thrown scrape
      produces no `JobResponseDto`; the sink still holds whatever ran before
      the throw.
    - `rawBySource` covers only sources that started: deadline-skipped
      sources and `companyDomain:` unresolved-domain diagnostic rows get no
      key; a circuit-open source gets `[]` (it started but made no requests).
- `apps/api/src/jobs/jobs.controller.ts` — parses `include_raw` and passes it
  to the service; emits `raw_by_source` only when requested.
- `packages/plugins/source-tesla-playwright`,
  `packages/plugins/source-ats-kula_ai` — each calls `attachRawCapture(page)`
  once after `browser.newPage()`. They skip the pool
  (`chromium.launch()` + custom launch args; Tesla sits behind bot
  protection), and moving them onto `getPage()` would change the browser
  fingerprint of working scrapers. Launch code is untouched. These are the
  only plugin changes.

## Capture rules

- `url` and `final_url` are redacted with the shared URL redactor; error text
  is sanitized before recording.
- JSON request bodies only; sensitive keys are recursively redacted with the
  existing key regex.
- Request headers and cookies are never recorded.
- Defaults: `RAW_CAPTURE_MAX_BODY_BYTES=5242880`,
  `RAW_CAPTURE_MAX_SOURCE_BYTES=20971520`. Retained request and response
  bodies are measured as UTF-8 bytes.
- On overflow, text is truncated at a UTF-8 boundary or the JSON body is
  omitted; `truncated=true` is set and the original `body_bytes` preserved.
- Attempt metadata keeps recording after the source body budget is
  exhausted.
- No plugin changes beyond the two `attachRawCapture` calls.

## Test plan

- Disabled: unchanged response shape; no capture buffers.
- Enabled on zero or multiple resolved sources → 400.
- Enabled: JSON/HTML success, HTTP failure (body captured), network failure,
  retries, scrape exception — thrown scrapes still surface their sink's
  entries.
- Concurrent sources remain isolated; attempt sequence is stable.
- URL, final-url, error, and request-body redaction.
- Per-body and cumulative caps; plugin responses remain intact.
- Cache reads bypassed; writes exclude capture; a later request without the
  flag returns no `raw_by_source`.
- The flag appears in neither the cache key nor the plugin `ScraperInputDto`.
- Deadline-skipped sources and unresolved-domain diagnostic rows produce no
  `raw_by_source` key; circuit-open sources produce `[]`.
- Entries for a deadline-losing source are a snapshot; writes after the
  deadline are dropped.
- Empty capture for sources that started but made no requests.
- Browser-pool: `requestfinished`/`requestfailed` produce entries with the
  field mapping above; non-document/xhr/fetch resource types are skipped; a
  failed body read keeps the entry with `truncated: true`; the sink is
  captured at attach time; the body read is queued on `response` so it
  survives an immediate `page.close()`.
- Pending body reads are drained before snapshot/close — a scrape ending in
  `page.goto` still emits that document's body.
- Delegation: a thin company plugin awaiting
  `registry.getScraper(...).scrape()` inside its own `scrape()` keeps the
  capture context active — the delegate's requests land under the company
  plugin's site key.

## Non-goals

- Multi-source capture (rejected with 400).
- GraphQL, `/analyze`, and aggregator paths.
- Capturing headers or cookies.
- Changing any plugin's browser fingerprint or launch configuration.
