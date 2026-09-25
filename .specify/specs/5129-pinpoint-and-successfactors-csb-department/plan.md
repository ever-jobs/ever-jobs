# Plan: 5129 — Pinpoint nested department + SuccessFactors CSB department token

| Field | Value |
| --- | --- |
| Spec ID | 5129 |
| Status | implemented |
| Created | 2026-09-16 |

## Phases

1. **Pinpoint** — `pinpoint.service.ts`: resolve `department` from
   `job.department.name` (nested `{ id, name }`) before the legacy flat keys.
2. **SuccessFactors** — `successfactors.types.ts`: add
   `SfCsbDetail.department`; `successfactors.service.ts`: `parseCsbDetail`
   reads `[data-careersite-propertyid="dept"]` text;
   `toCsbJobPost` emits `department`.
3. **Tests** — `pinpoint.service.spec.ts`: nested-department case +
   no-department regression; `successfactors-csb.service.spec.ts`: `detailPage`
   gains a `department` option emitting the propertyid span; assert mapped
   value and absence case.
4. **Verify** — `source-ats-pinpoint` + `source-ats-successfactors` jest
   suites; `apps/api` `tsc --noEmit`; `lint:docs`.

## Packages touched

- `packages/plugins/source-ats-pinpoint` (`src/pinpoint.service.ts`,
  `__tests__/pinpoint.service.spec.ts`).
- `packages/plugins/source-ats-successfactors`
  (`src/successfactors.types.ts`, `src/successfactors.service.ts`,
  `__tests__/successfactors-csb.service.spec.ts`).

## Risks

- Pinpoint postings that wrap fields in JSON:API `attributes` — covered by
  reading `job` from both `attrs` and `listing`.
- A CSB tenant styling a different element with the same propertyid — unlikely;
  the token is CSB's standard job-layout marker and degrades to unset when
  absent.
