# Tasks: 5065 — source-company-mara

- [x] Scaffold `packages/plugins/source-company-mara` (package.json, tsconfig, src barrel/module)
- [x] `mara.constants.ts` — origin, careers URL, Webflow card selectors, defaults
- [x] `mara.types.ts` — `MaraOpening`
- [x] `mara.service.ts` — single-step `/career` card enumeration (title + highlight-in-parens / label chips), mapping (title-derived id, blank jobUrl, LinkedIn applyUrl), input filters
- [x] Skip the placeholder template card (apply `href="#"`); ingest only cards with a real LinkedIn apply URL
- [x] Off-domain LinkedIn apply URL carried but never fetched; no Indeed URL; no email harvested (`emails=[]`)
- [x] Location: stated city via `parseLocationList` (no fabricated state); `isRemote=false`; `Full Time` → `FULL_TIME` via `getJobTypeFromString`
- [x] Register `Site.MARA = 'mara'`
- [x] Append `MaraModule` to `ALL_SOURCE_MODULES`
- [x] Add tsconfig path alias + jest `moduleNameMapper`
- [x] Unit tests over the captured `/career` fixture (+ empty-board fixture)
- [x] `docs/index.md`, `docs/log.md`
- [x] Typecheck the package
