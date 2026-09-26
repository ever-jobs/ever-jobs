# Spec: 1703 — Glassdoor: fail fast, say why, and stop paginating forever

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| Spec ID        | 1703                                   |
| Slug           | glassdoor-robots-neutral-hardening     |
| Status         | done                                   |
| Owner          | agent                                  |
| Created        | 2026-09-25                             |
| Last updated   | 2026-09-25                             |
| Supersedes     | (none)                                 |
| Related specs  | 5082, 5024, 1696                       |

## 1. Problem Statement

`source-glassdoor` is one of the default sites, so almost every search runs it. A live probe on
2026-09-24 (honest UA, three requests, 3 s apart) found that the site answers every request from
our egress with a Cloudflare managed challenge: HTTP 403, `cf-mitigated: challenge`, a
`<title>Security | Glassdoor</title>` page. That is true even for the robots-allowed homepage.
The plugin's own logic then made things worse:

| # | Defect | Effect |
|---|---|---|
| D1 | A challenged homepage was only logged; the search POST went out anyway. | One wasted request per blocked run, to a path `robots.txt` disallows. |
| D2 | The token regex targets legacy markup and never matches. A naive `"token":"..."` match would pick up the Cloudflare analytics-beacon token (32 hex) from the block page. | A dummy token on every run; a naive fix sends a bogus one. |
| D3 | `errors[]` in the GraphQL response was never read; a batched (array) body was not handled. | A validation failure came back as a silent empty result. |
| D4 | A page with no cursor was requested anyway, which re-fetches page 1. Its rows were all seen, the list was non-empty, so the loop went on. No page cap. | An unbounded request loop with 5-10 s sleeps whenever `resultsWanted` exceeded the reachable rows. |
| D5 | `id` came from `adOrderId`, an ad-campaign id several listings share. | Distinct jobs dropped as duplicates; unstable ids. |
| D6 | `isRemote = locationType === 'S'`. `S` is STATE. | Every state-level listing ("California") flagged remote. |
| D7 | `input.location` was never read. | "engineer in Austin, TX" ran country-wide. |
| D8 | JSON/CORS headers applied client-wide (also to the HTML homepage GET); `authority`/`origin`/`referer` hard-coded to `www.glassdoor.com` on every regional domain. | Wrong headers on the document fetch and on every non-US domain. |
| D10 | The e2e asserted only when `jobs.length > 0`. | It could catch none of the above. |

## 2. Goals

- Never send a request that cannot succeed: a challenged homepage ends the run with `blocked`.
- Never return a silent zero: every empty result from a failure carries a `ScrapeDiagnostics`.
- Bound the request count: no loop without a cursor, no page past the budget.
- Correct the row mapping (id, URL, remote flag, location, rating, listing type, currency) and
  add the Spec 1696 posted-time fields, with no new request.
- Keep every pre-existing behaviour reachable through `EVER_JOBS_GLASSDOOR_LEGACY`.

## 3. Non-Goals

- **No new endpoint, path or request.** Location scoping on the site, per-listing detail fetches
  and filter keys (`jobType`, `easyApply`) all need endpoints `robots.txt` disallows. Not built.
- The search query text (`GD_JOB_SEARCH_QUERY`) is unchanged. Making the disallowed endpoint work
  better is outside a robots-neutral change.
- Whether Glassdoor should stay in the default site list is an owner decision (§9).
- No browser-fingerprint work: no new `sec-ch-ua` / `sec-fetch-*` values, no UA bump, no
  challenge solving.

## 4. User / Caller Stories

> As an **API caller**, I want **a Glassdoor result that is empty for a reason to say so**, so that
> **I can tell a blocked source from an empty board**.

> As an **operator**, I want **the plugin to make one request, not an unbounded loop, when it is
> blocked**, so that **a default search does not hammer a site that has already refused us**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | A homepage response that is a challenge (thrown 4xx/5xx or 200; body heuristic, the site's "Security \| Glassdoor" title, or `cf-mitigated: challenge`) returns `blocked` with detail `homepage challenge (HTTP <status>[, cf-mitigated: <v>])` and sends no search request. A non-challenge homepage failure keeps the old behaviour: warn and continue with the fallback token. | must |
| FR-2  | `extractCsrfToken` returns `null` on a challenge page, strips every `data-cf-beacon` attribute, accepts a `"token"` only in the colon-separated site shape (never 32 hex), and keeps `gdCSRF = "..."` as the secondary match. Without a token the fallback is sent, a warning is logged once, and later diagnostics end with `(no csrf token extracted)`. | must |
| FR-3  | `readGraphBody` accepts the object and the one-element-array form. `data.jobListings` present → use it, whatever `errors[]` says. Absent with errors → `fetch_error`, `graphql: <messages>` (≤ 280 chars). Absent without errors → `unknown`, `graphql: empty body` (or `non-JSON body`). A challenge body → `blocked`. Rows from earlier pages are kept. | must |
| FR-4  | Pagination stops when page > 1 has no cursor, when a page adds zero new ids, when the listings are empty, or after `min(maxPages, ceil((offset + resultsWanted) / 30) + 1)` pages. `resultsWanted` is capped at `maxPages × 30` (900 by default). `offset` discards the first N kept rows. Cursors are merged across pages. No sleep after the last request. | must |
| FR-5  | `id` is `gd-<listingId>` (from `job.listingId`, else the `jl` / `jobListingId` parameter of the job link; digits only). Rows without one are skipped. Dedupe is on that id. | must |
| FR-6  | `jobUrl` is `job-listing/j?jl=<listingId>` joined with `new URL()`; without an id, the header link resolved against the base URL. `companyUrl` is `Overview/W-EI_IE<employer.id>.htm`. Every join uses `new URL()`. | must |
| FR-7  | `isRemote` = location text says remote, or `locationType === 'S'` with `locId` 11047 (the site's Remote pseudo-location), or `input.isRemote === true`. | must |
| FR-8  | When `input.location` parses to a city, state or country, rows are post-filtered: same city (and state/country when both sides have one); else same state; else same country. A row without a country is in the searched domain's country. A row remote by itself is kept regardless only when `input.isRemote`. No extra pages are fetched to make up for filtered rows. If the filter leaves nothing, `empty` with `location post-filter kept 0 of N rows`. | must |
| FR-9  | Headers are per request. Homepage GET: HTML `accept` + `accept-language` only. Search POST: the values it always carried, minus `authority`, with `origin`/`referer` from the country domain; the Chrome client hints only when the caller did not supply `userAgent`. No per-request `user-agent`. | must |
| FR-10 | Mapping additions: `companyRating` (positive `rating`), `listingType` (`adOrderSponsorshipLevel` lower-cased, else `sponsored`, else `null`), `locations` / `workFromHomeType` from `parseLocationList`, `location` unchanged (never null), `title` falls back to `job.jobTitleText` before `N/A`, a missing `payCurrency` falls back to the country domain's currency (else `USD`). | should |
| FR-11 | Posted time via `postedTimeFields(postedFromAgeInDays(ageInDays, fetchedAt))`: same `datePosted` for valid ages, `day` / `relative`, no instant; a negative, `NaN` or absurd age gives `null`. | should |
| FR-12 | A country with no Glassdoor domain returns `bad_input` without a request (it used to throw out of `scrape()`). | should |
| FR-13 | `EVER_JOBS_GLASSDOOR_LEGACY` restores pre-1703 behaviours (§7.1); `EVER_JOBS_GLASSDOOR_MAX_PAGES` sets the page cap. | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Requests on a challenged run | exactly 1 (the homepage GET) |
| NFR-2  | Search requests per run | ≤ `min(maxPages, ceil((offset + resultsWanted)/30) + 1)`, strictly sequential |
| NFR-3  | New endpoints or paths | none |
| NFR-4  | Politeness | the existing 5-10 s sleep between pages; none after the last |

## 7. Contracts

### 7.1 Options

| Env var | Default | Meaning |
| --- | --- | --- |
| `EVER_JOBS_GLASSDOOR_LEGACY` | unset | `true`/`1`/`yes`/`on`/`all` restores every behaviour below; a comma list restores only those named. Unknown names are ignored. Read on every scrape. |
| `EVER_JOBS_GLASSDOOR_MAX_PAGES` | `30` | Positive integer page cap, clamped to 100. Anything else keeps 30. |

Legacy behaviour names: `challenge` (search sent after a challenged homepage), `ids`
(`gd-<adOrderId>` ids and their collapsing), `job-url` (the SEO link), `remote`
(`locationType === 'S'`), `location-filter` (ignore `input.location`), `headers` (the old
client-wide header map), `listing-type` (`sponsored` / `null` only), `currency` (`USD` for a
missing `payCurrency`). The bounded pagination is not restorable: the loop it replaced could only
re-request page 1.

### 7.2 Helpers (`glassdoor.utils.ts`)

```ts
isChallengePage(html: unknown, headers?: unknown): boolean
extractCsrfToken(html: unknown): string | null
readGraphBody(raw: unknown, headers?: unknown): GraphBody // { listings, cursors, errors, nonJson, challenge }
isRemoteListing(header: any, remoteMentioned: boolean): boolean
matchesRequestedLocation(row, requested, domainCountry?): boolean
buildHeaders(baseUrl: string, kind: 'document' | 'api', options?: { clientHints?: boolean }): Record<string, string>
listingIdOf, canonicalJobUrl, headerJobUrl, companyUrlOf, listingTypeOf, companyRatingOf,
glassdoorUrl, mergeCursors, challengeDetail, graphErrorDetail, headerValue, requestedLocationOf
parseCompensation(header, fallbackCurrency = 'USD') // default unchanged for existing callers
```

### 7.3 Diagnostics

| Reason | Detail | When |
| --- | --- | --- |
| `blocked` | `homepage challenge (HTTP 403, cf-mitigated: challenge)` | challenged homepage (no search sent) |
| `blocked` | `search challenge (HTTP <n>...)` | challenged search response |
| `fetch_error` | `graphql: <messages>` | errors and no data |
| `unknown` | `graphql: empty body` / `graphql: non-JSON body` | neither data nor errors |
| `empty` | `location post-filter kept 0 of N rows (site-side scoping unavailable)` | the filter removed every row |
| `bad_input` | `Glassdoor is not available for <country>` | no Glassdoor domain |
| any | `... (no csrf token extracted)` suffix | the run used the fallback token |

## 8. Test Plan

- Unit (`__tests__/glassdoor.utils.spec.ts`, 66 cases): challenge detection (fixture, header
  alone, title alone), the beacon-token regression, site/legacy tokens, both GraphQL body forms,
  remote rule, URL joins on regional domains, listing ids, mapping helpers, headers carry no new
  values, location matching, option parsing.
- Service (`__tests__/glassdoor.service.spec.ts`, 46 cases, mocked HTTP): no search after a
  challenge; errors-only → `fetch_error`; errors-with-data → rows; the unbounded-loop regression
  (≤ 2 posts, then 1) plus the seen-ids and budget variants; ids; remote; location filter; UK
  headers and currency; posted time; every legacy mode.
- Red control: removing the fail-fast fails 4 cases; removing the cursor stop, the seen-ids stop
  and the budget fails 5 of the A3 cases.
- E2E (`__tests__/glassdoor.e2e-spec.ts`, live): rows with `gd-\d+` ids and canonical URLs, or no
  rows with `blocked` / `fetch_error` / `timeout`; at most 2 requests. Run 2026-09-25 from our
  egress: 1 request (`GET /`), `blocked`, `homepage challenge (HTTP 403, cf-mitigated: challenge)`.
- Fixtures are synthetic (`__tests__/fixtures/`), modelled on the trimmed probe samples.

## 9. Open Questions

- **Default site list (owner).** Every default search still posts to `/graph`, which `robots.txt`
  disallows, whenever the homepage is not challenged (for example through a caller's proxy). If
  that is not acceptable, gate Glassdoor out of the defaults behind a flag; do not delete it.
  (default — proceeding: unchanged.)
- The crawl manifest (`maxConcurrentPerHost: 1, minIntervalMs: 5000`) waited for the `crawl`
  field on `@SourcePlugin`, which exists since the Spec 1690 merge (`feat/http-politeness`, 2026-09-26); declaring it is a follow-up.
  robots.txt compliance for `/graph` is available through the crawl policy
  (`EVER_JOBS_CRAWL_ROBOTS_TXT=respect`, or per site
  `EVER_JOBS_CRAWL_POLICIES={"sites":{"glassdoor":{"robotsTxt":"respect"}}}`), see Q-099.

## 10. Decisions

- **D-01 — Politeness over the fingerprint.** The design suggested `sec-fetch-mode: navigate` /
  `sec-fetch-dest: document` on the homepage GET, an `apollographql-client-name` header on the
  search, and a Chrome version bump. None was adopted: each makes the request look more like a
  browser or like the site's own front-end. The homepage GET instead drops the fetch metadata and
  client hints it used to carry, and the search keeps exactly its old values.
- **D-02 — Client hints follow the UA.** The Chrome 120 client hints describe the default UA;
  with a caller `userAgent` they would contradict it, so they are left off.
- **D-03 — No per-request `user-agent`.** The HTTP client already sends `input.userAgent` or its
  default, and a per-request header would override the caller's. (The old client-wide
  `user-agent` never took effect: the instance-level default wins in axios.)
- **D-04 — One legacy switch, named behaviours.** A single env var with a comma list keeps every
  old behaviour reachable without eight flags. The page loop is the exception (§7.1).
- **D-05 — Offset counts kept rows.** With the location filter on, `offset` skips rows the caller
  would have seen, not raw rows.
- **D-06 — Location of a "Remote" row stays an empty `LocationDto`.** `location` was never null
  before; `locations` / `workFromHomeType` are added only when present.

## 11. References

- `packages/plugins/source-glassdoor/src/glassdoor.{service,utils,constants}.ts`
- `packages/models/src/dtos/scrape-diagnostics.dto.ts` (`looksLikeChallenge`, Spec 5082)
- `packages/common/src/converters/posted-time.ts` (Spec 1696)
- Design note and live probe, 2026-09-24 (robots.txt, homepage and SERP challenge samples).
