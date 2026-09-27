# Spec: 1720 — List mode (no keyword) and source selection by category

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1720                                     |
| Slug           | list-mode-site-categories                |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-24                               |
| Last updated   | 2026-09-26                               |
| Supersedes     | (none)                                   |
| Related specs  | 5026, 5082, 1721, 1722, 1723             |

## 1. Problem Statement

The main consumer of `POST /api/jobs/search` (a corpus builder) runs a 15-minute keyword
rotation and stores only the first page of each answer. Two gaps make it impossible to ask
Ever Jobs for "everything you can list":

1. **There is no defined keyword-less mode.** `searchTerm` is optional in `ScraperInputDto`, but
   the orchestrator passes whatever arrived straight to every plugin. An omitted term and `""`
   mostly work by accident (most plugins guard with `if (input.searchTerm)`), but:
   - a whitespace-only term (`"  "`) is truthy, so every filter-style plugin keeps only
     postings whose text contains two consecutive spaces — i.e. almost nothing;
   - `null` passes `@IsOptional()` and is printed as `term="null"` / `term="undefined"` in the
     request log, and a plugin that interpolates the term would build a URL with `null` in it;
   - `""` and an omitted term produce **different cache keys** for the same work;
   - keyword-in-path plugins (Bayt builds `/jobs/<term>-jobs/`, Naukri a `<term>-jobs` SEO key)
     send a malformed request instead of admitting they need a keyword.
2. **There is no way to pick sources by kind.** Callers can name sites one by one (`siteType`)
   or take the whole non-ATS catalogue (~1 680 plugins, 1 560 of them `company`). A client that
   wants only job boards, or only company career pages, has to maintain its own site list.

## 2. Goals

- A single, documented **list mode**: a search without a usable keyword returns every job each
  selected source can list without one, up to `resultsWanted` **per source**.
- A source that needs a keyword returns an empty result in list mode instead of a broken
  request, and never takes the fan-out down.
- An optional `siteCategories` filter over plugin metadata categories.

## 3. Non-Goals

- Auditing the behaviour of all ~1 860 plugins without a keyword. Plugins that already guard
  with `if (input.searchTerm)` (847 of them) or `?? ''` keep working unchanged; only plugins
  proven to build a malformed request are flagged.
- Changing the default fan-out when neither `siteType` nor `siteCategories` is given (Q-OOM-1
  stands: the corpus builder wants breadth).
- Changing the result order (site, then date). Streaming (Spec 1721) makes page 1 irrelevant.

## 4. Caller Stories

> As a **corpus builder**, I want to omit `searchTerm` and receive every listable job, so that
> my corpus is not limited to whatever my keyword rotation happens to match.

> As an **operator**, I want the request log to say `term=<none>` rather than
> `term="undefined"`, so that list-mode traffic is visible at a glance.

> As a **client**, I want `siteCategories: ["job-board","remote"]`, so that I can choose the kind
> of source without hard-coding 30 site ids.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `searchTerm` omitted, `null`, `""` or whitespace-only means **list mode**. The orchestrator normalises it to *absent* (`undefined`) before caching, logging and dispatch; a non-empty term is trimmed. `googleSearchTerm` is normalised the same way. | must |
| FR-2  | In list mode no keyword filter is applied anywhere in the orchestrator; every selected source is called with `searchTerm === undefined` and returns up to `resultsWanted` jobs. | must |
| FR-3  | Plugin metadata gains `requiresSearchTerm?: boolean`. In list mode a flagged plugin is **not dispatched**; it contributes an `empty` per-source diagnostic whose detail says it needs a keyword, and a debug log line. Flagged at launch: `bayt`, `naukri` (later `stepstone`, `careeronestop`). Bayt was unflagged on 2026-09-26: since Spec 1710 an empty term lists its `/en/<market>/jobs/` page. | must |
| FR-4  | A plugin that throws when the term is absent is isolated by the existing fan-out (its row carries the classified error); other sources' jobs are returned. No input handed to a plugin contains the strings `"undefined"` or `"null"` as a term. | must |
| FR-5  | The controller request log prints `term=<none>` in list mode and `term="<term>"` otherwise; the GraphQL resolver does the same. | must |
| FR-6  | `ScraperInputDto.siteCategories?: string[]`, values from `job-board, niche, regional, remote, government, freelance, company, ats`. Unknown values → HTTP 400 (DTO validation) and `BadRequestException` from the service for direct callers (GraphQL, CLI). | must |
| FR-7  | If `siteType` or `companyDomain` resolves to at least one site, it wins and `siteCategories` is ignored (debug log). Otherwise the default fan-out computed exactly as today (non-ATS when no `companySlug`; ATS when `companySlug` is set) is restricted to plugins whose `category` is in `siteCategories`. ATS plugins therefore still require `companySlug`. | must |
| FR-8  | With neither `siteType` nor `siteCategories`, the selection is byte-for-byte today's. | must |
| FR-9  | `siteCategories` participates in the cache key (it changes the result set). | must |
| FR-10 | GraphQL `SearchJobsInput.searchTerm` becomes nullable (list mode) and gains `siteCategories`. | should |
| FR-11 | (review fix, 2026-09-25) A plugin that substitutes a **default keyword** when none is given (`input.searchTerm ?? 'developer'`) or puts the term in a URL **path segment** (`/{userId}/{keyword}/{location}/…` → `//` when absent) is not listing — it is a keyword search or a malformed request. Such plugins are flagged `requiresSearchTerm`: `stepstone` (falls back to searching "developer"), `careeronestop` (keyword is a path segment of its v2 API). The static guard (FR-T8) additionally fails on (a) `searchTerm ?? '<non-empty literal>'` / `\|\| '<literal>'` outside a log call and (b) a term-derived value interpolated as a whole path segment, in any plugin **not** flagged `requiresSearchTerm`. | must |
| FR-12 | (review fix) Server-side bounds on result size, applied to every entry point (JSON, CSV, NDJSON, GraphQL, CLI) inside `JobsService` and before the controller's cache lookup: `EVER_JOBS_MAX_RESULTS_WANTED` (default **1000**, `0` = no cap) clamps `resultsWanted` per source, with a warning log; `EVER_JOBS_MAX_JOBS_PER_SEARCH` (default **40000** since FR-13, was 100000; `0` = no cap) stops **starting** sources once the fan-out has collected that many raw jobs (in-flight sources finish, exactly like the deadline; skipped sources get a `per_source` row whose detail names the variable, and a warning log). Peak raw jobs per request are therefore bounded by `MAX_JOBS_PER_SEARCH + concurrency × MAX_RESULTS_WANTED`. | must |
| FR-13 | (second review, 2026-09-25) Memory of list mode. (a) `EVER_JOBS_CACHE_MAX_JOBS` (default **5000**; `0` = **never cache**; unset/blank/junk = default): a raw fan-out with more jobs is served but NOT written to the search cache (REST and GraphQL), with a log line — in the in-process LRU a 20–30 k list-mode set would pin every job, descriptions included, for the whole TTL. (b) The default `EVER_JOBS_MAX_JOBS_PER_SEARCH` drops to **40000** until the per-job footprint is measured in a pod. (c) Documented (corrected 2026-09-26, third review — the first wording offered pagination as an equal alternative): list mode means NDJSON (`?format=ndjson`, the whole result of one crawl streamed line by line). Pagination is **not** a substitute: every `?paginate=true` page is a separate search request, and the pages come from one crawl only while the search cache holds its raw set — the cache enabled (`ENABLE_CACHE=true`, off by default) **and** the raw set within `EVER_JOBS_CACHE_MAX_JOBS` (and the crawl complete, Spec 1721 FR-20, and the entry not yet expired or evicted); otherwise every page re-runs the whole fan-out and pages can disagree (a job on two pages or on none, `count` changing between pages). A catalogue-wide list-mode crawl (20–30 k raw jobs) is above the default 5000, so its pages are never cached. Unpaginated JSON (and CSV) builds the whole body as one string and is capped only by the job ceiling. README, `.env.example` and the OpenAPI description say so. | must |

## 6. Non-Functional Requirements

| ID    | Requirement | Target |
| ----- | ----------- | ------ |
| NFR-1 | Category resolution cost | one pass over `registry.listSources()` per request (≈1 860 entries, < 1 ms) |
| NFR-2 | No new network calls | list mode must not add requests; flagged plugins remove some |

## 7. Contracts

### 7.1 API / Interface

```ts
// @ever-jobs/models
export const SITE_CATEGORIES = [
  'job-board', 'niche', 'regional', 'remote', 'government', 'freelance', 'company', 'ats',
] as const;
export type SiteCategory = (typeof SITE_CATEGORIES)[number];

class ScraperInputDto {
  siteCategories?: SiteCategory[]; // @IsIn(SITE_CATEGORIES, { each: true })
}

// @ever-jobs/plugin
interface IPluginMetadata {
  category: PluginCategory;        // PluginCategory = SiteCategory
  requiresSearchTerm?: boolean;    // new, default false
}

// apps/api — JobsService
searchJobsWithDiagnostics(input, options?: { onProgress?: (p: SearchProgress) => void })
```

### 7.2 Errors

| Case | Response |
| ---- | -------- |
| Unknown `siteCategories` value on REST | 400 from `ValidationPipe` naming the allowed values |
| Unknown value via GraphQL / direct service call | `BadRequestException` with the same message |

## 8. Test Plan

- Unit (`jobs.service.list-mode.spec.ts`): omitted / `null` / `""` / whitespace term all reach
  plugins as `undefined`; a term is trimmed; a flagged plugin is not called and reports `empty`;
  a plugin that throws on an absent term does not take down the fan-out; no plugin receives
  `"undefined"`/`"null"`; category selection incl. `companySlug` + `ats`, `siteType` wins,
  unknown category → `BadRequestException`; no-filter default unchanged.
- Unit (`search-input.spec.ts`): normaliser + log formatter.
- DTO validation: unknown category fails `class-validator` with the allowed list.
- Controller: log line prints `term=<none>`; `""` and omitted share a cache key.
- Static guard (`list-mode-source-audit.spec.ts`): no plugin interpolates a bare
  `input.searchTerm` into a template literal or string concatenation.
- Review fixes: the guard's red controls catch `?? 'developer'`, `|| "jobs"` and a
  term-derived path segment, and accept the same spellings inside a logger call or in a plugin
  flagged `requiresSearchTerm`; the real tree passes; `stepstone` and `careeronestop` metadata
  carry the flag. `search-config.spec.ts`: both caps' env parsing. Service: `resultsWanted`
  clamped before dispatch; the job ceiling stops starting sources and reports them; `0`
  disables both. Controller: the clamp happens before the cache key is built.
- FR-13: `search-config.spec.ts` — `resolveCacheMaxJobs` default / floor / `0` / junk,
  `isCacheableJobCount` at and above the limit and with `0`, `configuration().cache.maxJobs`, the
  40000 ceiling default. Controller (`jobs.controller.list-mode.spec.ts`): a set at the limit is
  cached, one above is served but not cached (and logged), `0` never caches, the 5000 default.
  Resolver (`jobs.resolver.cache-bound.spec.ts`): the same three cases. Making the bound always
  cache fails 6 of them.

## 9. Open Questions

- Q-100 — which plugins to flag `requiresSearchTerm`, and whether a flagged plugin's diagnostic
  should be `empty` or `bad_input`. Default: flag only plugins whose request is provably
  malformed without a term (`bayt`, `naukri`); report `empty` with an explanatory detail.
  Addenda (review): `stepstone` and `careeronestop` flagged (FR-11); the result-size caps'
  defaults (FR-12).

## 10. Decisions

- D-01 — Normalise once, in `JobsService`, *and* in the controller before the cache lookup, so
  every entry point (REST, GraphQL, CLI, tests) gets the same semantics and `""`/omitted share a
  cache entry. The DTO is not given a `@Transform` because direct service callers never run it.
- D-02 — Keyword-required plugins are a **metadata fact**, not a naming convention (same shape
  Q-OOM-1 proposed for `requiresCompanySlug`).
- D-03 — `siteCategories` narrows the *default* selection rather than replacing it, which is
  what keeps "ATS still needs a slug" true without a special case.
- D-04 (FR-13) — **Skip the cache write, do not truncate the answer.** A large set is still
  returned in full; only the copy that would outlive the request is refused. `0` means "never
  cache" for this variable (the one place it does not mean "no cap"), because "cache sets of any
  size" is exactly the memory hazard FR-13 removes; a deployment that wants it sets a large
  number explicitly.

## 11. References

- `apps/api/src/jobs/jobs.service.ts`, `apps/api/src/jobs/search-input.ts`
- `packages/plugin/src/interfaces/plugin-metadata.interface.ts`
- `docs/questions.md` Q-OOM-1, Q-100
