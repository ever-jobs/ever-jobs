# Tasks: 5156

| Field | Value |
| ----- | ----- |
| Status | Done |
| Plan | `.specify/specs/5156-source-company-int-dyn/plan.md` |

- [x] Scaffold `packages/plugins/source-company-int-dyn/` (package.json,
  tsconfig.json, src/index.ts, module, service).
- [x] Write `int-dyn.constants.ts` + `int-dyn.types.ts`.
- [x] Implement `IntDynService.fetchJobs` / `parseCareersPage` /
  `composeDescription` / `applyInput` with companyUrl de-fragmenting.
- [x] Register `Site.INT_DYN` + module + tsconfig path + jest mapper.
- [x] Fetch the live one-pager as `__tests__/fixtures/index.html` and
  write `__tests__/int-dyn.service.spec.ts`.
- [x] `npx jest`, `npx tsc --noEmit`, `npm run lint:docs` — all clean.
- [x] Verify live against `int-dyn.com` — 2 cards.
- [x] `docs/index.md` row + `docs/log.md` entry; commit, push, PR to develop.
