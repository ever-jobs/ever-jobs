# Tasks: 5057 — source-company-flymotion

- [x] Scaffold `packages/plugins/source-company-flymotion` (package.json, tsconfig, src barrel/module)
- [x] `flymotion.constants.ts` — origin, careers URL, `/jobs/` role path, defaults
- [x] `flymotion.types.ts` — `FlymotionOpening`, `FlymotionDetail`
- [x] `flymotion.service.ts` — listing + detail parse, `Promise.allSettled` fan-out, mapping, input filters
- [x] Register `Site.FLYMOTION = 'flymotion'`
- [x] Append `FlymotionModule` to `ALL_SOURCE_MODULES`
- [x] Add tsconfig path alias + jest `moduleNameMapper`
- [x] Unit tests over captured careers + detail fixtures
- [x] `docs/index.md`, `docs/log.md`, `docs/questions.md`
- [x] Typecheck the package
