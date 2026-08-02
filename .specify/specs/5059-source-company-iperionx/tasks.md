# Tasks: 5059 — source-company-iperionx

- [x] Scaffold `packages/plugins/source-company-iperionx` (package.json, tsconfig, src barrel/module)
- [x] `iperionx.constants.ts` — origin, careers URL, Indeed apply-link match + `/job/` path, defaults
- [x] `iperionx.types.ts` — `IperionxOpening`
- [x] `iperionx.service.ts` — single-page listing parse (Indeed-anchored cards), title/location split, mapping, input filters
- [x] Location: bare-state suffix via `parseLocationList([...], { allowBareStateProvince: true })` (Spec 5060 dependency) → `{ state: 'VA' }`
- [x] Register `Site.IPERIONX = 'iperionx'`
- [x] Append `IperionxModule` to `ALL_SOURCE_MODULES`
- [x] Add tsconfig path alias + jest `moduleNameMapper`
- [x] Unit tests over the captured careers fixture (incl. bare-state → `{ state: 'VA' }`)
- [x] `docs/index.md`, `docs/log.md`
- [x] Typecheck the package
