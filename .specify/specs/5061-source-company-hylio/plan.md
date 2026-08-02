# Plan: 5061 — source-company-hylio

| Field | Value |
| --- | --- |
| Spec ID | 5061 |
| Slug | source-company-hylio |
| Status | done |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Scaffold plugin package** `packages/plugins/source-company-hylio`
    - `package.json`, `tsconfig.json`, `src/{index,hylio.module,hylio.service,hylio.constants,hylio.types}.ts`
2. **Constants/types** — origin, careers URL, `/hiring/` role path + board-index slug, defaults; `HylioOpening` (listing) + `HylioDetail` (detail) interfaces
3. **Service** — `IScraper.scrape`:
    - fetch `/hiring/job-board` → `parseListing` (anchor on `.jobtitle`, resolve `.w-layout-grid` card; detail slug from the on-domain `/hiring/{slug}` "LEARN MORE" link excluding the board index; title with `<br>` → space; Indeed apply URL)
    - fetch each `/hiring/{slug}` → `parseDetail` (JD body → markdown; `Job Type:` and `Pay:` lines) — **only the on-domain detail is fetched; Indeed is never requested**
    - `toJobPost` mapping (`jobUrl` = on-domain detail, `applyUrl` = Indeed; `location` null; `isRemote` false; compensation via `salaryToCompensation`; job type via `getJobTypeFromString`)
    - `applyInput` (searchTerm/isRemote/jobType filters + offset/resultsWanted)
    - `Promise.allSettled` fan-out; per-role detail failure degrades to listing-only fields
4. **Register in 4 places** — `Site.HYLIO`, `ALL_SOURCE_MODULES`, tsconfig path alias, jest `moduleNameMapper`
5. **Tests** — fixture-based unit tests over the captured job-board + detail pages (fetch seam throws on any Indeed URL)
6. **Docs** — `docs/index.md`, `docs/log.md` (top)

## Packages touched

- `packages/plugins/source-company-hylio` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`
- `docs/*`

## Risks

- Webflow markup is bespoke; the listing selectors (`.jobtitle` + `.w-layout-grid` + the `/hiring/{slug}` LEARN MORE link) and detail body selector (`h1.subheading` container) may drift on a redesign → parser returns empty / degrades and logs a warning (never invents data). Selectors validated against captured fixtures.
- The site states **no per-role location** — `location` is left null; the `Houston, TX` HQ from external data is never synthesized.
- The JD body may itself contain an "Apply on Indeed" call-to-action; this is the employer's own page content, faithfully preserved in the description. It does **not** imply Indeed was fetched (it never is).
- Live count varies (data row said 1). The plugin ingests whatever is live and asserts no fixed count.

## Dependencies

- None blocking. Reuses the shared `salaryToCompensation` (Spec 5058, already merged) for the hourly pay range.