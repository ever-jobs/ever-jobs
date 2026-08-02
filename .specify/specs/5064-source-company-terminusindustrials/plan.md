# Plan: 5064 — source-company-terminusindustrials

| Field | Value |
| --- | --- |
| Spec ID | 5064 |
| Slug | source-company-terminusindustrials |
| Status | done |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Scaffold plugin package** `packages/plugins/source-company-terminusindustrials`
    - `package.json`, `tsconfig.json`, `src/{index,terminus.module,terminus.service,terminus.constants,terminus.types}.ts`
2. **Constants/types** — origin, careers URL, stable `Careers_<name>__` CSS-module class prefixes, defaults; `TerminusOpening` interface
3. **Service** — `IScraper.scrape`:
    - fetch `/careers` → `parseCareers` (enumerate `Careers_card__*` blocks, dedupe by title) — **single-step, no detail fan-out**
    - per card: title (`Careers_cardTitle__*`), meta chips classified by shape (`City, ST` → location; job-type → employment type; remaining → department), inline JD sections (`Careers_section__*`) → markdown
    - `toJobPost` mapping (`id` = `terminusindustrials-<title-slug>`; `jobUrl` = `/careers`; `applyUrl` = null; `location` via `parseLocationList`; `jobType` via `getJobTypeFromString`; `isRemote` false; `compensation`/`datePosted` empty; `emails` `[]`)
    - `applyInput` (searchTerm/isRemote/jobType filters + offset/resultsWanted)
4. **Register in 4 places** — `Site.TERMINUSINDUSTRIALS`, `ALL_SOURCE_MODULES`, tsconfig path alias, jest `moduleNameMapper`
5. **Tests** — fixture-based unit tests over the captured `/careers` page (+ an empty-board fixture)
6. **Docs** — `docs/index.md`, `docs/log.md` (top)

## Packages touched

- `packages/plugins/source-company-terminusindustrials` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`
- `docs/*`

## Risks

- The careers markup is bespoke Next.js with hashed CSS-module class names; only the `Careers_<name>__` prefix is stable, so selectors match on that prefix. A redesign that changes the prefixes degrades enumeration to empty (no throw) rather than emitting wrong data. Selectors validated against the captured fixture.
- The meta row states department / location / employment type positionally; the parser classifies by shape (comma-form location, job-type keyword) rather than assuming order, so a reordered meta row still maps correctly.
- The role JD is also offered as an on-domain PDF; the HTML already carries the same JD, so the PDF is not fetched/parsed.

## Dependencies

- None blocking. Reuses shared `parseLocationList` / `getJobTypeFromString` / `markdownConverter` / `createHttpClient`. Standalone PR against `develop`.