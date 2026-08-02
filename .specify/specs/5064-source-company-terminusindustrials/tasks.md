# Tasks: 5064 — source-company-terminusindustrials

- [x] Scaffold `packages/plugins/source-company-terminusindustrials` (package.json, tsconfig, src barrel/module)
- [x] `terminus.constants.ts` — origin, careers URL, stable `Careers_<name>__` CSS-module class prefixes, defaults
- [x] `terminus.types.ts` — `TerminusOpening`
- [x] `terminus.service.ts` — single-step `/careers` card enumeration (title / meta chips / inline JD sections → markdown), mapping (title-derived id, `/careers` jobUrl, null applyUrl), input filters
- [x] On-domain only: nothing off-domain is fetched; no Indeed URL; PDF not fetched/parsed; no email harvested (`emails=[]`)
- [x] Location: `Austin, TX` via `parseLocationList`; `isRemote=false`; `Full-time` → `FULL_TIME` via `getJobTypeFromString`; `department=Engineering`
- [x] Enumerate every role card on `/careers`
- [x] Register `Site.TERMINUSINDUSTRIALS = 'terminusindustrials'`
- [x] Append `TerminusIndustrialsModule` to `ALL_SOURCE_MODULES`
- [x] Add tsconfig path alias + jest `moduleNameMapper`
- [x] Unit tests over the captured `/careers` fixture (+ empty-board fixture)
- [x] `docs/index.md`, `docs/log.md`
- [x] Typecheck the package
