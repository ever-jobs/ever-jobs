# Plan: 5033 — Dover real API mapping (full rewrite)

| Field | Value |
| --- | --- |
| Spec ID | 5033 |
| Status | implemented |
| Created | 2026-06-28 |

## Phases

1. **Constants** — rewrite `dover.constants.ts` for the real surface: API origin,
   slug-resolve / careers-page / jobs-list / detail templates, board + careers
   URL builders, `DOVER_UUID_REGEX`, `DOVER_BOARD_PATH_REGEX` (extended for
   `/apply/{name}`), `DOVER_REMOTE_WORKPLACE`, headers, and a
   `doverCompensationInterval` wrapper over the shared `getCompensationInterval`.
2. **Types** — rewrite `dover.types.ts` to model the real wire shapes:
   `DoverCareersPage`, `DoverListJob`, `DoverJobsResponse`, `DoverJobDetail`,
   `DoverCompensation`, `DoverLocation`/`DoverLocationOption`, and a normalised
   `DoverJob`.
3. **Service** — rewrite `dover.service.ts`:
   - resolve the token from `companySlug` / `companyUrl`
     (slug / UUID / name / `/jobs`,`/apply`,`/careers` URL forms);
   - resolve the careers-page client id (UUID lookup or slug variants);
   - list roles via `careers-page/{id}/jobs`, following `next`, excluding
     `is_sample`;
   - per role, GET the `application-portal-job` detail overlay;
   - assemble + map to `JobPostDto`: title, companyName (`client_name`), body,
     location, employmentType, `datePosted`, `isRemote`, structured-first
     compensation, ids/urls;
   - graceful degradation throughout (no throw on 4xx).
4. **Tests** — add the mocked `dover.service.spec.ts`; refresh the e2e header
   comment + `KNOWN_TENANT` to the real contract (keep it live + zero-tolerant).
5. **Verify** — `source-ats-dover` jest suite; `apps/api` `tsc --noEmit`;
   `lint:docs`.

## Packages touched

- `packages/plugins/source-ats-dover` (`src/dover.constants.ts`,
  `src/dover.types.ts`, `src/dover.service.ts`,
  `__tests__/dover.service.spec.ts`, `__tests__/dover.e2e-spec.ts`).

## Risks

- Undocumented, reverse-engineered API; mitigated by graceful empty-on-drift and
  the live e2e suite + the fetch1 harness probe.
- Heuristic slug derivation; a careers-page UUID or board URL always resolves
  deterministically, so callers with an exact identifier are unaffected.
