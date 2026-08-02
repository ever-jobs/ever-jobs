# Plan: 5057 — source-company-flymotion

| Field | Value |
| --- | --- |
| Spec ID | 5057 |
| Slug | source-company-flymotion |
| Status | done |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Scaffold plugin package** `packages/plugins/source-company-flymotion`
    - `package.json`, `tsconfig.json`, `src/{index,flymotion.module,flymotion.service,flymotion.constants,flymotion.types}.ts`
2. **Constants/types** — origin, careers URL, role path prefix, defaults; opening/detail interfaces
3. **Service** — `IScraper.scrape`:
    - fetch `/company/careers` → `parseListing` (anchors `a[href*="/jobs/"]` deduped by slug; card title/location/employment-type)
    - fan out per-role detail fetches via `Promise.allSettled` → `parseDetail` (`<h1>`, `.w-richtext` → markdown, labelled detail cards, `Pay:` region)
    - `toJobPost` mapping (location via `parseLocationList`, jobType via `getJobTypeFromString`, pay via `salaryToCompensation` — range or single bound, per Spec 5058)
    - `applyInput` (searchTerm/location/isRemote/jobType filters + offset/resultsWanted)
    - graceful degradation on detail failure (listing fields only)
4. **Register in 4 places** — `Site.FLYMOTION`, `ALL_SOURCE_MODULES`, tsconfig path alias, jest `moduleNameMapper`
5. **Tests** — fixture-based unit tests over captured careers + detail page
6. **Docs** — `docs/index.md`, `docs/log.md` (top), `docs/questions.md`

## Packages touched

- `packages/plugins/source-company-flymotion` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`
- `docs/*`

## Risks

- Webflow markup is bespoke; class-name selectors (`careers-job-listing-panel`, `job-detail-heading-wrapper`, `w-richtext`) may drift on a site redesign → parser returns empty and logs a warning (never invents data). Selectors are validated against captured fixtures.
- Pay is stated only in the rich-text prose (a single "From $X per year"). Spec 5058 taught the shared `salaryToCompensation` to parse a single stated bound (→ min-only `CompensationDto`), so this plugin delegates directly with no local fallback; omitted if no amount is stated.
- Live count varies (data row said 1). The plugin ingests whatever is live and asserts no count.