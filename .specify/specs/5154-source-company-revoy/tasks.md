# Tasks: 5154

| Field | Value |
| ----- | ----- |
| Status | Done |
| Plan | `.specify/specs/5154-source-company-revoy/plan.md` |

- [x] Scaffold `packages/plugins/source-company-revoy/` (package.json,
  tsconfig.json, src/index.ts, module, service).
- [x] Write `revoy.constants.ts` + `revoy.types.ts`.
- [x] Implement `RevoyService.fetchJobs` / `parseIndex` / `parseDoc` /
  `applyInput` with doc-failure degradation.
- [x] Register `Site.REVOY` + module + tsconfig path + jest mapper.
- [x] Fetch fixtures (index + 2 doc exports) and write
  `__tests__/revoy.service.spec.ts`.
- [x] `npx jest`, `npx tsc --noEmit`, `npm run lint:docs` — all clean.
- [x] Verify live against `revoy.com/join-the-team` — 2 roles.
- [x] `docs/index.md` row + `docs/log.md` entry; commit, push, PR to develop.
