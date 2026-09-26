# Plan: 5128 — Dover job-groups (department) and per-job apply links

| Field | Value |
| --- | --- |
| Spec ID | 5128 |
| Status | implemented |
| Created | 2026-09-16 |

## Phases

1. **Constants** — add `DOVER_JOB_GROUPS_API_TEMPLATE`
   (`/api/v1/job-groups/{id}/job-groups`) and `DOVER_APPLY_URL_TEMPLATE`
   (`/apply/{slug}/{jobId}`) to `dover.constants.ts`.
2. **Types** — add `DoverJobGroup` (`{ id, name, jobs: DoverListJob[] }`) and a
   `department` field on the normalised `DoverJob` in `dover.types.ts`.
3. **Service** — in `dover.service.ts`:
   - `fetchJobGroups(client, clientId)` → `Map<jobId, groupName>`; HTTP 4xx or a
     malformed payload degrades to an empty map;
   - `assemble()` gains the department lookup; `url` becomes
     `apply/{slug}/{jobId}` when `slug` is set, else the careers-page fallback;
   - `toJobPost()` sets `department`, and `jobUrl`/`applyUrl` from the new url.
4. **Tests** — extend the mocked `dover.service.spec.ts` routing table with a
   `JOB_GROUPS_RE` route; add the spec's cases.
5. **Verify** — `source-ats-dover` jest suite; `apps/api` `tsc --noEmit`;
   `lint:docs`.

## Packages touched

- `packages/plugins/source-ats-dover` (`src/dover.constants.ts`,
  `src/dover.types.ts`, `src/dover.service.ts`,
  `__tests__/dover.service.spec.ts`).

## Risks

- Undocumented endpoint; mitigated by graceful empty-map degradation and the
  mocked suite + live e2e tenant.
- A role listed in `careers-page/{id}/jobs` but absent from all groups keeps
  `department` unset — correct-by-construction fallback.
