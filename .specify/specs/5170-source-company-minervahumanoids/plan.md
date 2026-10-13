# Plan: 5170 — source-company-minervahumanoids

| Field | Value |
| --- | --- |
| Spec ID | 5170 |
| Slug | source-company-minervahumanoids |
| Status | draft |
| Owner | agent |
| Created | 2026-10-02 |

## Phases

1. **Scaffold** `packages/plugins/source-company-minervahumanoids/`
   (`package.json`, `tsconfig.json`,
   `src/{index.ts,minervahumanoids.module.ts,minervahumanoids.service.ts,
   minervahumanoids.constants.ts,minervahumanoids.types.ts}`), modeled on
   `source-company-buildnebula` (single data file → DTO map).
2. **Register** in the four places: `site.enum.ts`, `packages/plugins/index.ts`,
   `tsconfig.base.json` paths, `jest.config.js` moduleNameMapper.
3. **Implement** the service: one `createHttpClient` GET of
   `{origin}/content/published.js`, slice the `window.__minervaContent=` JSON,
   map `content.jobs[]` per the spec's contract, `applyInput` filtering
   (searchTerm/location/offset/resultsWanted).
4. **Tests** against the captured fixture; `jest`, `tsc`, `lint:docs`.
5. **Docs**: `docs/index.md` entry + `docs/log.md` line; commit, push, PR.

## Packages touched

- new: `packages/plugins/source-company-minervahumanoids`
- edit: `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`,
  `tsconfig.base.json`, `jest.config.js`, `docs/index.md`, `docs/log.md`

## Risks

- Hand-rolled CMS — field names could shift without notice; parsing is
  defensive (all fields optional, `published` gate only fires when present).
- `applyUrl` is empty on every item today; if the site starts populating it
  (external application links) the value is used verbatim.
- Duplicate titles are real postings (`ML/AI Humanoid Robot Controls
  Engineer` × 2 in different locations) — no title-based dedup; `id` is
  authoritative.
