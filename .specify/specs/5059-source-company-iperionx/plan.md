# Plan: 5059 — source-company-iperionx

| Field | Value |
| --- | --- |
| Spec ID | 5059 |
| Slug | source-company-iperionx |
| Status | done |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Scaffold plugin package** `packages/plugins/source-company-iperionx`
    - `package.json`, `tsconfig.json`, `src/{index,iperionx.module,iperionx.service,iperionx.constants,iperionx.types}.ts`
2. **Constants/types** — origin, careers URL, Indeed apply-link match + `/job/` path, defaults; single `IperionxOpening` interface (no detail type — the page is summary-only)
3. **Service** — `IScraper.scrape`:
    - fetch `/careers/` → `parseListing` (anchor on `a[href*="indeed.com/job/"]`, deduped by Indeed slug; card `<h3>` title + `.subheading` blurb via `.closest('.pr-10.py-10')`)
    - `splitTitleLocation` — strip a trailing " - {location}" from the title
    - `toJobPost` mapping (location via `parseLocationList([...], { allowBareStateProvince: true })` (Spec 5060) → `{ state: 'VA' }`, description via `markdownConverter`; empty fields left unset)
    - `applyInput` (searchTerm/location/isRemote/jobType filters + offset/resultsWanted)
    - **no** per-role detail fetch (the "detail" is an off-site Indeed page, deliberately not read)
4. **Register in 4 places** — `Site.IPERIONX`, `ALL_SOURCE_MODULES`, tsconfig path alias, jest `moduleNameMapper`
5. **Tests** — fixture-based unit tests over the captured careers page
6. **Docs** — `docs/index.md`, `docs/log.md` (top)

## Packages touched

- `packages/plugins/source-company-iperionx` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`
- `docs/*`

## Risks

- WordPress markup is bespoke; the card selector (`.pr-10.py-10` container + `h3` + `.subheading`) may drift on a redesign → parser returns empty and logs a warning (never invents data). Selectors are validated against a captured fixture.
- The page is **summary-only**: many fields are unavailable on-site and are intentionally left empty. This is by design, not a parsing gap; the full JD lives on Indeed, which is out of scope.
- Location is stated only as a bare state (`Virginia`). Resolved via the shared parser's opt-in (`allowBareStateProvince`, Spec 5060) → `{ state: 'VA' }`, so this plugin **depends on Spec 5060** (PR order 5060 → 5059). Never substituted with the `Charlotte, NC` corporate HQ.
- Live count varies (data row said 6). The plugin ingests whatever is live and asserts no count.

## Dependencies

- **Spec 5060** (shared opt-in bare state/province classification) must land first; the plugin calls `parseLocationList` with `{ allowBareStateProvince: true }`.