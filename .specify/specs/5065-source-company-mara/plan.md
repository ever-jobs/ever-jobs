# Plan: 5065 — source-company-mara

| Field | Value |
| --- | --- |
| Spec ID | 5065 |
| Slug | source-company-mara |
| Status | done |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Scaffold plugin package** `packages/plugins/source-company-mara`
    - `package.json`, `tsconfig.json`, `src/{index,mara.module,mara.service,mara.constants,mara.types}.ts`
2. **Constants/types** — origin, careers URL, Webflow card selectors, defaults; `MaraOpening` interface
3. **Service** — `IScraper.scrape`:
    - fetch `/career` → `parseCareers` (enumerate `.mr-job-content-box` cards, skip cards without a real LinkedIn apply URL, dedupe by title) — **single-step, no detail fan-out**
    - per card: title (`.mr-h4` + highlight `.label-transparant` appended in parens only when not already present), label chips classified by shape (job-type → employment type; other → location), LinkedIn apply URL
    - `toJobPost` mapping (`id` = `mara-<title-slug>`; `jobUrl` = `''`; `applyUrl` = LinkedIn; `location` via `parseLocationList`; `jobType` via `getJobTypeFromString`; `isRemote` false; `description`/`compensation`/`datePosted` empty; `emails` `[]`)
    - `applyInput` (searchTerm/isRemote/jobType filters + offset/resultsWanted)
4. **Register in 4 places** — `Site.MARA`, `ALL_SOURCE_MODULES`, tsconfig path alias, jest `moduleNameMapper`
5. **Tests** — fixture-based unit tests over the captured `/career` page (+ an empty-board fixture)
6. **Docs** — `docs/index.md`, `docs/log.md` (top)

## Packages touched

- `packages/plugins/source-company-mara` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`
- `docs/*`

## Risks

- The careers markup is bespoke Webflow; class names are human-authored and stable, but a redesign that changes them degrades enumeration to empty (no throw) rather than emitting wrong data. Selectors validated against the captured fixture.
- The board renders a placeholder template card (apply `href="#"`); only cards with a real LinkedIn apply URL are ingested, so the placeholder is not emitted.
- The label chips state location / employment type positionally; the parser classifies by shape (job-type keyword) rather than assuming order.
- Apply links point at LinkedIn; they are carried on `applyUrl` but never fetched/probed.

## Dependencies

- None blocking. Reuses shared `parseLocationList` / `getJobTypeFromString` / `createHttpClient`. Standalone PR against `develop`.