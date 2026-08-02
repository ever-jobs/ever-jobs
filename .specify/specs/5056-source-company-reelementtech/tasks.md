# Tasks: 5056 — source-company-reelementtech

- [x] Scaffold `packages/plugins/source-company-reelementtech` (package.json, tsconfig, src barrel/module)
- [x] `reelementtech.constants.ts` — origin, careers URL, `/jobs/` role path, defaults
- [x] `reelementtech.types.ts` — `ReelementtechOpening`, `ReelementtechDetail`
- [x] `reelementtech.service.ts` — listing + detail parse, `Promise.allSettled` fan-out, mapping, input filters
- [x] Register `Site.REELEMENTTECH = 'reelementtech'`
- [x] Append `ReelementtechModule` to `ALL_SOURCE_MODULES`
- [x] Add tsconfig path alias + jest `moduleNameMapper`
- [x] Unit tests over captured careers + detail fixtures
- [x] `docs/index.md`, `docs/log.md`, `docs/questions.md`
- [x] Typecheck the package
