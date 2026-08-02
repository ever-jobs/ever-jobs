# Tasks: 5061 — source-company-hylio

- [x] Scaffold `packages/plugins/source-company-hylio` (package.json, tsconfig, src barrel/module)
- [x] `hylio.constants.ts` — origin, careers URL, `/hiring/` role path + board-index slug, defaults
- [x] `hylio.types.ts` — `HylioOpening`, `HylioDetail`
- [x] `hylio.service.ts` — two-step listing + detail parse, `<br>`-aware title, mapping (jobUrl on-domain / applyUrl Indeed), input filters
- [x] Indeed link-only: `applyUrl` = Indeed, `jobUrl` = on-domain detail; Indeed is never fetched
- [x] Location: null (site states none); `isRemote=false`; compensation via shared `salaryToCompensation` (hourly)
- [x] Register `Site.HYLIO = 'hylio'`
- [x] Append `HylioModule` to `ALL_SOURCE_MODULES`
- [x] Add tsconfig path alias + jest `moduleNameMapper`
- [x] Unit tests over the captured job-board + detail fixtures (incl. Indeed-never-fetched guard)
- [x] `docs/index.md`, `docs/log.md`
- [x] Typecheck the package
