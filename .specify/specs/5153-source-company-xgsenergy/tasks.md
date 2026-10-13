# Tasks: 5153

| Field | Value |
| ----- | ----- |
| Status | Done |
| Plan | `.specify/specs/5153-source-company-xgsenergy/plan.md` |

- [x] Scaffold `packages/plugins/source-company-xgsenergy/` (package.json,
  tsconfig.json, src/index.ts, module, service).
- [x] Write `xgsenergy.constants.ts` + `xgsenergy.types.ts`.
- [x] Implement `XgsenergyService.fetchJobs` / `parseItems` /
  `locationFragments` / `decodeCfEmail` / `applyInput`.
- [x] Register `Site.XGSENERGY` + module + tsconfig path + jest mapper.
- [x] Fetch `fixtures/careers.html` and write
  `__tests__/xgsenergy.service.spec.ts` (7 items, multi-location split,
  hybrid marker, anchor URLs, cfemail mailto, description, diagnostics,
  filters).
- [x] `npx jest`, `npx tsc --noEmit`, `npm run lint:docs` — all clean.
- [x] Verify live against `xgsenergy.com/careers/` — 7 roles.
- [x] `docs/index.md` row + `docs/log.md` entry; commit, push, PR to develop.
