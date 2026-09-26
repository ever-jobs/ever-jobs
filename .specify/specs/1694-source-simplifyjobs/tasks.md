# Tasks: 1694 — Source plugin: Simplify new-grad and internship lists

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Parsing and cache

- [x] T01 — Package scaffold (`package.json`, `tsconfig.json`, `src/index.ts`, module, constants, types).
  - **Files:** `packages/plugins/source-simplifyjobs/{package.json,tsconfig.json,src/index.ts,src/simplifyjobs.module.ts,src/simplifyjobs.constants.ts,src/simplifyjobs.types.ts}`
  - **Acceptance:** package `@ever-jobs/source-simplifyjobs`, `main: src/index.ts`; tsconfig extends `../../../tsconfig.base.json`; the plugin type-checks.
- [x] T02 — Byte-level array scanner and row compaction.
  - **Files:** `src/simplifyjobs.feed-parser.ts`, `__tests__/simplifyjobs.feed-parser.spec.ts`
  - **Acceptance:** identical elements for any chunking (1, 2, 3, 5, 7, 64 bytes; mid-string, mid-escape, mid-UTF-8); BOM tolerated; empty / non-array / HTML / truncated / trailing data / unbalanced bodies rejected; per-element and total caps; inactive, hidden, URL-less (incl. `javascript:`), untitled and company-less rows dropped; missing `is_visible` kept; `N/A` terms removed; `source` field and degrees never kept; no string longer than one row decoded or parsed; 8k live rows of a ~15 MB body retained in < 6 MB (measured ~3.8 MB). 46 tests.
- [x] T03 — Conditional-GET cache.
  - **Files:** `src/simplifyjobs.feed-cache.ts`, `__tests__/simplifyjobs.feed-cache.spec.ts`
  - **Acceptance:** no request inside the TTL; `If-None-Match` after it; 304 keeps rows; 200 replaces rows and ETag; `max-age` honoured and clamped to 1–30 min; one in-flight request shared; stale copy (< 6 h) served on error, rethrow otherwise; 60 s error backoff; bounded keys. 13 tests.

## Phase 2 — Mapping and filters

- [x] T04 — robots.txt parser and matcher.
  - **Files:** `src/simplifyjobs.robots.ts`, `__tests__/simplifyjobs.robots.spec.ts`
  - **Acceptance:** own group over `*`; grouped user-agent lines; longest match wins, allow wins a tie; `*` and `$`; comments and unknown keys ignored. 8 tests.
- [x] T05 — Mapper: location pre-normaliser, category, sponsorship, ATS, posted time, row → DTO.
  - **Files:** `src/simplifyjobs.mapper.ts`, `__tests__/simplifyjobs.mapper.spec.ts`
  - **Acceptance:** `NYC`/`SF`/`Bay Area`/`DC` aliases; 4-part and 3-part labels keep the state; `Haifa, Israel, IL` and `Chennai, TN, IN` untouched; raw label kept as `text`; Cambridge UK/MA and Birmingham AL/UK parsed right; category order (`Data Science, AI & Machine Learning` → `AI/ML/Data`, `Quantitative Finance` → `Quant`); ATS host table; midnight-aligned date → `day`/`date`, else `exact`/`timestamp`; no description. 90 tests.
- [x] T06 — Query: routing, search, location, freshness, merge, dedup, paging.
  - **Files:** `src/simplifyjobs.query.ts`, `__tests__/simplifyjobs.query.spec.ts`
  - **Acceptance:** routing for every `JobType` (incl. `PERMANENT`, `APPRENTICESHIP` → none); accent folding; word-start matching (`uk` ≠ `Milwaukee`); `New York` ↔ `NYC`, `United Kingdom` ↔ `London, UK`, `Canada` ↔ `London, ON`; exact cut-off boundary and the midnight rule; tie-breaks; URL dedup keeps the newest; lazy `selectPage` equals filter-all → merge → dedup → slice for every offset/limit and stops once the page is full. 57 tests.

## Phase 3 — Service

- [x] T07 — Service and module.
  - **Files:** `src/simplifyjobs.service.ts`, `__tests__/simplifyjobs.service.spec.ts`, `__tests__/fixtures/{newgrad,internships}-listings.json`
  - **Acceptance:** DI with and without a clock provider; mapping; filtering; `searchTerm`, `location`, `isRemote`, `hoursOld`; routing with the two lists fetched strictly one after the other; cross-list dedup; paging and the DTO defaults not filtering; cache, 304, `max-age`, robots read once, single-flight; partial / all-failed / timeout / blocked / invalid JSON / stale / expired / backoff / row-mapping failure; robots disallow and unreachable; request shape (bytes, size cap, 304 accepted), honest UA, redirect pin, spacing; env overrides and invalid values; staleness warning. 65 tests.
- [x] T08 — Live E2E, gated by `RUN_NETWORK_E2E=1`.
  - **Files:** `__tests__/simplifyjobs.e2e-spec.ts`
  - **Acceptance:** both lists: 3 well-formed jobs, no diagnostics; `INTERNSHIP`: 3 internships. Passed live on 2026-09-25 (3 requests: robots.txt + two lists; 19,944 / 17,190 rows, 3,091 / 4,604 live).
- [x] T09 — Spec, plan and tasks (this folder).

## Integration (outside this lane)

- [x] T10 — Register: `SIMPLIFYJOBS = 'simplifyjobs'` in `packages/models/src/enums/site.enum.ts`; `SimplifyJobsModule` in `packages/plugins/index.ts` / `ALL_SOURCE_MODULES`; path alias `@ever-jobs/source-simplifyjobs` in `tsconfig.base.json`; `moduleNameMapper` in `jest.config.js`; then replace `SIMPLIFYJOBS_SITE`'s cast with `Site.SIMPLIFYJOBS` and the tests' relative imports with the alias.
- [x] T11 — `docs/index.md` row and `docs/log.md` entry.

## Notes

- Fixtures are synthetic (invented employers) with the real field names, types, epoch-second dates and label formats.
- Every file is LF with no BOM.

Integration 2026-09-25: registered as `Site.SIMPLIFYJOBS` / `SimplifyJobsModule`; the specs use `Site.SIMPLIFYJOBS` and the package alias; `docs/index.md` / `docs/log.md` rows added.
