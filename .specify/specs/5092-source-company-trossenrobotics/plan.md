# Plan: 5092 — Source Company Plugin: Trossen Robotics

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-30   |
| Last updated | 2026-08-30   |

## Packages touched

- `packages/plugins/source-company-trossenrobotics` (new)
- `packages/models/src/enums/site.enum.ts`
- `packages/plugins/index.ts`
- `tsconfig.base.json`
- `jest.config.js`
- `docs/index.md`
- `docs/log.md`

## Implementation phases

### 1. Spec & scaffolding
- Create `.specify/specs/5092-source-company-trossenrobotics/{spec.md,plan.md,tasks.md}`.
- Create plugin package:
  - `package.json`
  - `tsconfig.json`
  - `src/index.ts`
  - `src/trossenrobotics.module.ts`
  - `src/trossenrobotics.service.ts`
  - `src/trossenrobotics.constants.ts`
  - `src/trossenrobotics.types.ts`
  - `__tests__/trossenrobotics.service.spec.ts`
  - `__tests__/fixtures/list.html`
  - `__tests__/fixtures/salesperson.html`
  - `__tests__/fixtures/junior-mechanical-engineer.html`

### 2. Core service
- Implement `TrossenroboticsService` with `IScraper.scrape` contract.
- Use `BrowserPool.getPage({ proxy, stealth: true, headful: true })` for list and detail pages.
- Parse list-page cards from rendered DOM, extracting title, metadata, and detail slug.
- Visit each detail page, wait for the content section, strip the application form, and convert the remaining HTML to markdown.
- Build `JobPostDto` with stable id, job type, workplace type, and date.
- Apply `ScraperInputDto` filters.
- Wrap errors with `classifyScrapeError`.

### 3. Registration
- Add `Site.TROSSENROBOTICS = 'trossenrobotics'` to `site.enum.ts`.
- Add `TrossenroboticsModule` to `ALL_SOURCE_MODULES` in `packages/plugins/index.ts`.
- Add path alias to `tsconfig.base.json`.
- Add `moduleNameMapper` entry to `jest.config.js`.

### 4. Docs
- Append a row to `docs/index.md`.
- Append a changelog entry to `docs/log.md` (newest at top).

### 5. Tests & validation
- Jest tests cover list parsing, detail parsing, filter application, and error fallback.
- Run `npx tsc --noEmit -p packages/plugins/source-company-trossenrobotics/tsconfig.json`.
- Run `npx jest --testPathPatterns source-company-trossenrobotics`.

### 6. Commit & PR
- Conventional commits: `feat(plugin/source-company-trossenrobotics): ...` and `docs: ...`.
- Push `devin/5092-source-company-trossenrobotics`.
- Create PR into `develop`.

## Risk: low
