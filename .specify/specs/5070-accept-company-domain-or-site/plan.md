# Plan: 5070 — Search accepts a company domain or a `Site` token

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | spec.md                            |
| Created      | 2026-07-27                         |
| Last updated | 2026-07-27                         |

## 1. Approach

Add a small, pure helper that maps a company domain to the `Site` token using the Spec 5069 rule plus the two upstream exceptions. Expose it from `@ever-jobs/common`. Add a `companyDomain` array to `ScraperInputDto`. In `JobsService.searchJobs`, resolve any `companyDomain` values before the existing site-routing logic, union the resolved tokens with explicit `siteType` values, and throw `BadRequestException` if any domain cannot be resolved. Update the test helper so `JobsService` unit tests use a real `PluginRegistry` and add focused tests for the new behavior.

## 2. Phases

### Phase 1 — Domain-to-token helper

- Goal: Implement `siteFromDomain` in `@ever-jobs/common` with the Spec 5069 rule and exceptions.
- Deliverables: `packages/common/src/utils/site-from-domain.ts`, export in `packages/common/src/utils/index.ts`.
- Exit criteria: Unit tests pass for all documented examples.

### Phase 2 — DTO and service wiring

- Goal: Add `companyDomain` to `ScraperInputDto` and resolve it in `JobsService.searchJobs`.
- Deliverables: `packages/models/src/dtos/scraper-input.dto.ts`, `apps/api/src/jobs/jobs.service.ts`, `apps/api/src/jobs/__tests__/jobs.service.spec.ts`.
- Exit criteria: `companyDomain`-only searches resolve to the right plugin and union with `siteType`; unresolved domains throw a 400.

### Phase 3 — Docs and cross-references

- Goal: Update canonical docs and manifests.
- Deliverables: `docs/index.md`, `docs/log.md`, `docs/API_CHANGELOG.md`, `tool_manifest.json`.
- Exit criteria: Index lists Spec 5070, log describes the change, API changelog and tool schema expose `companyDomain`.

## 3. Packages Touched

| Package                  | Change                                  |
| ------------------------ | --------------------------------------- |
| `packages/common`        | new `siteFromDomain` utility            |
| `packages/models`        | `ScraperInputDto.companyDomain` field   |
| `apps/api`               | resolve `companyDomain` in `JobsService` |
| `apps/api` (tests)       | registry-based `createService` helper + new tests |
| `docs/`                  | index, log, API changelog, tool manifest |

## 4. Dependencies

(none)

## 5. Risks & Mitigations

| Risk                                             | Likelihood | Impact | Mitigation                                      |
| ------------------------------------------------ | ---------- | ------ | ----------------------------------------------- |
| Removing `siteType` default changes API behavior | low        | medium | existing routing fallback already handles undefined `siteType`; documented in spec decisions |
| Tests use stale `scraperMap` helper              | high       | low    | fix `createService` to set a `PluginRegistry` instance |

## 6. Rollback Plan

Remove the `companyDomain` field from `ScraperInputDto` and the resolution block from `JobsService.searchJobs`. `siteFromDomain` can remain in `@ever-jobs/common` as it is unused without the call site.

## 7. Migration Plan

No data migration. API consumers may optionally switch from `siteType` to `companyDomain` for company plugins. `siteType` remains supported.

## 8. Open Questions for Plan

(none)
