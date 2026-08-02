# Tasks: 5028 — ADP plugin mapped to the real WorkforceNow staffing API

- [x] T1 — Rewrite `adp.constants.ts`: `ADP_HOSTS`, `adpListUrl`,
      `adpDetailUrl`, `adpCareersUrl`, `ADP_DETAIL_CONCURRENCY`.
    - Acceptance: URL builders host-aware; both hosts present in order.
- [x] T2 — Rewrite `adp.types.ts` to the real list/detail payload shape.
    - Acceptance: `AdpJob` carries `itemID`, `requisitionTitle`,
      `requisitionDescription`, `postDate`, `requisitionLocations`,
      `workLevelCode`, `payGradeRange`, `customFieldGroup`.
- [x] T3 — Rewrite `adp.service.ts` host-resolution + detail overlay + mapping.
    - Acceptance: list resolves on either host; detail overlays
      `requisitionDescription` under bounded concurrency (fail-safe); canonical
      fields mapped (title/id/location/isRemote/compensation/employmentType/
      datePosted/jobUrl).
- [x] T4 — Add `__tests__/adp.service.spec.ts`.
    - Acceptance: mapping+detail overlay, host fallback (`.cloud.`), no-open-reqs,
      detail-failure list-only fallback, and no-host cases all asserted.
- [x] T5 — Run the ADP suite and typecheck the package + API build; docs-lint.
    - Acceptance: `source-ats-adp` jest green; `tsc --noEmit` clean;
      `npm run lint:docs` clean.
