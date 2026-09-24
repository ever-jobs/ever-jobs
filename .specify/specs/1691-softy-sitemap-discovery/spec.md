# Spec: 1691 — Softy: sitemap discovery, paginated listing, polite detail fetches

| Field | Value |
|---|---|
| Spec ID | 1691 |
| Slug | softy-sitemap-discovery |
| Status | Implemented |
| Owner | agent |
| Created | 2026-09-24 |
| Last updated | 2026-09-24 |
| Supersedes | — |
| Related specs | 374 (source-ats-softy), 1690 (crawl policy) |

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
