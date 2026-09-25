# Tasks: 1720 — List mode (no keyword) and source selection by category

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1720       |
| Status       | done       |
| Last updated | 2026-09-25 |

- [x] T1 — `SITE_CATEGORIES` / `SiteCategory` / `isSiteCategory` in `@ever-jobs/models`; `PluginCategory` aliases it. Acceptance: the eight categories in plugin metadata today are exactly the allowed set.
- [x] T2 — `ScraperInputDto.siteCategories` with `@IsIn(..., { each: true })`. Acceptance: `validate()` rejects `["boards"]` with a message listing the allowed values; accepts `["job-board","company"]`.
- [x] T3 — `requiresSearchTerm` on `IPluginMetadata`; flag `bayt` and `naukri`. Acceptance: both plugins' metadata carries the flag.
- [x] T4 — `search-input.ts` helpers. Acceptance: `undefined`, `null`, `""`, `"   "` → `undefined`; `"  node  "` → `"node"`; `describeTerm` → `<none>` / `"node"`.
- [x] T5 — `JobsService` list mode: normalise, partition flagged plugins, `empty` diagnostic, debug log. Acceptance: flagged plugin never called; unflagged plugins called with `searchTerm === undefined`; a thrower is isolated.
- [x] T6 — `JobsService` categories: narrow the default selection; `siteType`/`companyDomain` wins; `companySlug` keeps ATS semantics; unknown → `BadRequestException`. Acceptance: unit tests for each branch; no-filter selection unchanged.
- [x] T7 — Controller + resolver: normalise before cache, `term=<none>` log, GraphQL `siteCategories` + nullable `searchTerm`. Acceptance: controller test asserts log text and shared cache key for `""`/omitted.
- [x] T8 — Static guard over `packages/plugins/*/src` for bare `input.searchTerm` interpolation. Acceptance: passes on the current tree; fails on a planted sample (red control in the test itself).
- [x] T9 — Docs: README "Getting ALL jobs" + "Choosing sources by category", OpenAPI descriptions, `docs/log.md`, `docs/index.md`, Q-100.

Review fixes (2026-09-25):

- [x] T10 — Flag `stepstone` + `careeronestop`; extend the static guard (keyword fallback literal, term as a path segment; exemptions for log calls and flagged plugins). Acceptance: red controls in the test; the real tree passes; Q-100 addendum.
- [x] T11 — `EVER_JOBS_MAX_RESULTS_WANTED` + `EVER_JOBS_MAX_JOBS_PER_SEARCH` (config resolvers, service clamp + ceiling, controller clamp before the cache key). Acceptance: config, service and controller tests; README/.env.example document both with the memory arithmetic.

Second review (2026-09-25):

- [x] T12 — `EVER_JOBS_CACHE_MAX_JOBS` (default 5000, `0` = never) on the REST and GraphQL cache writes; `EVER_JOBS_MAX_JOBS_PER_SEARCH` default 40000; README / `.env.example` / OpenAPI say list mode should use NDJSON or pagination and that unpaginated JSON is capped only by the job ceiling (FR-13). Acceptance: config, controller and resolver tests; an always-cache mutation fails 6.
