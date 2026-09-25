# Tasks: 5147

| Field | Value |
| ----- | ----- |
| Spec ID | 5147 |
| Slug | source-company-ampflame |
| Status | Done |

- [x] Scaffold `packages/plugins/source-company-ampflame/` package files.
- [x] Implement `ampflame.service.ts` + constants + types.
- [x] Register `Site.AMPFLAME` in `site.enum.ts`, `packages/plugins/index.ts`,
      `tsconfig.base.json`, `jest.config.js`.
- [x] Add careers-page fixture + unit spec covering parse, id dedupe,
      applyUrl resolution, empty/error diagnostics, input filters.
- [x] Run jest, `tsc --project tsconfig.typecheck.json`, `lint:docs`.
- [x] Update `docs/index.md` + `docs/log.md`; commit; open PR to `develop`.
