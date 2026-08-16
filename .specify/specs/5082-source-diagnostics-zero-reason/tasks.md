# Tasks: 5082 — Per-source zero-jobs reason diagnostics

- [x] T01 — `packages/models`: add `dtos/scrape-diagnostics.dto.ts` (`ScrapeReason`, `ScrapeDiagnostics`, `SourceDiagnosticDto`, `classifyScrapeError`, `looksLikeChallenge`); export from `dtos/index.ts`. Acceptance: importable from `@ever-jobs/models`.
- [x] T02 — `JobResponseDto`: optional `diagnostics?: ScrapeDiagnostics`, set via constructor arg. Acceptance: existing `new JobResponseDto(jobs)` calls unchanged.
- [x] T03 — `source-ats-gusto-hosted`: real-message log + diagnostics on catch; `blocked`/`empty` on zero postings; `bad_input` on no slug. Acceptance: launch-error test → `browser_unavailable`.
- [x] T04 — `source-company-desktopmetal`: same catch/diagnostics treatment. Acceptance: launch-error test → `browser_unavailable`.
- [x] T05 — `source-company-truemetalsupply`: same catch/diagnostics treatment. Acceptance: launch-error test → `browser_unavailable`.
- [x] T06 — `JobsService.searchJobsWithDiagnostics`; `searchJobs` delegates; build `perSource`. Acceptance: unit tests for ok/empty/rejected reasons.
- [x] T07 — `JobsController`: include `per_source` on standard + paginated JSON; `[]` on cache hit.
- [x] T08 — Unit tests: `classifyScrapeError`, `looksLikeChallenge`.
- [x] T09 — Docs: `docs/index.md` + `docs/log.md`; `npm run lint:docs` clean; `tsc --noEmit` clean.
- [x] T10 — Extend breaker-neutral diagnostics across all MakeDeeply-touched plugins (Specs 5001+). Return `new JobResponseDto([], classifyScrapeError(err))` from each outer/fetch catch instead of a bare empty; keep genuine zero boards as `empty`; never throw (shared-ATS breaker is keyed by `site`, so throwing would open the circuit for healthy co-tenants). Covers 18 `source-company-*`, 22 `source-ats-*`, and `source-notion-pages`. Acceptance: touched plugins' jest suites green.
- [x] T11 — Control-flow plugins that fall through to a final return (workday, breezyhr, rippling, oracle, successfactors) capture the classified diagnostic into a scoped variable and attach it only when the result is empty; adp emits `bad_input`/`fetch_error` on its guard returns.
- [x] T12 — `classifyScrapeError` folds in `Error.code` and non-`Error` `name`/`code` fields so axios `ETIMEDOUT`/`ENOTFOUND`-style rejections classify correctly.

## Non-goals

- The ~1,500 upstream-inherited plugins are intentionally left untouched; this scope is limited to plugins MakeDeeply materially authored/reworked (Specs 5001+).
