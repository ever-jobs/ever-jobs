# Tasks: 5155

| Field | Value |
| ----- | ----- |
| Status | Done |
| Plan | `.specify/specs/5155-source-company-xlight/plan.md` |

- [x] Scaffold `packages/plugins/source-company-xlight/` (package.json,
  tsconfig.json, src/index.ts, module, service).
- [x] Write `xlight.constants.ts` + `xlight.types.ts`.
- [x] Implement `XlightService.fetchJobs` / `parseCareersPage` /
  `splitLabels` / `toJobPost` / `applyInput`.
- [x] Register `Site.XLIGHT` + module + tsconfig path + jest mapper.
- [x] Fetch the live careers page as `__tests__/fixtures/careers.html` and
  write `__tests__/xlight.service.spec.ts`.
- [x] `npx jest`, `npx tsc --noEmit`, `npm run lint:docs` — all clean.
- [x] Verify live against `xlight.com/careers` — 22 cards.
- [x] `docs/index.md` row + `docs/log.md` entry; commit, push, PR to develop.
