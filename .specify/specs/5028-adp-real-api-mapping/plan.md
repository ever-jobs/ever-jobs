# Plan: 5028 — ADP plugin mapped to the real WorkforceNow staffing API

| Field | Value |
| --- | --- |
| Spec ID | 5028 |
| Status | implemented |
| Created | 2026-06-30 |

## Phases

1. **Constants** — rewrite `adp.constants.ts`:
   - `ADP_HOSTS` (primary + cloud), `adpListUrl(host, cid)`,
     `adpDetailUrl(host, cid, itemId)`, `adpCareersUrl(host, cid, itemId)`,
     `ADP_DETAIL_CONCURRENCY`.
2. **Types** — rewrite `adp.types.ts` to the real payload (`itemID`,
   `requisitionTitle`, `requisitionDescription`, `postDate`,
   `requisitionLocations`, `workLevelCode`, `payGradeRange`, `customFieldGroup`).
3. **Service** — rewrite `adp.service.ts`:
   - `fetchList` — try each host, keep the first that returns a
     `jobRequisitions` array.
   - `fetchDetails`/`fetchDetail` — bounded-concurrency overlay
     (`Promise.allSettled`, fail-safe) for `requisitionDescription`.
   - `mapJob` — canonical field mapping; locations via `parseLocationList`,
     compensation via `resolveCompensation` + a "SalaryRange" interval parser.
4. **Test** — add `__tests__/adp.service.spec.ts` (mapping+detail overlay, host
   fallback, no-open-reqs, detail-failure fallback, no-host).
5. **Verify** — run the ADP suite; typecheck the package + API build; docs-lint.

## Packages touched

- `packages/plugins/source-ats-adp` (src + new `__tests__`).

## Risks

- ADP custom-field names vary by tenant, so the "SalaryRange" interval parser may
  not find a period on some boards; the amounts still map and the interval is
  simply omitted (no wrong guess).
- Only two hosts are known; a future third host would need adding to `ADP_HOSTS`.
  Trying hosts in series adds one extra (cached-404) request for `.cloud.`
  companies — acceptable given the per-company cost.
