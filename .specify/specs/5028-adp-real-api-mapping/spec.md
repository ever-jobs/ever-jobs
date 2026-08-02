# Spec: 5028 — ADP plugin mapped to the real WorkforceNow staffing API

| Field | Value |
| --- | --- |
| Spec ID | 5028 |
| Slug | adp-real-api-mapping |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-30 |
| Last updated | 2026-06-30 |
| Related specs | 5014, 5015, 5016, 5018 |

## Problem

`source-ats-adp` returned **zero jobs for all 5 companies known to use ADP that
were checked** (4 of which have open requisitions it should have surfaced) — a
clean empty array, no error — so it looked healthy while silently producing
nothing. Two independent root causes:

1. **Wrong field names.** The plugin read a hand-guessed shape (`jobTitle`,
   `jobRequisitionId`, `jobDescription`, `locations[].city/stateProvince`,
   `postedDate`, `employmentType`, `compensation.minPay`) that the public ADP
   WorkforceNow career-center staffing API does **not** emit. The real list item
   uses `requisitionTitle`, `itemID`, `requisitionLocations[].nameCode.shortName`
   (+ structured `address`), `postDate`, `workLevelCode.shortName`, and
   `payGradeRange.minimumRate/maximumRate.amountValue`; the posting body
   (`requisitionDescription`) is **detail-only**. Because `requisitionTitle` was
   never read, the `if (!title) return null` guard dropped every requisition.
2. **Single hardcoded host.** The endpoint was pinned to
   `workforcenow.adp.com`. ADP Workforce Now is served from at least two hosts —
   `workforcenow.adp.com` and `workforcenow.cloud.adp.com` — and a given company
   lives on exactly one (the other returns HTTP 404). Any `.cloud.`-hosted
   company therefore 404'd and returned zero regardless of the field bug.

The plugin also fetched only the list endpoint, so even with correct field names
the posting body would have been null on every job (it lives only on the
per-requisition detail endpoint).

## Scope

- Rewrite `adp.types.ts` to the real list/detail payload shape.
- Resolve the host by trying `workforcenow.adp.com` then
  `workforcenow.cloud.adp.com`, keeping whichever returns a `jobRequisitions`
  payload (an empty array still counts as "resolved" — a company with no open
  reqs).
- Overlay each listing with its per-requisition detail
  (`.../job-requisitions/{itemID}?cid={cid}`) under bounded concurrency
  (`ADP_DETAIL_CONCURRENCY = 5`, `Promise.allSettled`, fail-safe) to pull
  `requisitionDescription`.
- Map the canonical fields:
    - `title` ← `requisitionTitle`
    - `id` / `atsId` ← `itemID`
    - `description` ← detail `requisitionDescription` (rendered per
      `descriptionFormat`)
    - `location` + `isRemote` + `workFromHomeType` ← `requisitionLocations`
      labels through the shared `parseLocationList`
    - `datePosted` ← `postDate` (via `toDateOnly`)
    - `employmentType` / `jobType` ← `workLevelCode.shortName`
    - `compensation` ← `payGradeRange` (structured-first via
      `resolveCompensation`); interval read from the "SalaryRange" custom field
    - `jobUrl` ← human-facing `recruitment.html?cid=&jobId=itemID` on the
      resolved host

## Non-goals

- No change to the shared `parseLocationList` / `resolveCompensation` helpers.
- No structured remote *flag* invented: ADP exposes none, so `isRemote` is
  inferred from the location labels only (mirroring the greenhouse approach in
  5027 of using the ATS's only machine-readable evidence).
- No authenticated ADP API path (the public career-center API is unauthenticated).
- No plugin imports another plugin.

## Contracts

- `JobPostDto` shape unchanged.
- A company on either ADP host resolves; the other host's 404 is swallowed.
- A company with no open requisitions yields an empty `JobResponseDto` (not an
  error).
- A failed per-job detail fetch degrades to the list-only mapping for that job
  (description `null`), never nuking the batch.
- `companyName` is left `null`: the public payload carries no human-readable
  company name (the `cid` is an opaque GUID), so aggregation fills it instead of
  surfacing the GUID.

## Test plan

- **ADP service** (mocked HTTP), new `__tests__/adp.service.spec.ts`:
    - maps the real list shape + overlays the detail-only `requisitionDescription`;
      asserts title, location (`Washington`/`DC`), employmentType, compensation
      (225000–275000 USD yearly), ids, and jobUrl.
    - falls back to `workforcenow.cloud.adp.com` when the primary host 404s; a
      `Remote, US` location label yields `isRemote: true` /
      `workFromHomeType: 'Remote'`.
    - a company with no open reqs → empty result.
    - a failed detail fetch → job still maps from the list (description `null`).
    - no host resolves → empty result.
