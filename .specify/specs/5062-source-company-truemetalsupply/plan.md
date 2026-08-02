# Plan: 5062 — source-company-truemetalsupply

| Field | Value |
| --- | --- |
| Spec ID | 5062 |
| Slug | source-company-truemetalsupply |
| Status | done |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Scaffold** the plugin package `packages/plugins/source-company-truemetalsupply`:
    - `package.json` (`@ever-jobs/source-company-truemetalsupply`, `main`/`types` → `src/index.ts`), `tsconfig.json` (extends base), `src/index.ts` barrel.
    - `truemetalsupply.constants.ts` — company name, origin, `/careers` URL, dialog-trigger + dialog selectors, JD-marker list + min, facility-city list, timeouts.
    - `truemetalsupply.types.ts` — `TrueMetalSupplyOpening { title, descriptionHtml, descriptionText }`.
    - `truemetalsupply.module.ts` — NestJS `@Module` providing/exporting the service.

2. **Service** (`truemetalsupply.service.ts`) — `@SourcePlugin({ site: Site.TRUEMETALSUPPLY, name: 'True Metal Supply', category: 'company' })`, implements `IScraper` + `OnModuleDestroy`:
    - `scrape()` — `fetchOpenings()` → map via `toJobPost()` → `applyInput()`; any throw → empty `JobResponseDto`.
    - `fetchOpenings()` (protected, mocked in tests) — `BrowserPool.getPage({ proxy, stealth:true })`, `goto('/careers')`, wait for trigger selector, `collectDialogs(page)`; page closed in `finally`.
    - `collectDialogs()` — iterate `[aria-haspopup="dialog"]` by index; click, read `[role="dialog"]` text+html, Escape; keep dialogs with ≥2 JD markers (`isJobDialog`), title = first non-empty line (`titleFromText`), dedupe by title.
    - `toJobPost()` — id `truemetalsupply-<slug>`; description via `markdownConverter`; location via `titlePrefixLocation` (facility-city prefix only → `parseLocationList`); `jobUrl: ''`; `isRemote:false`, `datePosted:null`, `emails:[]`.
    - `applyInput()` — searchTerm (title+description), location term, isRemote, jobType, offset/resultsWanted.
    - `onModuleDestroy()` — `BrowserPool.close()`.

3. **Register** in four places: `Site.TRUEMETALSUPPLY`, `ALL_SOURCE_MODULES`, `tsconfig.base.json` path, `jest.config.js` mapper.

4. **Tests + fixtures** — capture the seven real dialogs (title/html/text) to `__tests__/fixtures/`; unit tests per the spec test plan; mock `fetchOpenings`; drive `collectDialogs` with a fake page.

5. **Docs** — `docs/index.md` row, `docs/log.md` entry. No `docs/questions.md` entries (all owner decisions resolved).

## Packages touched

- `packages/plugins/source-company-truemetalsupply` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`
- `docs/index.md`, `docs/log.md`

## Reuse

- `BrowserPool` (shared headless Chromium + stealth), `markdownConverter`, `parseLocationList` — all from `@ever-jobs/common`. No plugin-local browser launch or location logic.

## Risks

- **Wix DOM churn.** Trigger/dialog selectors and JD-marker wording can change on republish; the marker heuristic (≥2 of a broad set) and generic selectors are chosen to tolerate minor changes and to exclude non-job dialogs. Fixtures are captured real HTML so regressions surface in tests.
- **Headless flakiness.** Per-dialog failures are skipped individually; a top-level failure degrades to empty rather than throwing.