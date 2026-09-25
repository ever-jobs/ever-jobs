# Spec: 1693 — Source Job Board Plugin: Level (jobsbylevel.com), AI-rated listings

| Field          | Value                                        |
| -------------- | -------------------------------------------- |
| Spec ID        | 1693                                         |
| Slug           | source-jobsbylevel                           |
| Status         | done                                         |
| Owner          | agent                                        |
| Created        | 2026-09-25                                   |
| Last updated   | 2026-09-25                                   |
| Supersedes     | (none)                                       |
| Related specs  | 5082, 1689, 1695, 1696, 1699, 1700           |

## 1. Problem Statement

Level (`jobsbylevel.com`) is a job board that launched in September 2026. It reads postings from
employers' own applicant-tracking systems every six hours and gives every listing an **AI Level
from 1 to 4**: how central AI is to the daily work, not seniority. On 2026-09-25 it listed about
70.9k live jobs from 544 companies.

| Level | Published score band | Meaning |
| ----- | -------------------- | ------- |
| 1 | 0 to 39 | AI is not the work |
| 2 | 40 to 59 | AI is a tool |
| 3 | 60 to 79 | AI is daily work |
| 4 | 80 to 100 | AI is the job |

Most of those postings already reach us through the `source-ats-*` plugins. What no other source
has is the rating, which lets a caller ask for "AI-heavy roles only". Structured salary and
country data for employers whose ATS payload lacks them is a secondary gain.

No plugin covered it (`grep -ril jobsbylevel` found nothing). The only similarly named plugin,
`source-company-gohighlevel` (`Site.HIGHLEVEL`), is unrelated.

## 2. Goals

- A `jobsbylevel` source that returns Level listings with the AI level attached.
- Only robots-allowed paths, an honest User-Agent, strictly sequential requests at the
  operator's fair-use pace, and bounded work per call.
- Partial results with a diagnostic when something fails, as sibling plugins do (Spec 5082).

## 3. Non-Goals

- **The REST API under `/api/`.** It is the operator's documented developer API, but robots.txt
  disallows `/api/` for every user agent, including the aggregators it allowlists for `/feeds/`.
  It is not called, and no option turns it on.
- **The bulk XML feeds under `/feeds/`.** Allowed only for a named allowlist of aggregator bots;
  we are not on it and never present another bot's identity. Access is a business step (ask the
  operator).
- **`/go/<uuid>` apply redirects and `/md/`.** Both disallowed; never requested.
- **HTML listing pages with `?q=`, `?category=` and similar.** Disallowed; never requested.
- **ATS discovery** (`atsType` from an employer ATS link). The operator never returns the ATS link
  (verified on 2026-09-25), so there is nothing to map.
- Registration (`Site`, plugin index, path aliases, manifest) and the `JobPostDto.aiLevel`
  declaration are done by the integrator, not in this lane.

## 4. User / Caller Stories

> As an **API caller**, I want **listings rated by how central AI is to the work**, so that **I
> can search for AI-heavy roles only**.

> As an **operator of this service**, I want **the source to stay within robots.txt and the
> site's fair-use limit**, so that **we remain a welcome client**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | Default transport: the operator's MCP server (`POST /mcp`, JSON-RPC `tools/call`), `search_jobs` for listings and `get_job` for one listing's detail. | must |
| FR-2  | Fallback transport: `GET /feed.xml` (RSS) plus the listing page's JobPosting JSON-LD for details. Selected by `JOBSBYLEVEL_TRANSPORT=feed`, and tried automatically once when the MCP listing fails before any job (`JOBSBYLEVEL_FEED_FALLBACK=false` disables that). | must |
| FR-3  | Every request URL is checked against the robots.txt disallow list (`/api/`, `/feeds/`, `/go/`, `/md/`, `/jobs/edit/`, `/confirm/`, `/unsubscribe/`, `/panel/`) and must be `https://jobsbylevel.com` with no query string; redirects are pinned to the host. | must |
| FR-4  | At least 1.1 s between two requests to the host, across concurrent scrapes (synchronous slot reservation); everything sequential, never a `Promise.all` against the host. | must |
| FR-5  | Server-side filters where `search_jobs` has them: `searchTerm` → `query`, `isRemote` → `remote: true`, a non-country `location` → `city`, `companySlug` → `company`, `JOBSBYLEVEL_MIN_AI_LEVEL` / `JOBSBYLEVEL_MAX_AI_LEVEL` → `ai_level_min` / `ai_level_max`. Each is re-checked client-side. | must |
| FR-6  | Client-side filters: `location` (label substring, whole word for ≤ 3 characters, or same country as the ISO code), `jobType`, `hoursOld`, `companySlug`, AI level range, `JOBSBYLEVEL_CATEGORIES`. A filter on a value the listing lacks drops it. `country` is never a filter. | must |
| FR-7  | Paging: 20 items per page (server cap); stop at `resultsWanted`, on a short page, when `page × per_page ≥ total`, or at the page cap (10; `JOBSBYLEVEL_MAX_PAGES` 1-25). `offset` maps to page + skip without client filters, and skips matches with them. Duplicate slugs across pages are dropped. | must |
| FR-8  | Detail budget by `descriptionDepth`: `board` 0, default / `detail-25` 5, `detail-all` 25; a 30 s time budget for the phase; each detail request times out at `min(requestTimeout, 20 s)`. | must |
| FR-9  | Output mapping as in §7.2, including the additive `aiLevel` (1-4). The AI level is never written into the description. | must |
| FR-10 | Diagnostics as in §7.4. | must |
| FR-11 | A module-level cache (10 min TTL, 50 listing entries, 200 detail entries, oldest evicted first) of validated responses only; `JOBSBYLEVEL_CACHE_TTL_MS=0` turns it off. | should |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Host request rate | ≤ 1 per 1.1 s (operator fair use: ~60/min/IP, `x-ratelimit-limit: 60`) |
| NFR-2  | Requests per default scrape (15 results, no client filter) | 1 listing + 5 detail |
| NFR-3  | Worst case per scrape | 10 listing (25 with the env cap) + 25 detail |
| NFR-4  | Memory | caches bounded by entry count; RSS parse capped at 2 000 items |

## 7. Contracts

### 7.1 Transport

```ts
// POST https://jobsbylevel.com/mcp
// Accept: application/json, text/event-stream; Content-Type: application/json
{ jsonrpc: '2.0', id, method: 'tools/call',
  params: { name: 'search_jobs', arguments: { query?, ai_level_min?, ai_level_max?, remote?, city?, company?, page } } }
// → result.content[0].text = JSON { total, page, per_page: 20, items: JobsByLevelItem[] }
{ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_job', arguments: { id_or_slug } } }
// → the item plus skills[], description_text (plain), expires_at, company_website
```

The parser also accepts a JSON string, an SSE-framed body and `result.structuredContent`.

### 7.2 Output mapping (`JobPostDto`)

| Field | Source |
| ----- | ------ |
| `id` | `jobsbylevel-<slug>` (slug from the listing URL) |
| `title` | `title`, trimmed; the item is skipped without a title or a Level listing URL |
| `companyName` | `company` |
| `companyUrl` | `https://jobsbylevel.com/companies/<company_slug>` |
| `companyUrlDirect` | `company_website` (detail), http(s) only |
| `jobUrl` | `url` as served (canonical listing page, with the operator's `utm_source`) |
| `jobUrlDirect` | `null` (the operator never exposes the ATS link) |
| `countryCode` | `country`, upper-cased, `UK` → `GB`, must be ISO 3166-1 |
| `location`, `locations` | `parseLocationList([label])`, label per §10 D-08 |
| `isRemote` | `remote` truthy, or the label mentions remote |
| `workFromHomeType` | from the label (`Hybrid` …) |
| `jobType`, `employmentType` | `getJobTypeFromString(employment_type)`, raw string |
| `compensation` | `salary_min` / `salary_max` / `salary_currency`; stated period wins, else ≥ 10 000 → yearly, else no interval; description text as last resort after a detail read |
| `datePosted`, `datePostedAt`, `datePostedPrecision`, `datePostedBasis` | `postedTimeFields(postedFromTimestamp(posted_at))` (Spec 1696) |
| `jobLevel` | `seniority` (null for `unknown`) — seniority, not the AI level |
| `jobFunction` | `category` humanised (`software-engineering` → `Software Engineering`; null for `other`) |
| `skills` | case-insensitive union of `tools[]` and (detail) `skills[]` |
| `listingType` | `sponsored` when `sponsored === true` |
| `description`, `emails` | detail only; plain text from `get_job`, or the JSON-LD HTML converted per `descriptionFormat` |
| `atsId` | JSON-LD `identifier.value` (feed path only) |
| `site` | `jobsbylevel` |
| `aiLevel` (additive) | `ai_level` when 1-4, else the band of `ai_score`; feed path: the page's "AI Level N of 4" badge |

### 7.3 Environment variables (read on every scrape)

| Variable | Default | Effect |
| -------- | ------- | ------ |
| `JOBSBYLEVEL_TRANSPORT` | `mcp` | `feed` (or `rss`) reads the RSS feed instead |
| `JOBSBYLEVEL_FEED_FALLBACK` | on | `false`/`0`/`no`/`off`: no automatic feed retry after an MCP failure |
| `JOBSBYLEVEL_MIN_AI_LEVEL` | unset | 1-4, keep levels ≥ N (server- and client-side) |
| `JOBSBYLEVEL_MAX_AI_LEVEL` | unset | 1-4, keep levels ≤ N; min > max is `bad_input` |
| `JOBSBYLEVEL_CATEGORIES` | unset | comma-separated category slugs, client-side |
| `JOBSBYLEVEL_MAX_PAGES` | 10 | listing-page cap, 1-25 |
| `JOBSBYLEVEL_CACHE_TTL_MS` | 600000 | cache TTL; `0` turns the cache off |
| `JOBSBYLEVEL_EMIT_AI_LEVEL` | on | `false`/`0`/`no`/`off` leaves the `aiLevel` key out |

### 7.4 Diagnostics

| Situation | Result |
| --------- | ------ |
| Listing page N > 1 fails | jobs so far + `classifyScrapeError(err)` (the API fan-out reports it as `partial`) |
| Page 1 fails, feed fallback returns jobs | feed jobs + `partial` ("MCP listing failed (…); served from the RSS feed") |
| Page 1 fails, no fallback or fallback empty | `[]` + the MCP failure: 403/challenge `blocked`, 5xx/429 `fetch_error`, timeout `timeout`, 404 `bad_input` |
| HTML body | `blocked` |
| Wrong envelope, JSON-RPC error, non-JSON tool text | `unknown` with the detail; invalid params `bad_input`; a rate-limit tool error `fetch_error` |
| Detail reads failed, no page-level diagnostic | `partial` "`<failed>/<attempted>` detail fetches failed" |
| AI level min > max; feed with `jobType`/categories; feed with remote/location/level filters and depth `board` | `bad_input`, no request |

## 8. Test Plan

- Unit (`__tests__/jobsbylevel.service.spec.ts`, `__tests__/jobsbylevel.helpers.spec.ts`,
  `createHttpClient` mocked, clock and sleep injected): registration, field-by-field mapping on
  a page trimmed from the live read plus synthetic items, AI-level bands, request construction,
  the robots guard on both transports, paging and offset, every client filter including the
  `country` default regression, detail budget and ordering (one request in flight), time budget,
  per-request timeout, description formats, every diagnostic row, cache and TTL, pacing
  (sequential with a fake clock, concurrent with the real one), the feed transport and fallback.
- Mutation controls: removing the pacer, the detail cap, the `UK` → `GB` rule or `/api/` from the
  disallow list each turns tests red.
- E2E (`__tests__/jobsbylevel.e2e-spec.ts`, live, two host requests): a board read and a remote
  search, each asserting a non-empty result unless a diagnostic explains it.

## 9. Open Questions

- **Q-A — Declare `aiLevel` on `JobPostDto`?** (default — proceeding) The plugin sets it as an
  additive key typed by `JobsByLevelJobPost`; REST passes it through, GraphQL does not select it.
  The integrator adds `aiLevel?: number | null` to the DTO; a GraphQL `Int` is a follow-up.
- **Q-B — Multi-site listings with one `country`.** Level gives one country per listing, so
  "London, Mountain View" with `IL` gains an ", Israel" suffix. (default — proceeding) Keep the
  design's append rule, but not for labels that already list sites with `/`, `;` or `|`.
- **Q-C — Hybrid listings are `remote: true` on Level.** (default — proceeding) Pass it through
  as `isRemote: true` with `workFromHomeType: 'Hybrid'` from the label.
- **Q-D — Operator permission for `/api/` or `/feeds/`.** A business step; out of scope here.

## 10. Decisions

- **D-01 — MCP, not REST, by default.** The design assumed `/api/jobs` with 100 items a page and
  an ATS `apply_url`. The live check (2026-09-25, robots-allowed pages only: `/llms.txt`,
  `/.well-known/api-catalog`, `/developers`, the MCP server card, then one `search_jobs` and one
  `get_job` call) found: the documented API is `/api/v1/jobs`, 20 items a page, and no response
  ever carries the ATS link; `/api/` is disallowed for every agent; `/mcp` is not disallowed and
  is published for "any HTTP client" with the same fields. So the plugin reads `/mcp`.
- **D-02 — RSS plus listing-page JSON-LD as the fallback**, selectable and automatic. The feed
  covers only the newest ~1 000 listings and carries no location, salary or level; listing pages
  can take over a minute to render when uncached, hence the 20 s cap per page.
- **D-03 — The slug is the job id** (`jobsbylevel-<slug>`), not the UUID the design named: the
  feed and the listing page carry no UUID, and one id scheme keeps a listing's identity stable
  when the fallback engages.
- **D-04 — `jobUrl` is the served URL verbatim**, keeping the operator's attribution parameter as
  it asks ("keep that link when you show results"). No `jobUrlDirect`, `applyUrl` or `atsType`.
- **D-05 — `aiLevel` is an additive runtime key** (see Q-A); `JOBSBYLEVEL_EMIT_AI_LEVEL=false`
  omits it so every job keeps only declared DTO keys.
- **D-06 — `country` is not a filter.** `ScraperInputDto` defaults it to `USA` for domain
  resolution; filtering on it would drop every non-US listing.
- **D-07 — Server-side where possible, always re-checked client-side.** `search_jobs` has no
  category argument, so `JOBSBYLEVEL_CATEGORIES` is client-side only.
- **D-08 — Location labels.** Level's labels are normalised before parsing: `US-WA-Bellevue` →
  `Bellevue, WA, US`; `San Francisco (United States)` → `San Francisco, United States`;
  `Remote (world)` → `Remote`; `Hybrid Paris` → `Hybrid - Paris`. The posting country is then
  appended unless the label already names a country, equals it, or lists several sites.
- **D-09 — The plain-text `get_job` description is returned as is** for every
  `descriptionFormat`; only the JSON-LD HTML (feed path) is converted.
- **D-10 — Strict filters.** A `jobType` filter drops listings with no employment type; an
  `hoursOld` filter drops listings with no posting time.
- **D-11 — Feed-path filters.** `jobType` and categories cannot be judged from the feed
  (`bad_input`); remote, location and AI-level filters are judged on listing pages within the
  detail budget, so depth `board` with one of them is `bad_input`.
- **D-12 — Pacing is module level** with synchronous slot reservation, so concurrent scrapes
  queue instead of racing. When `@SourcePlugin` gains a crawl manifest, declare
  `maxConcurrentPerHost: 1, minIntervalMs: 1100` and retire the local pacer.
- **D-13 — Feed fallback on any MCP listing failure**, including a 404 (the endpoint moving is
  exactly when the fallback helps), **except a refusal** (review fixup, 2026-09-25): after a 429,
  a 401/403/407, a block or challenge, or a rate-limit tool error, the feed on the same host is
  not asked and the MCP diagnostic is returned.
- **D-14 — Detail reads stop at a refusal (review fixup).** The MCP `get_job` reads, the feed's
  listing-page reads and the feed enrichment reads all stop at the first refusal and return the
  refusal as the diagnostic with the jobs collected so far. Other failures keep the earlier
  behaviour (counted, `partial`). robots.txt is still checked against the static disallow list;
  reading it at runtime is left to the crawl policy (Spec 1690).

## 11. References

- `packages/plugins/source-jobsbylevel/` — plugin, fixtures and suites.
- `packages/common/src/converters/posted-time.ts` (Spec 1696), `packages/common/src/utils/iso3166.ts`
  (Spec 1699), `packages/common/src/utils/jsonld.ts` (Spec 5022),
  `packages/models/src/dtos/scrape-diagnostics.dto.ts` (Spec 5082).
- Operator pages read on 2026-09-25: `/robots.txt`, `/llms.txt`, `/.well-known/api-catalog`,
  `/developers`, `/.well-known/mcp/server-card.json`.
