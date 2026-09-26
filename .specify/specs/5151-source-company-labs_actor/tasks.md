# Tasks: 5151

| Field | Value |
| ----- | ----- |
| Spec ID | 5151 |
| Slug | source-company-labs_actor |
| Status | Done |

- [x] Scaffold `packages/plugins/source-company-labs_actor/` —
      package.json, tsconfig.json, `src/index.ts`, module, service,
      constants, types.
- [x] Implement `labs-actor.service.ts`: careers shell → main bundle →
      webpack chunk map → chunk scan → jobs-array parse (balanced
      brackets, no eval); per-team mailto `applyUrl`.
- [x] Register `Site.LABS_ACTOR` in `site.enum.ts`,
      `packages/plugins/index.ts`, `tsconfig.base.json`,
      `jest.config.js`.
- [x] Add fixtures (shell, main-bundle map, chunk slice) + unit spec
      covering parse, field mapping, description composition, apply
      mailto routing, empty/error diagnostics, input filters.
- [x] `jest` green for the package, `tsc --noEmit` clean,
      `lint:docs` clean; `docs/index.md` + `docs/log.md` updated.
