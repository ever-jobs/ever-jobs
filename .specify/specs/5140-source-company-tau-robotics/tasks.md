# Tasks: 5140 — `source-company-tau-robotics`

| Field | Value |
| --- | --- |
| Spec ID | 5140 |
| Slug | source-company-tau-robotics |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

- [x] Scaffold plugin package (package.json, tsconfig, index, module,
      constants, types, service).
- [x] Implement careers-page anchor parse + `apply.js` `ROLES` literal
      parse + `JobPostDto` mapping.
- [x] Register in all four places (site.enum.ts, plugins/index.ts,
      tsconfig.base.json, jest.config.js).
- [x] Unit tests: role mapping, descriptions, open-application skip,
      meta variants, empty diagnostic, slug-missing-from-ROLES.
- [x] jest + tsc + lint:docs green; docs/index.md + docs/log.md
      updated; PR to develop.
