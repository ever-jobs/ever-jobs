# Spec: 5133 — ADP requisition-list pagination

| Field | Value |
| --- | --- |
| Spec ID | 5133 |
| Slug | adp-list-pagination |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-17 |
| Related specs | — |

## Problem

`source-ats-adp` fetched the requisition list once. The endpoint
(`/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions?cid=`)
caps a response at 20 requisitions and reports the real total in
`meta.totalNumber`, so boards larger than 20 were silently truncated to page
1 — verified live on four tenants (`totalNumber` 160 / 230 / 67 / 36, all
returning 20).

## Contract

- Page the list with `&$skip=N&$top=20` (the API ignores `$top` above 20).
- Walk pages until the accumulated set covers `meta.totalNumber`, a page
  returns nothing new (empty or all-duplicate `itemID`s), or a page fetch
  fails — partial results are kept rather than discarded.
- `meta.totalNumber` absent → single page (unchanged behavior).
- `resultsWanted` still slices after the full list is collected.

## Verified live

- One tenant: pages at `$skip` 0/20/…/160 returned 19+20×7+1 = 160 unique
  requisitions, matching `totalNumber: 160`; post-fix `scrape()` returns 160
  jobs with unique ids.

## Non-goals

- Detail-fetch concurrency unchanged (`ADP_DETAIL_CONCURRENCY` = 5).
- No change to detail/careers URL construction beyond the `$skip`/`$top`
  query args on the list endpoint.
