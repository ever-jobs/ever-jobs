# Tasks 5165

| Spec | 5165 — ats-jibe-plugin |
| --- | --- |
| Package | packages/plugins/source-ats-jibe |

- [x] Scaffold `packages/plugins/source-ats-jibe/` (package.json, tsconfig.json, src/, __tests__/).
- [x] `jibe.constants.ts` + `jibe.types.ts` — API shapes and URL builders.
- [x] `jibe.service.ts` — target resolution, pagination, JobPostDto mapping.
- [x] `jibe.module.ts` + `index.ts` barrel.
- [x] Register: `Site.JIBE`, `ALL_SOURCE_MODULES`, tsconfig path, jest `moduleNameMapper`.
- [x] `__tests__/jibe.service.spec.ts` — resolution, mapping, pagination, degrades (mocked client).
- [x] `docs/index.md` row + `_Last revised_` footer; `docs/log.md` prepend.
- [x] jest + tsc green; live scrape spot-check on `careers.rivian.com`.
