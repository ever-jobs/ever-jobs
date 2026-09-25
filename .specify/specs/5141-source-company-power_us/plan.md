# Plan: 5141 — `source-company-power_us`

| Field | Value |
| --- | --- |
| Spec ID | 5141 |
| Slug | source-company-power_us |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

## Phases

1. Scaffold `packages/plugins/source-company-power_us/`
   (`package.json`, `tsconfig.json`, `src/index.ts`,
   `power-us.module.ts`, `power-us.service.ts`,
   `power-us.constants.ts`, `power-us.types.ts`).
2. Service: `createHttpClient` GET `/api/careers`; map each entry to
   `JobPostDto` (`power_us-{linkedinJobId}` id, `linkedInUrl` jobUrl,
   dept/location/jobType, description sections when populated).
3. Register: `site.enum.ts` (`POWER_US = 'power_us'`),
   `packages/plugins/index.ts` `ALL_SOURCE_MODULES`,
   `tsconfig.base.json` paths, `jest.config.js` `moduleNameMapper`.
4. Unit tests with a JSON fixture mirroring the live payload.
5. Docs: `docs/index.md` row, `docs/log.md` entry.

## Risks

- API shape drift (fields renamed) → rows emit with whatever is
  present; never throw on a single entry.
- `linkedInUrl` missing → slug-from-title fallback for `atsId`.
