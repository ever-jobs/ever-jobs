# Plan: 5147

| Field | Value |
| ----- | ----- |
| Spec ID | 5147 |
| Slug | source-company-ampflame |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Approach

Small static-HTML company plugin in the shape of `source-company-getmaxspace`:

1. Scaffold `packages/plugins/source-company-ampflame/` (package.json,
   tsconfig, src/{index,module,service,constants,types}, __tests__).
2. `ampflame.service.ts` — `@SourcePlugin({site: Site.AMPFLAME, name:
   'Accurate Metals', category: 'company', companyDomains:
   ['ampflame.com']})`; `createHttpClient` GET of the careers URL;
   Cheerio parse of the `[aria-label="Open positions"]` table rows via
   `data-label` cell keys.
3. Constants in `ampflame.constants.ts` (origin, careers URL, selectors,
   timeout); row type in `ampflame.types.ts`.
4. Register in the four places: `site.enum.ts` (Phase 1701),
   `packages/plugins/index.ts`, `tsconfig.base.json` paths,
   `jest.config.js` moduleNameMapper.
5. Tests + fixture; docs (`docs/index.md` row, `docs/log.md` entry);
   conventional commit; PR to `develop`.

## Risks

- Selector drift — mitigated by targeting ARIA/`data-label` attributes,
  never the hashed `CareersSection_*` class names.
- Table disappears or gains columns — zero-row case degrades to `empty`
  diagnostics; unknown `data-label` values are ignored.

## Phases

- Phase 1 (this change): plugin + tests + docs.
