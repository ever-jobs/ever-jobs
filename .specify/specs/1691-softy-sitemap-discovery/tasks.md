# Tasks: 1691 — Softy: sitemap discovery, paginated listing, polite detail fetches

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md)

## Phase 1 — Common toolkit

- [x] T01 — Sitemap parser and fetcher
  - **Files:** `packages/common/src/http/crawl/sitemap.ts`,
    `packages/common/__tests__/crawl-sitemap.spec.ts`
  - **Acceptance:** `parseSitemapXml` handles urlset, sitemapindex, prefixed
    namespaces, CDATA, entities, comments/PIs/DOCTYPE, ignores `<image:loc>`, returns
    empty lists on garbage; `parseLastmod` accepts W3C, `YYYY-MM-DD HH:MM:SS`, RFC 1123,
    zone-less = UTC, rejects impossible dates; `fetchSitemap` BFS with cycle guard,
    `maxDepth` 2, `maxSitemaps` 20, `maxUrls` 50,000, `maxBytes` 10 MB, gzip by magic
    bytes, plain-text sitemaps, relative `loc` resolution, dedup keeping newest,
    `nestedScope` (default `same-domain`), root errors throw / nested errors to
    `onError`; stub signatures kept.
  - **Estimate:** 1 day

- [x] T02 — Bounded TTL cache
  - **Files:** `packages/common/src/http/crawl/ttl-cache.ts`,
    `packages/common/__tests__/crawl-ttl-cache.spec.ts`
  - **Acceptance:** LRU bound, TTL expiry with injectable clock; `get`, `set`,
    `delete`, `clear`, `size` kept; `has`, `prune()` and a per-entry TTL added.
  - **Estimate:** 0.25 day

## Phase 2 — Softy parser and config

- [x] T03 — Parser for current and legacy markup
  - **Files:** `packages/plugins/source-ats-softy/src/softy.parser.ts`,
    `packages/plugins/source-ats-softy/__tests__/softy.parser.spec.ts`,
    `packages/plugins/source-ats-softy/__tests__/fixtures/*`
  - **Acceptance:** listing cards (title, city, "Mise en ligne le" date, contract and
    schedule badges, `/offers/{ID}` URL) and pagination links; detail page (h1,
    location, badges, `.prose` sections, og tags); legacy `/offres` index and
    `/offre/{ID}-{slug}` detail; optional locale segment; contract badge not confused
    with skill badges; 8 small synthetic fixtures.
  - **Estimate:** 1 day

- [x] T04 — Config from constants + env
  - **Files:** `packages/plugins/source-ats-softy/src/softy.config.ts`,
    `softy.constants.ts`, `softy.types.ts`, `index.ts`
  - **Acceptance:** six `SOFTY_*` variables (spec §6.3) read per scrape, invalid values
    warned once through the Nest `Logger`; `SOFTY_CRAWL_POLICY`,
    `SOFTY_BROWSER_USER_AGENT` and path/limit constants exported; every old export
    kept (legacy paths documented as legacy).
  - **Estimate:** 0.25 day

## Phase 3 — Softy service

- [x] T05 — Discovery modes and sequential detail fetches
  - **Files:** `packages/plugins/source-ats-softy/src/softy.service.ts`,
    `packages/plugins/source-ats-softy/__tests__/softy.service.spec.ts`
  - **Acceptance:** `sitemap`, `listing`, `auto` (fallback on missing/empty/unparseable
    sitemap; listing for `descriptionDepth: board` or a short detail budget); explicit
    `sitemap` keeps the budget and reports `partial`; `descriptionDepth` board /
    detail-25 / detail-all; `for … await` only — a fake client asserts ≤ 1 request in
    flight; `resultsWanted` + `offset`; pagination stops at the wanted count, a page
    with no new cards, no later page link, or `SOFTY_MAX_LIST_PAGES`.
  - **Estimate:** 1 day

- [x] T06 — Detail cache, dates, failure handling, own scrape context
  - **Files:** as T05
  - **Acceptance:** cache keyed `url|lastmod` (sitemap) or `url` (listing), size and TTL
    from config, `clearDetailCache()`; `datePosted` from the card, else `lastmod` unless
    `SOFTY_LASTMOD_AS_DATE_POSTED=false`; 4xx/unknown host → empty, robots refusal →
    missing, 5xx/network → partial with diagnostic, 429/abort/crawl-policy refusal stops
    the scrape keeping the partial result, stop detail fetches after
    `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES`; outside a scrape context the plugin opens
    one with its policy and the caller's `crawl`.
  - **Estimate:** 0.5 day

- [x] T07 — Manifest crawl policy and identity
  - **Files:** `softy.service.ts`, `softy.constants.ts`,
    `packages/plugins/source-ats-softy/__tests__/softy.policy.spec.ts`
  - **Acceptance:** `@SourcePlugin({ crawl: { rateLimitScope: 'domain',
    maxConcurrentPerHost: 1, minIntervalMs: 1000 } })`; the Chrome/129 UA is only
    declared (sent in UA mode `plugin`); operator and caller layers can override.
    B5 total: 228 unit tests green; type-check clean for lane files.
  - **Estimate:** 0.25 day

- [x] T08 — Reduced live e2e spec
  - **Files:** `packages/plugins/source-ats-softy/__tests__/softy.e2e-spec.ts`
  - **Acceptance:** tiny `resultsWanted`; not run by the lane (no extra traffic).
  - **Estimate:** 0.1 day

- [x] T09 — Live wire proof (verification lane)
  - **Files:** none in the repo
  - **Acceptance:** 5 live requests; sitemap mode 1 in flight, ~1 s gaps
    (1003.1 / 1010.1 / 1006.4 ms), honest UA, no client hints, 3 complete jobs in 3.6 s;
    listing/board mode 1 request. See spec §6.4.
  - **Estimate:** 0.25 day

## Notes

- Tests were written alongside each task against synthetic fixtures; the only live
  traffic was the 5-request wire proof.
- Files kept LF with no BOM, as the originals.
