# Plan: 5063 — source-company-framework

| Field | Value |
| --- | --- |
| Spec ID | 5063 |
| Slug | source-company-framework |
| Status | done |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Scaffold plugin package** `packages/plugins/source-company-framework`
    - `package.json`, `tsconfig.json`, `src/{index,framework.module,framework.service,framework.constants,framework.types}.ts`
2. **Constants/types** — origin, careers URL, `/apply` URL, `/jobs/` role path, JD section names, Location/Salary Framer-name keys, defaults; `FrameworkOpening` (listing) + `FrameworkDetail` (detail) interfaces
3. **Service** — `IScraper.scrape`:
    - fetch `/hiring` → `parseListing` (enumerate on-domain `/jobs/{slug}` links, dedupe by slug; slug-derived title fallback — the Framer listing markup is soup)
    - fetch each `/jobs/{slug}` → `parseDetail` (title from `<title>`; `Location`/`Salary` named containers; JD sections `Who we are`/`Life at Frameworks`/`Requirements` → markdown) — **only on-domain `framework.co` is fetched**
    - `toJobPost` mapping (`jobUrl` = on-domain `/jobs/{slug}`, `applyUrl` = shared `/apply`; `location` from detail via `parseLocationList`; `isRemote` false; compensation via `salaryToCompensation` yearly; `employmentType`/`jobType`/`datePosted` null; `emails` `[]`)
    - `applyInput` (searchTerm/isRemote/jobType filters + offset/resultsWanted)
    - `Promise.allSettled` fan-out; per-role detail failure degrades to listing-only fields
4. **Register in 4 places** — `Site.FRAMEWORK`, `ALL_SOURCE_MODULES`, tsconfig path alias, jest `moduleNameMapper`
5. **Tests** — fixture-based unit tests over the captured `/hiring` + two `/jobs/{slug}` pages (fetch seam throws on any non-`framework.co` URL)
6. **Docs** — `docs/index.md`, `docs/log.md` (top)

## Packages touched

- `packages/plugins/source-company-framework` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`
- `docs/*`

## Risks

- Framer markup is bespoke; the detail Location/Salary named containers and the JD section names may drift on a redesign → the affected field degrades (description → null, or salary/location → null) and the role still emits with its slug title + on-domain URLs. Selectors validated against captured fixtures for both live roles.
- Salary is stated as `$150k-$200k+ | Generous Equity`; the shared `salaryToCompensation` reads the `$150k-$200k` annual range and ignores the `+` / equity note. The `+` open-ended marker and equity are not modeled as extra structured compensation.
- The site footer shows a generic `contact@framework.co`; it is not harvested — `emails` = `[]`.

## Dependencies

- None blocking. Reuses the shared `salaryToCompensation` (Spec 5058, already merged) for the annual salary range. Standalone PR against `develop`.