# Tasks: 5141 — `source-company-power_us`

| Field | Value |
| --- | --- |
| Spec ID | 5141 |
| Slug | source-company-power_us |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

- [x] Scaffold plugin package (package.json, tsconfig, index, module,
      constants, types, service).
- [x] Implement `/api/careers` JSON fetch + `JobPostDto` mapping
      (linkedinJobId ids, description sections when populated).
- [x] Register in all four places (site.enum.ts, plugins/index.ts,
      tsconfig.base.json, jest.config.js).
- [x] Unit tests: field mapping, id derivation + fallback,
      descriptions-when-populated, empty diagnostic, fetch failure,
      resultsWanted.
- [x] jest + tsc + lint:docs green; docs/index.md + docs/log.md
      updated; PR to develop.
