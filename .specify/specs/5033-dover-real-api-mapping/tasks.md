# Tasks: 5033 — Dover real API mapping (full rewrite)

- [x] T1 — Rewrite `dover.constants.ts` for the real surface (API origin,
      slug-resolve / careers-page / jobs-list / detail templates, URL builders,
      `DOVER_UUID_REGEX`, extended `DOVER_BOARD_PATH_REGEX`, headers,
      `doverCompensationInterval`).
    - Acceptance: types compile; the surface + contract are documented.
- [x] T2 — Rewrite `dover.types.ts` (careers-page / list / jobs-envelope /
      detail / compensation / location envelopes + normalised `DoverJob`).
    - Acceptance: fields mirror the wire shapes and are documented.
- [x] T3 — Rewrite `dover.service.ts`: token resolution, careers-page resolve
      (UUID or slug variants), jobs list with `next` paging + `is_sample`
      exclusion, detail overlay, structured-first compensation, field mapping,
      graceful degradation.
    - Acceptance: a tenant whose slug resolves + lists roles yields one
      `JobPostDto` per unique non-sample `id`; `companyName` from `client_name`;
      `datePosted` from `created`; empty on unknown tenant / no input.
- [x] T4 — Add the mocked `dover.service.spec.ts`; refresh the e2e header
      comment + `KNOWN_TENANT` to the real contract.
    - Acceptance: the cases in the spec test plan are asserted; e2e stays live +
      zero-tolerant.
- [x] T5 — Run the `source-ats-dover` jest suite; typecheck `apps/api`;
      `lint:docs`.
    - Acceptance: suite green; `tsc --noEmit` clean on `apps/api`; docs lint
      clean.
