# Plan: 5036 — source-ats-appone

| Field | Value |
| --- | --- |
| Spec ID | 5036 |
| Status | implemented |
| Created | 2026-06-28 |

## Packages touched

- `packages/plugins/source-ats-appone` (new) — service, constants, types, module,
  index, unit tests.
- Registration: `packages/models/src/enums/site.enum.ts`,
  `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`.

No core or shared-helper changes (reuses `createHttpClient`, `extractEmails`,
`resolveCompensation`, `getJobTypeFromString`).

## Phases

1. **Scaffold.** New package (package.json, tsconfig, index, module) plus the
   `Site.APPONE` enum value and the three other registration entries.
2. **Constants/types.** List + detail endpoints, headers, concurrency/cap
   constants; model `ApponeCompanyJobPosts` / `ApponeJobPost` / `ApponeJobPosting`.
3. **Service.** Resolve tenant (`companySlug` or `companyUrl` path segment), fetch
   the list, cap to `resultsWanted`, overlay each detail under
   `Promise.allSettled`, and map to `JobPostDto`.
4. **Tests.** Mocked-HTTP unit suite per the spec test plan.

## Risks

- **Per-posting fan-out.** N extra GETs per tenant; bounded by
  `APPONE_DETAIL_CONCURRENCY` and applied only after the `resultsWanted` cap.
- **Free-text pay.** AppOne exposes no structured pay; the shared salary
  extractor parses bounded ranges from the body and yields nothing when none is
  present (no false positives).
- **Single tenant verified.** Mapping is verified read-only against one live
  tenant (vansaircraftcareers); the JSON shape is assumed stable across tenants.
