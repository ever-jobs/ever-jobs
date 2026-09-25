# Tasks: 5152

| Field | Value |
| ----- | ----- |
| Spec ID | 5152 |
| Slug | source-company-soundryx |
| Status | Done |

- [x] Scaffold `packages/plugins/source-company-soundryx/` —
      package.json, tsconfig.json, `src/index.ts`, module, service,
      constants, types.
- [x] Implement `soundryx.service.ts`: index `a.srx-tile.is-link` →
      detail pages; title/location/On-Site/description/compensation/
      mailto-apply mapping.
- [x] Register `Site.SOUNDRYX` in `site.enum.ts`,
      `packages/plugins/index.ts`, `tsconfig.base.json`,
      `jest.config.js`.
- [x] Add fixtures (live index + 3 detail pages) + unit spec covering
      parse, field mapping, description without footnotes, salary
      compensation, cfemail decoding, empty/error diagnostics, input
      filters.
- [x] `jest` green for the package, `tsc --noEmit` clean,
      `lint:docs` clean; `docs/index.md` + `docs/log.md` updated.
