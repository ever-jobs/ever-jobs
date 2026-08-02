# Tasks: 5070 — Search accepts a company domain or a `Site` token

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Domain-to-token helper

- [~] T01 — Add `siteFromDomain` to `@ever-jobs/common`
  - **Files:** `packages/common/src/utils/site-from-domain.ts`, `packages/common/src/utils/index.ts`
  - **Acceptance:**
    - `boomsupersonic.com` → `boomsupersonic`
    - `hyl.io` → `hyl_io`
    - `divergent.us` → `divergent` (exception)
    - `nuro.ai` → `nuro` (exception)
    - `https://www.boomsupersonic.com/careers` → `boomsupersonic`
    - unknown domain returns `undefined`
  - **Estimate:** 0.5 day

## Phase 2 — DTO and service wiring

- [ ] T02 — Add `companyDomain` to `ScraperInputDto`
  - **Files:** `packages/models/src/dtos/scraper-input.dto.ts`
  - **Acceptance:** field is optional `string[]`, class-validator decorated, API property documented
  - **Estimate:** 0.25 day

- [ ] T03 — Resolve `companyDomain` in `JobsService.searchJobs`
  - **Files:** `apps/api/src/jobs/jobs.service.ts`
  - **Acceptance:**
    - resolves domains to `Site` tokens
    - unions with explicit `siteType`
    - throws `BadRequestException` for unresolved domains, naming domain + derived token
    - default routing unchanged when neither field is provided
  - **Estimate:** 0.5 day

- [ ] T04 — Update `JobsService` tests
  - **Files:** `apps/api/src/jobs/__tests__/jobs.service.spec.ts`
  - **Acceptance:**
    - `createService` uses a `PluginRegistry` with metadata
    - new test cases for `companyDomain` resolution, union, and 400
    - all existing routing tests still pass
  - **Estimate:** 0.5 day

## Phase 3 — Docs and cross-references

- [ ] T05 — Update `docs/index.md`, `docs/log.md`, `docs/API_CHANGELOG.md`, `tool_manifest.json`
  - **Files:** `docs/index.md`, `docs/log.md`, `docs/API_CHANGELOG.md`, `tool_manifest.json`
  - **Acceptance:** spec listed, change logged, schema exposes `companyDomain`
  - **Estimate:** 0.25 day

## Notes

- Update `docs/log.md` with each completed task in the same commit.
