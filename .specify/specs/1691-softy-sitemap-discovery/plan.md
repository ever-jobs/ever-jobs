# Plan: 1691 — Softy: sitemap discovery, paginated listing, polite detail fetches

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | [spec.md](./spec.md)               |
| Created      | 2026-09-24                         |
| Last updated | 2026-09-25                         |

## 1. Approach

Two independent problems meet in one plugin. The Softy operator asked for polite
traffic (one request at a time per site, ~1 req/s, an honest UA, sitemap discovery),
and a polite live check found the plugin broken on the current markup (`/offres` →
`/offers`, `/offers/{ID}` links without slug, pagination). Spec 1690 solves the
politeness part globally — pacing, identity, back-off and discovery selection are
crawl-policy fields — so this spec only has to (a) declare Softy's policy in its
manifest, (b) fetch detail pages sequentially, and (c) rebuild discovery on the
current surface.

Discovery gets three modes, selected by the resolved policy's `discovery` field so a
search caller, an operator (per site or per `*.softy.pro` host) or the environment can
choose: `sitemap` (the operator's preferred path: one small XML file, then only the
detail pages needed, newest first), `listing` (paginated `/offers?page=N`, with the
legacy `/offres` parser kept as a fallback) and `auto` (sitemap, falling back to
listing; listing directly when no detail pages are wanted or the detail budget is too
small for the request).

The sitemap parsing and fetching is generic and belongs in `@ever-jobs/common`
(`http/crawl/sitemap.ts`), next to a small bounded TTL cache, so other plugins can
adopt sitemap discovery later. Detail pages are cached by `url|lastmod`, so a repeat
search only re-reads offers whose `lastmod` changed — the cheapest possible repeat
for the operator's server.

Parsing moved out of the service into `softy.parser.ts` (pure functions over HTML) and
the tunables into `softy.config.ts` (constants overridable by `SOFTY_*` variables, read
per scrape), so the service is orchestration only and each part is unit-testable
against small synthetic fixtures.

## 2. Phases

### Phase 1 — Common toolkit

- Goal: generic sitemap fetch/parse and a bounded TTL cache.
- Deliverables: `packages/common/src/http/crawl/sitemap.ts`, `ttl-cache.ts` (stub
  signatures kept, options only gained optional fields).
- Exit criteria: urlset + sitemapindex + namespaces + CDATA + gzip + plain text +
  depth/size/count bounds + nested-scope tests green.

### Phase 2 — Softy parser and config

- Goal: current and legacy markup parsed without network.
- Deliverables: `softy.parser.ts`, `softy.config.ts`, constants, types, fixtures.
- Exit criteria: listing cards, pagination, detail page, legacy index/detail parse
  from fixtures; invalid env values warned once and ignored.

### Phase 3 — Softy service

- Goal: discovery modes, sequential detail fetches, cache, failure handling, policy.
- Deliverables: rewritten `softy.service.ts`; manifest `crawl`; reduced e2e spec.
- Exit criteria: every mode, `auto` fallback, `descriptionDepth`, ≤ 1 request in flight,
  `resultsWanted`/`offset`, cache hit/miss, legacy fallback, tenant resolution
  unchanged, 228 unit tests green; live wire proof by the verification lane.

## 3. Packages Touched

| Package                        | Change                                |
| ------------------------------ | ------------------------------------- |
| `packages/common`              | `http/crawl/sitemap.ts`, `http/crawl/ttl-cache.ts` implemented |
| `packages/plugins/source-ats-softy` | service rewritten; new `softy.parser.ts`, `softy.config.ts`; constants/types/index extended (every old export kept); fixtures and tests |
| `packages/plugin`              | (no change — `IPluginMetadata.crawl` came with the Spec 1690 contract) |
| `packages/models`              | (no change — `descriptionDepth` already existed) |

## 4. Dependencies

| Library                | Version  | Rationale                            |
| ---------------------- | -------- | ------------------------------------ |
| `tldts`                | `^7.4.11` | Registrable domain for the sitemap `same-domain` nested scope; justified in [Spec 1690 plan §4](../1690-crawl-policy/plan.md) (already installed via `tough-cookie`). |
| (none new)             | —        | XML is scanned by hand on purpose: a DOM parser would hold several times a 10 MB sitemap in heap, and only `<loc>`/`<lastmod>` are needed. `zlib` (Node built-in) handles gzip. |

## 5. Risks & Mitigations

| Risk                                | Likelihood | Impact | Mitigation                  |
| ----------------------------------- | ---------- | ------ | --------------------------- |
| Softy changes markup again | M | M | Legacy parser kept; `looksLikeCurrentSoftyMarkup` / `hasLegacySoftyLinks` detection; fixtures make a break visible; sitemap mode depends only on `<loc>`/`<lastmod>` |
| 1 req/s makes a large tenant slow inside the 120 s deadline | M | L | Detail budget (`SOFTY_MAX_DETAIL_FETCHES`, `descriptionDepth`), `auto` → listing when the budget is short, the detail cache, and the deadline abort (Spec 1690) |
| A hostile or huge sitemap | L | M | `maxBytes`, `maxUrls`, `maxDepth`, `maxSitemaps`, same-domain nested scope, element depth cap |
| Hammering a struggling server | L | H | Sequential fetches, whole-domain bucket, back-off on 429/`Retry-After`, stop after consecutive detail failures |
| Live e2e traffic | L | L | e2e kept tiny and not run by the lane |

## 6. Rollback Plan

Configuration first: `crawl.discovery=listing` (or `EVER_JOBS_CRAWL_DISCOVERY=listing`,
or operator `sites.softy.discovery`) avoids the sitemap path; the pacing is a crawl
policy, so operators and callers can change it per site/host/request. The old browser
UA is still declared (UA mode `plugin`). Code: revert the Spec 1691 commit; the rest of
Spec 1690 does not depend on it.

## 7. Migration Plan (if applicable)

None: tenant addressing (`companySlug`, `companyUrl`) and every public export are
unchanged. Results change for the better — the pre-1691 plugin returned 0 jobs on the
current markup.

## 8. Open Questions for Plan

None open. Softy-specific defaults (1 in flight per `softy.pro`, 1 s) come straight
from the operator's request.
