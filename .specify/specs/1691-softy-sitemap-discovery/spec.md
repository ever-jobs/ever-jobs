# Spec: 1691 — Softy: sitemap discovery, paginated listing, polite detail fetches

| Field | Value |
|---|---|
| Spec ID | 1691 |
| Slug | softy-sitemap-discovery |
| Status | Implemented |
| Owner | agent |
| Created | 2026-09-24 |
| Last updated | 2026-09-25 |
| Supersedes | — |
| Related specs | 374 (source-ats-softy), 1690 (crawl policy) |
| Plan / tasks | [plan.md](./plan.md) · [tasks.md](./tasks.md) |
| Operator guide | [docs/CRAWL_POLICY.md](../../../docs/CRAWL_POLICY.md) (discovery modes, Softy example) |

## 1. Problem Statement

Softy's CTO asked that we read one request at a time per site at ~1 req/s,
identify ourselves, and ideally discover offers from `/sitemap.xml` rather than
crawling list pages. Independently, a polite live check on 2026-09-24 (4 requests,
2 s apart, honest UA) showed the plugin is **broken on the current markup**:

- `https://{tenant}.softy.pro/offres` now 301-redirects to `/offers`.
- Offer links are `https://{tenant}.softy.pro/offers/{ID}` (no slug). The plugin's
  `SOFTY_OFFER_LINK_REGEX` (`/offre/{ID}-{slug}`) matches **0** links.
- The board is **paginated** (`/offers?page=1..N`, 21 cards per page); the plugin
  only ever read page 1.

## 2. Live surface (verified 2026-09-24, tenant `ensio`)

- `robots.txt`: `User-agent: * / Allow: /` (AI-training crawlers disallowed; not
  us), `Sitemap: https://{tenant}.softy.pro/sitemap.xml`.
- `sitemap.xml`: a `<urlset>` listing the root, `/offers?page=1..N`, and one
  `/offers/{ID}` per open offer with `<lastmod>` (`YYYY-MM-DD HH:MM:SS`, newest
  first). ~8 KB for 65 offers.
- List page cards: `<a href="https://{tenant}.softy.pro/offers/{ID}">` wrapping
  `h3[data-slot="joboffer-title"]`, `[data-slot="joboffer-locations"] p` (city),
  `[data-slot="joboffer-published-at"]` ("Mise en ligne le DD/MM/YYYY"),
  `span[data-slot="badge"]` (contract e.g. `CDI`, schedule e.g. `Temps plein`).
  Pagination links `…/offers?page=N`. ~280 KB per page.
- Detail page: `h1` title, `[data-slot="joboffer-locations"] p`, badges, `.prose`
  sections under `h2` headings (company, mission, profile…), `og:title` /
  `og:description`. No JSON-LD, no published date. ~200 KB.

## 3. Design

- **Discovery** from the resolved crawl policy's `discovery` (caller `crawl.discovery`,
  operator `sites.softy.discovery`, `EVER_JOBS_CRAWL_DISCOVERY`):
  - `sitemap`: GET `/sitemap.xml` → `/offers/{ID}` entries sorted by `lastmod` desc →
    take `offset + resultsWanted` → fetch each detail page **sequentially**.
  - `listing`: GET `/offers?page=1..N` (stop at `resultsWanted`, no new cards, or
    `SOFTY_MAX_LIST_PAGES`, default 50) and parse cards; the legacy `/offres` +
    `/offre/{ID}-{slug}` parser is kept as a fallback for tenants still on the old
    markup. Detail pages per `descriptionDepth` (below).
  - `auto` (default): `sitemap`; if it is missing, empty, or unparseable → `listing`.
    When the caller asked for `descriptionDepth: 'board'` (no detail pages), `auto`
    uses `listing` (1 request per 21 offers is cheaper than sitemap + details).
- **Detail pages** per `descriptionDepth`: `board` → none (listing only), `detail-25`
  → first 25, `detail-all`/unset → all wanted (the pre-1691 behaviour, bounded by
  `resultsWanted` and `SOFTY_MAX_DETAIL_FETCHES`). Always **sequential** (`for … await`),
  never `Promise.allSettled`.
- **Pacing** via the plugin manifest: `crawl: { rateLimitScope: 'domain',
  maxConcurrentPerHost: 1, minIntervalMs: 1000 }` — every tenant shares Softy's one
  server, so the budget is per `softy.pro`, ~1 req/s, one in flight. Operators and
  callers can change it (Spec 1690 layers).
- **Identity**: the hard-coded Chrome UA is no longer applied; it is kept as
  `SOFTY_BROWSER_USER_AGENT` and is only sent if the operator selects UA mode `plugin`.
- **Detail cache**: `BoundedTtlCache` keyed by `url + '|' + lastmod` (sitemap) or
  `url` (listing), `SOFTY_DETAIL_CACHE_MAX` (default 500 entries), `SOFTY_DETAIL_CACHE_TTL_MS`
  (default 6 h). Stores extracted fields only (description ≤ 8,000 chars). Repeat
  searches re-fetch only offers whose `lastmod` changed.
- **Dates**: listing cards give "Mise en ligne le"; in sitemap mode the detail page has
  no date, so `datePosted` = `lastmod` date unless `SOFTY_LASTMOD_AS_DATE_POSTED=false`.
- **Failure handling** unchanged in spirit: 4xx/DNS → empty; partial results keep a
  diagnostic; a 429/`Retry-After` now cools the whole `softy.pro` bucket (Spec 1690).

## 4. Non-Goals

- Scraping the application form or anything behind login.

## 5. Test Plan

Offline fixtures shaped like the live markup (synthetic, small): sitemap (urlset
with lastmod, plus a sitemapindex), list pages 1–2 with pagination, a legacy
`/offre/{ID}-{slug}` page, a detail page. Tests: each discovery mode; `auto`
fallback; `descriptionDepth`; sequential fetching (a fake client asserts ≤ 1 request
in flight); resultsWanted/offset; lastmod cache hit/miss; legacy parser fallback;
tenant resolution unchanged; manifest `crawl` values. The live e2e spec keeps
`resultsWanted` tiny.

## 6. As built (2026-09-25)

Implemented by lane B5 of Spec 1690. §3 is the agreed design; this section records
where the build went further or differently.

### 6.1 Differences from §3

- **`auto` also picks `listing` when the detail budget is short.** A sitemap offer
  needs its detail page to become a post, so when the detail budget
  (`descriptionDepth`, `SOFTY_MAX_DETAIL_FETCHES`) is smaller than
  `offset + resultsWanted`, `auto` goes to `listing` straight away and returns the
  rest board-only. An explicit `sitemap` keeps the budget and reports a `partial`
  diagnostic that says how to get more (`crawl.discovery=listing`, a larger
  `descriptionDepth` or `SOFTY_MAX_DETAIL_FETCHES`).
- **Discovery source order.** Inside a scrape context the resolved policy decides
  (caller `crawl.discovery` > operator `hosts["*.softy.pro"]` > `sites.softy` >
  `EVER_JOBS_CRAWL_DISCOVERY` > `auto`). Outside one (CLI, library, e2e) the plugin
  opens its own scrape context with its manifest policy and the caller's `crawl`, so
  the same pacing applies; if the resolver is unavailable it falls back to the
  caller value, then `EVER_JOBS_CRAWL_DISCOVERY`, then `auto`.
- **Failure handling is sharper than "unchanged in spirit".** A 4xx (other than 429)
  or an unknown host → `missing` (empty); a robots.txt refusal → `missing` with the
  diagnostic kept; a 5xx / network error → `failed` (the rest continues); a **429
  after `HttpClient`'s retries, an abort, or any other crawl-policy refusal** (host
  cooling down, queue timeout, egress) stops every further request of the scrape and
  keeps the partial result with its diagnostic. After
  `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` (default 3; 0 = never) consecutive failed
  detail fetches, the scrape stops fetching detail pages — a struggling server is left
  alone.
- **Pagination** also stops when no link to a later page exists (in addition to
  `resultsWanted`, a page with no new cards, and `SOFTY_MAX_LIST_PAGES`).
- **Detail URLs** may carry a two-letter locale segment (`/en/offers/{ID}`);
  `/offers/{ID}/apply` and `/offers?page=N` are not detail URLs.
- **Badges.** A contract badge must be the whole badge or be followed by a separator
  or a duration, so skill badges such as "Contract management" on detail pages are not
  taken for a contract type; working-time badges are recognised separately.
- **Descriptions** are capped at `SOFTY_DESCRIPTION_MAX_CHARS` (8,000, a constant) in
  whichever `descriptionFormat` was asked for.
- **Cache knobs.** `SOFTY_DETAIL_CACHE_MAX=0` disables the cache;
  `SOFTY_DETAIL_CACHE_TTL_MS=0` means no expiry. All `SOFTY_*` variables are read per
  scrape (no restart needed); invalid values are warned about once and ignored.
  `SoftyService.clearDetailCache()` empties it.
- **Identity.** The old Chrome/129 UA is still *declared* through `setHeaders`
  (`SOFTY_BROWSER_USER_AGENT`), so any of `EVER_JOBS_CRAWL_USER_AGENT_MODE=plugin`, an
  operator `sites.softy.userAgentMode: "plugin"`, or a caller `crawl.userAgentMode:
  "plugin"` sends it; by default the honest Ever Jobs UA goes out. `SOFTY_HEADERS` keeps
  the HTML `Accept` and French `Accept-Language`.
- **Legacy constants kept.** `SOFTY_OFFERS_PATH` (`/offres`), `SOFTY_OFFER_PATH`
  (`/offre/`) and `SOFTY_OFFER_LINK_REGEX` remain exported and documented as the
  legacy surface.

### 6.2 Sitemap toolkit (`@ever-jobs/common`, `http/crawl/sitemap.ts`)

- `parseSitemapXml` is a small allocation-light scanner (no DOM): `<urlset>` and
  `<sitemapindex>`, namespaces by local name, only the entry's direct `<loc>` /
  `<lastmod>` (so `<image:loc>` is never taken for the page), CDATA, the five XML
  entities and numeric references, comments, PIs, DOCTYPE; garbage yields empty lists.
- `parseLastmod` accepts W3C Datetime, the space-separated `YYYY-MM-DD HH:MM:SS` Softy
  emits, and RFC 1123 dates; a value without a zone is read as UTC; impossible dates
  are rejected.
- `fetchSitemap(http, url, options)` walks `<sitemapindex>` breadth-first, each
  document once, through the given `HttpClient` (so pacing, identity and back-off
  apply); gzip is detected by magic bytes whatever the URL says; plain-text sitemaps
  are accepted; relative `loc`s resolve against the document; duplicates keep the
  newest `lastmod`. Options: `maxUrls` (50,000), `maxDepth` (2), `maxSitemaps` (20),
  `maxBytes` (10 MB per decompressed document), `filter`, `sortByLastmod`, `onError`
  (nested failures are reported and skipped; root failures throw), `requestConfig`,
  `nestedScope` (`same-host` | `same-domain` (default) | `any`).
- `BoundedTtlCache` gained `has`, `prune` and an optional per-entry TTL.

### 6.3 Configuration

| Variable | Default | Accepted |
|---|---|---|
| `SOFTY_MAX_LIST_PAGES` | 50 | integer ≥ 1 |
| `SOFTY_MAX_DETAIL_FETCHES` | 100 | integer ≥ 0 |
| `SOFTY_DETAIL_CACHE_MAX` | 500 | integer ≥ 0 (0 disables the cache) |
| `SOFTY_DETAIL_CACHE_TTL_MS` | 21600000 (6 h) | integer ≥ 0 (0 = no expiry) |
| `SOFTY_LASTMOD_AS_DATE_POSTED` | true | `true/false/1/0/yes/no/on/off` |
| `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` | 3 | integer ≥ 0 (0 = never stop early) |

Pacing and discovery are crawl-policy fields (Spec 1690): manifest
`{ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 }`,
overridable per operator site/host and per request.

### 6.4 Verification (2026-09-25)

- 228 unit tests green (`softy.service`, `softy.parser`, `softy.policy`,
  `crawl-sitemap`, `crawl-ttl-cache`), against 8 small synthetic fixtures
  (`sitemap.xml`, `sitemap-index.xml`, listing pages 1–2 and an empty one, a detail
  page, a legacy index and a legacy detail page). A fake client asserts at most one
  request in flight.
- The live e2e spec was reduced (tiny `resultsWanted`) and not run by the lane, so as
  not to send extra traffic to `softy.pro`.
- **Live wire proof** (verification lane, 5 requests, captured after the UA
  interceptor):
  - `auto` (sitemap): `sitemap.xml` then three `/offers/{ID}` pages, all 200, all with
    the Ever Jobs default UA and no `sec-ch-ua` headers, never more than one request in
    flight, gaps between request starts 1003.1 / 1010.1 / 1006.4 ms; 3 jobs, each with
    title, `/offers/{ID}` URL, location and a 3,878 / 6,278 / 6,705-character
    description; 3.6 s wall time.
  - `listing` with `descriptionDepth: board`, 5 s later: one request
    (`/offers?page=1`, 200), same UA, 3 jobs with card-level descriptions.
