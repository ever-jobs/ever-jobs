# Tasks: 5157

| Field | Value |
| ----- | ----- |
| Status | Done |
| Plan | `.specify/specs/5157-source-company-thoron_us/plan.md` |

- [x] Scaffold `packages/plugins/source-company-thoron_us/` (package.json,
  tsconfig.json, src/index.ts, module, service).
- [x] Write `thoron-us.constants.ts` + `thoron-us.types.ts`.
- [x] Implement `ThoronUsService.fetchJobs` (shell → bundle →
  `parseJobsArray`), `parseEntry`, `toJobPost`, `applyInput`.
- [x] Register `Site.THORON_US` + module + tsconfig path + jest mapper.
- [x] Fetch live shell + bundle as `__tests__/fixtures/` and write
  `__tests__/thoron-us.service.spec.ts`.
- [x] `npx jest`, `npx tsc --noEmit`, `npm run lint:docs` — all clean.
- [x] Verify live against `thoron.us` — 3 entries.
- [x] `docs/index.md` row + `docs/log.md` entry; commit, push, PR to develop.
