# Tasks: 5062 — source-company-truemetalsupply

- [x] T1 — Scaffold package (`package.json`, `tsconfig.json`, `src/index.ts`).
    - AC: `@ever-jobs/source-company-truemetalsupply` resolves; barrel exports module + service.
- [x] T2 — Constants + types (`truemetalsupply.constants.ts`, `truemetalsupply.types.ts`).
    - AC: company name/origin/`/careers` URL, dialog selectors, JD-marker list + min, facility-city list, timeouts; `TrueMetalSupplyOpening` type.
- [x] T3 — Service `scrape()` / `fetchOpenings()` / `collectDialogs()` via shared `BrowserPool` (stealth); page closed in `finally`; `onModuleDestroy` closes the pool.
    - AC: `/careers` opened headless, each dialog trigger clicked, popup read, non-job dialogs filtered (≥2 markers), titles deduped.
- [x] T4 — `toJobPost()` mapping: `truemetalsupply-<slug>` id, markdown description, title-prefix-only location, `jobUrl:''`, `isRemote:false`, `datePosted:null`, `emails:[]`.
    - AC: no fabricated fields; location null unless title prefixes a facility city.
- [x] T5 — `applyInput()` filters (searchTerm/location/isRemote/jobType) + offset/resultsWanted.
- [x] T6 — Register in four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig path, jest mapper).
- [x] T7 — Capture real dialog fixtures + unit tests (all seven roles; jobUrl blank; Asheville-only location; dialog filter/dedup via fake page; degradation).
    - AC: `npx jest packages/plugins/source-company-truemetalsupply` green; typecheck clean (only baseline TS6059 rootDir noise).
- [x] T8 — Docs: `docs/index.md` row + `docs/log.md` entry. No `docs/questions.md` entries (owner decisions resolved).
