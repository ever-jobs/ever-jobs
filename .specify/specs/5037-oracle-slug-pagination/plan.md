# Plan: 5037 — oracle-slug-pagination

| Field | Value |
| --- | --- |
| Spec ID | 5037 |
| Status | implemented |
| Created | 2026-07-07 |

## Packages touched

- `packages/plugins/source-ats-oracle/src/oracle.constants.ts` — new `ORACLE_DEFAULT_HOST_SEGMENT`.
- `packages/plugins/source-ats-oracle/src/oracle.service.ts` — `parseSlug`, `siteNumberFromUrl`, `resolveTenant` rewrite, pagination fix.
- `packages/plugins/source-ats-oracle/src/index.ts` — re-export new constant.
- `packages/plugins/source-ats-oracle/__tests__/oracle.service.spec.ts` — 7 new test cases.

## Phases

1. Add `ORACLE_DEFAULT_HOST_SEGMENT = 'ocs'` constant.
2. Rewrite `resolveTenant` to return `{ tenant, siteNumber }`.
3. Add `parseSlug` (colon + legacy) and `siteNumberFromUrl` helpers.
4. Fix pagination loop: terminate on `TotalJobsCount` / empty page, not short page.
5. Remove now-unused `extractRequisitions` (inlined into the loop).
6. Update class-level JSDoc.
7. Add unit tests for slug forms + pagination.
8. Live validation against 4 tenants (ocs + us8 + us6).

## Risks

- `ORACLE_DEFAULT_HOST_SEGMENT` assumption (`ocs`) is wrong for older
  region-code tenants -> mitigated by the full-host slug form that bypasses
  host reconstruction entirely.
- Oracle's TotalJobsCount slightly overstates reachable jobs (244 reported,
  243 returned via offset pagination) — accepted as an Oracle API quirk.
