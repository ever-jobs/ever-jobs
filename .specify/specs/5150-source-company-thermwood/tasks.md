# Tasks: 5150

| Field | Value |
| ----- | ----- |
| Spec ID | 5150 |
| Slug | source-company-thermwood |
| Status | Done |

- [x] Scaffold `packages/plugins/source-company-thermwood/` —
      package.json, tsconfig.json, `src/index.ts`, module, service,
      constants, types.
- [x] Implement `thermwood.service.ts`: single GET + Cheerio
      `div.job-card` parse (title, date, location/type split,
      description, `applyUrl` anchor, emails).
- [x] Register `Site.THERMWOOD` in `site.enum.ts`,
      `packages/plugins/index.ts`, `tsconfig.base.json`,
      `jest.config.js`.
- [x] Add page fixture (with commented-out cards) + unit spec covering
      parse, description composition, ids, apply anchor, empty/error
      diagnostics, input filters.
- [x] Run jest, `tsc --project tsconfig.typecheck.json`, `lint:docs`.
- [x] Update `docs/index.md` + `docs/log.md`; commit; open PR to
      `develop`.
