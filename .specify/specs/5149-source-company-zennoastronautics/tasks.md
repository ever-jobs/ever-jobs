# Tasks: 5149

| Field | Value |
| ----- | ----- |
| Spec ID | 5149 |
| Slug | source-company-zennoastronautics |
| Status | Done |

- [x] Scaffold `packages/plugins/source-company-zennoastronautics/` —
      package.json, tsconfig.json, `src/index.ts`, module, service,
      constants, types.
- [x] Implement `zennoastronautics.service.ts`: single GET of the Sanity
      query endpoint; portable-text description composer;
      `JobPostDto` mapping (`id`/`atsId` = `zennoastronautics-{slug}`,
      per-role `jobUrl`/`applyUrl`, `compensation` when present).
- [x] Register `Site.ZENNOASTRONAUTICS` in `site.enum.ts`,
      `packages/plugins/index.ts`, `tsconfig.base.json`,
      `jest.config.js`.
- [x] Add Sanity-response fixture + unit spec covering parse, composed
      description, ids, per-role URLs, empty/error diagnostics, input
      filters.
- [x] Run jest, `tsc --project tsconfig.typecheck.json`, `lint:docs`.
- [x] Update `docs/index.md` + `docs/log.md`; commit; open PR to
      `develop`.
