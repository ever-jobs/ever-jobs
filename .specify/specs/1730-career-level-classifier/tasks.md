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
- [ ] T18 — At integration with the NDJSON / list-mode lane (`feat/list-mode-ndjson-store`): keep **one**
  public `aggregateRaw` that runs `dedupAndPersist`, then stamps `dedupKey`, then applies career
  level (that lane's `aggregateRawUnkeyed` becomes the body of `dedupAndPersist` + the stamp);
  pass `careerLevels: input.careerLevels` from the single shared controller call for both JSON and
  NDJSON; keep `careerLevels: undefined` in the REST cache key; re-run
  `jobs.aggregator.career-level.spec.ts` together with that lane's tests on the merge.
- [ ] T19 — Optional, at the same integration: when no `careerLevels` filter is set, classify only
  the paginated output window (needs the controller to resolve the window before `aggregateRaw`).
