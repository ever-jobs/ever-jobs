# Plan: 5148

| Field | Value |
| ----- | ----- |
| Spec ID | 5148 |
| Slug | source-company-4earth_tech |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Approach

Static-bundle company plugin (same two-fetch shape as
`source-company-mundane_co`, but parsing a richer embedded array):

1. Scaffold `packages/plugins/source-company-4earth_tech/` (package.json,
   tsconfig, src/{index,module,service,constants,types}, __tests__).
2. `four-earth-tech.service.ts` — `@SourcePlugin({site:
   Site.FOUR_EARTH_TECH, name: '4Earth', category: 'company',
   companyDomains: ['4earth.tech']})`; `createHttpClient` GETs of the
   careers page and the `Careers-{hash}.js` chunk it references.
3. JS-literal extraction helpers in the service: balanced-bracket
   slice respecting string literals (single/double quotes + escapes),
   top-level comma split, scalar extraction by key, string/array/object
   item parsing for `rolePoints`/`sections`.
4. Register in the four places: `site.enum.ts` (Phase 1702,
   `FOUR_EARTH_TECH = '4earth_tech'`), `packages/plugins/index.ts`,
   `tsconfig.base.json` paths, `jest.config.js` moduleNameMapper.
5. Tests + fixtures; docs (`docs/index.md` row, `docs/log.md` entry);
   conventional commit; PR to `develop`.

## Risks

- Chunk hash changes per deploy — resolved from the shell each run.
- The jobs-array binding name is minified — anchored on `=[{id:"` +
  balanced-bracket slicing, not the variable name.
- Bundler may emit new escapes — the string decoder handles `\n`, `\t`,
  `\uXXXX`, and escaped quotes; unknown escapes degrade to the raw char.

## Phases

- Phase 1 (this change): plugin + tests + docs.
