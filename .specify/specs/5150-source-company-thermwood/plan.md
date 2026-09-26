# Plan: 5150

| Field | Value |
| ----- | ----- |
| Spec ID | 5150 |
| Slug | source-company-thermwood |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Approach

Static-HTML company plugin (same single-fetch shape as
`source-company-ampflame`):

1. Scaffold `packages/plugins/source-company-thermwood/` (package.json,
   tsconfig, src/{index,module,service,constants,types}, __tests__).
2. `thermwood.service.ts` — `@SourcePlugin({site: Site.THERMWOOD, name:
   'Thermwood', category: 'company', companyDomains:
   ['thermwood.com']})`; `createHttpClient` GET of the careers page,
   Cheerio over `div.job-card` (commented-out retired cards are comment
   nodes — never matched).
3. Card → `JobPostDto`: title from `h3.job-card-title`; `datePosted`
   parsed from `Posted: MM-DD-YYYY`; `.job-card-location` split on `•`
   → location / type; `.job-card-details` → description via the
   existing HTML→text convention (h4 headings + `ul/li` bullets);
   `applyUrl` = `{page}#application-form`; `extractEmails` for the
   resume mailto.
4. Register in the four places: `site.enum.ts` (Phase 1704,
   `THERMWOOD = 'thermwood'`), `packages/plugins/index.ts`,
   `tsconfig.base.json` paths, `jest.config.js` moduleNameMapper.
5. Tests + fixture; docs (`docs/index.md` row, `docs/log.md` entry);
   conventional commit; PR to `develop`.

## Risks

- The careers page is a `.htm` static page — the URL is fixed in
  constants and overridable via `companyUrl` if the site ever moves it.
- `MM-DD-YYYY` is ambiguous vs `DD-MM-YYYY` — US site, US convention;
  the parser only accepts the `MM-DD-YYYY` shape and leaves `datePosted`
  null on any other text (e.g. `Ongoing`).
- Card markup could drift — selectors key on semantic class names
  (`job-card-*`), not hashed CSS modules.

## Phases

- Phase 1 (this change): plugin + tests + docs.
