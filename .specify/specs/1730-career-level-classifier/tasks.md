# Tasks: 1730 — Career-Level Classifier (intern / new-grad / seniority)

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Contracts

- [x] T01 — `career-level-classifier.interface.ts` (token, `CAREER_LEVELS`, `CareerLevel`,
  `CareerLevelConfidence`, `CareerLevelVerdict`, `CareerLevelInput`, `ICareerLevelClassifier`,
  `isCareerLevel`) + barrel export.
  - **Files:** `packages/models/src/interfaces/career-level-classifier.interface.ts`, `packages/models/src/interfaces/index.ts`
  - **Acceptance:** exported from `@ever-jobs/models`; type-checks.
- [x] T02 — `JobPostDto.careerLevel`; `ScraperInputDto.careerLevels` with `@IsOptional @IsArray @IsIn(CAREER_LEVELS, {each})`.
  - **Files:** `packages/models/src/dtos/job-post.dto.ts`, `packages/models/src/dtos/scraper-input.dto.ts`
  - **Acceptance:** unknown level fails validation (test).

## Phase 2 — Plugin + rules

- [x] T03 — Scaffold `packages/plugins/career-level-classifier` (package.json, tsconfig, index, module, service); alias + jest mapper.
  - **Acceptance:** module binds `CAREER_LEVEL_CLASSIFIER_TOKEN`.
- [x] T04 — Rule engine `classifyCareerLevel` per spec §7.5 (title, structured fields, description, confidence).
  - **Files:** `packages/plugins/career-level-classifier/src/career-level.rules.ts`
- [x] T05 — Rule unit tests (every class, every guard, numerals, ranges, structured, description, confidence, robustness).
  - **Files:** `packages/plugins/career-level-classifier/__tests__/career-level.rules.spec.ts`

## Phase 3 — Evaluation

- [x] T06 — Labelled fixture ≥ 250 titles + structured/description cases.
  - **Files:** `packages/plugins/career-level-classifier/__tests__/fixtures/career-level.fixture.ts`
- [x] T07 — Evaluation test with thresholds + perf test; report script.
  - **Files:** `packages/plugins/career-level-classifier/__tests__/career-level.evaluation.spec.ts`, `packages/plugins/career-level-classifier/src/career-level.evaluation.ts`, `scripts/career-level-eval.ts`
  - **Acceptance:** internship & new_grad precision ≥ 0.95, recall ≥ 0.90, accuracy ≥ 0.90; results pasted in spec §12.

## Phase 4 — Wiring

- [x] T08 — Aggregator: classify after dedup on every path; `careerLevels` filter; `careerLevelFilteredOut`; toggle.
  - **Files:** `apps/api/src/jobs/jobs.aggregator.ts`, `apps/api/src/config/configuration.ts`, `apps/api/src/jobs/jobs.module.ts`
- [x] T09 — Controller + resolver pass `careerLevels`; GraphQL `CareerLevelGql`, `JobPostGql.careerLevel`, `SearchJobsInput.careerLevels`.
  - **Files:** `apps/api/src/jobs/jobs.controller.ts`, `apps/api/src/jobs/jobs.resolver.ts`, `apps/api/src/jobs/gql-types.ts`
- [x] T10 — Wiring tests (aggregator paths, toggle, filter, raw array untouched, resolver pass-through + validation).
  - **Files:** `apps/api/src/jobs/__tests__/jobs.aggregator.career-level.spec.ts`, `apps/api/src/jobs/__tests__/jobs.resolver.spec.ts`

## Phase 5 — Docs

- [x] T11 — README section + request/response/config tables; `.env.example`; `docs/index.md`; `docs/log.md`; `docs/questions.md` Q-105/Q-106.

## Notes

- The CLI (`apps/cli`) calls `JobsService.searchJobs` directly and is out of scope (spec §3).
- NDJSON (contract C3) is implemented by another lane; it inherits `careerLevel` through
  `aggregateRaw` and must pass `careerLevels: input.careerLevels` for the filter.

## Phase 6 — Review fixes (2026-09-25)

- [x] T12 — Season + year is the weakest cue: any explicit level wins; academic / seasonal / start-date / admin guards (Q-105 item 10).
  - **Files:** `packages/plugins/career-level-classifier/src/career-level.rules.ts`, `__tests__/**`
- [x] T13 — "Someone else's title" guard on every executive / director / manager rule; founder's-office function; co-op business guard before the cue.
  - **Files:** as T12
- [x] T14 — Fixture: 32 review regressions; regression gate (`KNOWN_MISSES`), red-controlled.
  - **Files:** `__tests__/fixtures/career-level.fixture.ts`, `__tests__/career-level.evaluation.spec.ts`
- [x] T15 — Cooperative classification: 16-job chunks, yield every 10 ms; `YieldBudget` / `yieldToEventLoop` shared in `@ever-jobs/common`.
  - **Files:** `packages/common/src/cooperative.ts`, `apps/api/src/jobs/jobs.aggregator.ts`, tests
- [x] T16 — `careerLevels` filter fails closed (503) when it cannot be applied (Q-106 follow-up).
  - **Files:** `apps/api/src/jobs/jobs.aggregator.ts`, tests
- [x] T17 — REST cache key excludes `careerLevels` (the resolver already did).
  - **Files:** `apps/api/src/jobs/jobs.controller.ts`, tests
- [x] T18 — At integration with the NDJSON / list-mode lane (`feat/list-mode-ndjson-store`): keep **one**
  public `aggregateRaw` that runs `dedupAndPersist`, then stamps `dedupKey`, then applies career
  level (that lane's `aggregateRawUnkeyed` becomes the body of `dedupAndPersist` + the stamp);
  pass `careerLevels: input.careerLevels` from the single shared controller call for both JSON and
  NDJSON; keep `careerLevels: undefined` in the REST cache key; re-run
  `jobs.aggregator.career-level.spec.ts` together with that lane's tests on the merge.
  - **Done 2026-09-25** (rebase onto `feat/list-mode-ndjson-store`, spec §12.7): git merged the
    aggregator into exactly this order; `runSearch()` and its cache key were fixed by hand.
- [ ] T19 — Optional, at the same integration: when no `careerLevels` filter is set, classify only
  the paginated output window (needs the controller to resolve the window before `aggregateRaw`).

## Phase 7 — Second review fixes (2026-09-25)

- [x] T20 — Every `SearchJobsInput` field carries a class-validator decorator (the global pipe stripped all of them, so the GraphQL filter failed open and `searchTerm` never reached `JobsService`); shared `createGlobalValidationPipe()`; integration suite through the production pipe on GraphQL and REST.
  - **Files:** `apps/api/src/jobs/gql-types.ts`, `apps/api/src/pipes/global-validation.pipe.ts`, `apps/api/src/main.ts`, `apps/api/__tests__/{helpers/create-app.ts,integration/search-input-pipe.integration.spec.ts}`
- [x] T21 — Cap `employmentType` / `jobLevel` (inside `analyzeTitle`), `experienceRange` and quoted reasons.
  - **Files:** `packages/plugins/career-level-classifier/src/career-level.rules.ts`, `__tests__/**`
- [x] T22 — `senior partner` is executive only as a head noun; `partner marketing` is an IC-manager prefix (Q-105 item 8).
  - **Files:** as T21, fixture
- [x] T23 — Season + year alone → `low` confidence (Q-105 item 10).
  - **Files:** as T21
- [x] T24 — Description: first 3,000 visible characters, raw scan bounded at 64 KB; no tag leak at a window edge; linear tag regex.
  - **Files:** as T21
- [x] T25 — Throughput tripwire as a same-process ratio, red-controlled.
  - **Files:** `__tests__/career-level.evaluation.spec.ts`
- [x] T26 — `careerLevels` is a required key of `AggregateRawOptions`; `@ts-expect-error` guard, red-controlled.
  - **Files:** `apps/api/src/jobs/jobs.aggregator.ts`, `apps/api/src/jobs/__tests__/*.spec.ts`
- [x] T27 — CI runs the classifier suites in the gating Feature Plugins job; the career-level API tests run in the blocking Test (Core) job (`npm run test:core`, from Spec 1689), so the separate step was dropped at integration (§12.7).
  - **Files:** `.github/workflows/ci.yml`
- [x] T28 — At the T18 integration, `runSearch()` must pass `careerLevels: input.careerLevels` (now a compile error if it does not) and an NDJSON test must send `careerLevels` and assert the filtered `job` line count.
  - **Files:** `apps/api/src/jobs/jobs.controller.ts`, `apps/api/src/jobs/__tests__/{jobs.controller.ndjson,jobs.aggregator.career-level}.spec.ts`

## Phase 8 — Integration with list mode / NDJSON (2026-09-25)

- [x] T29 — `careerLevels: undefined` in the list-mode branch's `aggregateRaw` call sites (`jobs.aggregator.dedup-key.spec.ts`, `store-postgres.boot.spec.ts`).
- [x] T30 — Merged `SearchJobsInput`: `develop`'s decorators on every field, nullable `searchTerm`, `siteCategories` checked against `SITE_CATEGORIES`, `careerLevels` against `CAREER_LEVELS`; the pipe suite also sends `siteCategories`.
- [x] T31 — Keep `develop`'s lenient GraphQL `country` / `descriptionFormat` rules; the pipe suite pins them (§12.6, Q-106).
- [x] T32 — CI: one Feature Plugins pattern with `legitimacy-detector` and `career-level-classifier`.
- [x] T33 — Docs: README (NDJSON), spec §7.3 / §8 / §12.7, Q-106, log, index.
