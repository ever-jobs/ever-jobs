# Tasks: 5027 — Greenhouse `isRemote` reads `offices[]` + "Work Location" metadata

- [x] T1 — Add `officeLabels`, `workLocationLabels`, and `mergeWorkFromHomeType`
      helpers to `greenhouse.service.ts`.
    - Acceptance: helpers compile; `officeLabels` handles both board and Harvest
      office shapes; `workLocationLabels` matches "Work Location" case-insensitively
      and accepts string or array values.
- [x] T2 — In `processJob`, fold `offices[]` + "Work Location" metadata into the
      `isRemote` OR and merge their `workFromHomeType` with the location-text value.
    - Acceptance: office named "Remote" or metadata Work Location `Remote` →
      `isRemote: true`; metadata `Hybrid` → `isRemote: false`,
      `workFromHomeType: 'Hybrid'`; no signal → unchanged.
- [x] T3 — In `processHarvestJob`, fold `offices[]` into the `isRemote` OR and
      merge `workFromHomeType`.
    - Acceptance: Harvest office named "Remote" → `isRemote: true`; concrete
      office → unchanged.
- [x] T4 — Add greenhouse service tests (office-Remote, metadata Remote/Hybrid,
      non-remote no-false-positive).
    - Acceptance: the cases above are asserted; existing suites green.
- [x] T5 — Run the greenhouse suites and typecheck the package + API build.
    - Acceptance: `source-ats-greenhouse` jest suites green; `tsc --noEmit` clean.
