# Plan: 5091 — Source Company Plugin: RDW (Redwire Corporation)

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-30   |
| Last updated | 2026-08-30   |

## Packages touched

- `packages/plugins/source-company-rdw` (new)
- `packages/models/src/enums/site.enum.ts`
- `packages/plugins/index.ts`
- `tsconfig.base.json`
- `jest.config.js`
- `docs/index.md`
- `docs/log.md`

## Implementation phases

### 1. Spec & scaffolding
- Create `.specify/specs/5091-source-company-rdw/{spec.md,plan.md,tasks.md}`.
- Create plugin package directory and files:
  - `package.json`
  - `tsconfig.json`
  - `src/index.ts`
  - `src/rdw.module.ts`
  - `src/rdw.service.ts`
  - `src/rdw.constants.ts`
  - `__tests__/rdw.service.spec.ts`

### 2. Core service
- Implement `RdwService` with the `IScraper.scrape` contract.
- Use `BrowserPool.getPage({ proxy, stealth: true, headful: true })` for search and detail pages.
- Parse search-page cards with Cheerio and loop pages until the pagination link disappears.
- For each card, navigate to the detail page, extract JSON-LD `JobPosting`, and build a `JobPostDto`.
- Normalize title prefixes (`Contract`, `Contractor`, `Temporary`, `Intern`, `Hybrid`, `Remote`, `On Site`) into `jobType` / `workFromHomeType`.
- Normalize JSON-LD `jobLocation.address` into `LocationDto`, handling remote, US full-state names, and non-US countries.
- Apply `ScraperInputDto` filters (search term, location, isRemote, jobType, resultsWanted, offset).
- Wrap errors with `classifyScrapeError`.

### 3. Registration
- Add `Site.RDW = 'rdw'` to `site.enum.ts`.
- Add `RdwModule` to `ALL_SOURCE_MODULES` in `packages/plugins/index.ts`.
- Add path alias to `tsconfig.base.json`.
- Add `moduleNameMapper` entry to `jest.config.js`.

### 4. Docs
- Append a row to `docs/index.md`.
- Append a changelog entry to `docs/log.md` (newest at top).

### 5. Tests & validation
- Construct fixture HTML for a search page (multiple cards, pagination) and a detail page (JSON-LD).
- Unit tests cover: pagination extraction, card parsing, detail JSON-LD parsing, title prefix normalization, US/non-US/remote location mapping, and error handling.
- Run `npx tsc --noEmit -p packages/plugins/source-company-rdw/tsconfig.json`.
- Run `npx jest --testPathPatterns source-company-rdw`.

### 6. Commit & PR
- Conventional commits: `feat(plugin/source-company-rdw): ...` and `docs: ...`.
- Push `devin/5091-source-company-rdw`.
- Create PR into `develop`.

## Risk: low
