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
