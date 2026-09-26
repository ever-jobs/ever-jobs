# Tasks: 5129 — Pinpoint nested department + SuccessFactors CSB department token

- [x] T1 — `pinpoint.service.ts`: `department` resolves from
      `attrs.job?.department?.name` (and `listing.job` fallback) before the
      legacy `department_name` / string-`department` keys.
    - Acceptance: a posting with `job.department = { id, name }` emits the
      name; flat-object `department` values are never emitted.
- [x] T2 — `successfactors.types.ts` + `successfactors.service.ts`:
      `SfCsbDetail.department`; `parseCsbDetail` reads
      `[data-careersite-propertyid="dept"]`; `toCsbJobPost` sets
      `JobPostDto.department`.
    - Acceptance: detail page with the dept token emits its text; without it,
      `department` stays unset.
- [x] T3 — Extend both mocked specs with the spec's cases.
    - Acceptance: new assertions pass alongside the existing suites.
- [x] T4 — Run the `source-ats-pinpoint` and `source-ats-successfactors` jest
      suites; typecheck `apps/api`; `lint:docs`.
    - Acceptance: suites green; `tsc --noEmit` clean; docs lint clean.
