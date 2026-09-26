# Tasks: 5128 — Dover job-groups (department) and per-job apply links

- [x] T1 — Add `DOVER_JOB_GROUPS_API_TEMPLATE` and `DOVER_APPLY_URL_TEMPLATE` to
      `dover.constants.ts`; add `DoverJobGroup` + `DoverJob.department` to
      `dover.types.ts`.
    - Acceptance: types compile; endpoints + shapes documented.
- [x] T2 — `dover.service.ts`: `fetchJobGroups` → `Map<jobId, groupName>`
      (4xx/malformed → empty map); `assemble` consumes it; `url` =
      `apply/{slug}/{jobId}` with careers-page fallback; `toJobPost` sets
      `department` and the new `jobUrl`/`applyUrl`.
    - Acceptance: a slug-resolved tenant emits apply-form links and group-name
      departments; unmapped roles keep `department` unset.
- [x] T3 — Extend the mocked spec: `JOB_GROUPS_RE` route + the spec's cases
      (mapped/unmapped departments, apply links, job-groups 4xx degradation,
      no-slug fallback).
    - Acceptance: new assertions pass alongside the existing suite.
- [x] T4 — Run the `source-ats-dover` jest suite; typecheck `apps/api`;
      `lint:docs`.
    - Acceptance: suite green; `tsc --noEmit` clean; docs lint clean.
