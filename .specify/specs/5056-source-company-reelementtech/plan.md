# Plan: 5056 — source-company-reelementtech

| Field | Value |
| --- | --- |
| Spec ID | 5056 |
| Slug | source-company-reelementtech |
| Status | done |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Scaffold plugin package** `packages/plugins/source-company-reelementtech`
    - `package.json`, `tsconfig.json`, `src/{index,reelementtech.module,reelementtech.service,reelementtech.constants,reelementtech.types}.ts`
2. **Constants/types** — origin, careers URL, role path prefix, defaults; opening/detail interfaces
3. **Service** — `IScraper.scrape`:
    - fetch `/careers` → `parseListing` (anchors `a[href*="/jobs/"]` deduped by slug; card location from sibling paragraph)
    - fan out per-role detail fetches via `Promise.allSettled` → `parseDetail` (`.w-richtext` → markdown)
    - `toJobPost` mapping; `applyInput` (searchTerm/location/isRemote/jobType filters + offset/resultsWanted)
    - graceful degradation on detail failure (listing fields only)
4. **Register in 4 places** — `Site.REELEMENTTECH`, `ALL_SOURCE_MODULES`, tsconfig path alias, jest `moduleNameMapper`
5. **Tests** — fixture-based unit tests over captured careers + 2 detail pages
6. **Docs** — `docs/index.md`, `docs/log.md` (top), `docs/questions.md`

## Packages touched

- `packages/plugins/source-company-reelementtech` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`
- `docs/*`

## Risks

- Webflow markup is bespoke; class-name selectors (`job-heading`, `brix---*`, `w-richtext`) may drift on a site redesign → parser returns empty and logs a warning (never invents data). Selectors are validated against captured fixtures.
- Live count varies (data row said 3; site shows 2). The plugin ingests whatever is live and asserts no count.