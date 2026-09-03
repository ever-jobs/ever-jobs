# Plan: 5088 — SuccessFactors CSB concurrency

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-30   |
| Last updated | 2026-08-30   |

## Phases

1. **Constants (`packages/plugins/source-ats-successfactors/src/successfactors.constants.ts`).** Add `SF_CSB_PAGE_CONCURRENCY = 4`. Update `SF_CSB_DETAIL_CONCURRENCY` from `5` to `10`. Export `SF_CSB_PAGE_CONCURRENCY` if it is imported by tests.

2. **Service logic (`successfactors.service.ts`).** Refactor `collectCsbTiles` to fetch tile pages in batches of `SF_CSB_PAGE_CONCURRENCY` using `Promise.allSettled`, process results in startrow order, and stop on the first empty/duplicate/failed page. Remove the `randomSleep` between tile pages.

3. **Tests (`__tests__/successfactors-csb.service.spec.ts`).** Add a `TestSuccessFactorsService` subclass that stubs `fetchCsbTileHtml` to return a deterministic sequence of pages, including an empty page to verify early termination. Assert that the service still deduplicates and stops correctly. Add a detail-concurrency test that stubs `fetchCsbDetailHtml` and counts concurrent calls.

4. **Docs and Spec Kit.** Update `docs/index.md` and `docs/log.md` with Spec 5088 row/entry.

5. **Verification.** Run the `source-ats-successfactors` Jest suite and `tsc --noEmit` for the package.

## Packages touched

- `packages/plugins/source-ats-successfactors`

## Risks

- Higher concurrency may trigger rate limits on stricter tenants; the constants can be tuned if telemetry shows `429` responses.
- Concurrent tile fetching may waste one batch past the end of the list, but this is bounded and acceptable.
