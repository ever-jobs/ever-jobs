# Spec 5159

| Field | Value |
| ----- | ----- |
| Title | Workday: emit department from the jobFamilyGroup search facet |
| Status | Implemented |
| Package | `packages/plugins/source-ats-workday` |

## Problem

The public Workday CXS board UI offers a "Job Category" drop-down, but the
category is not part of the per-job payloads the plugin consumes:

- the list endpoint (`POST /wday/cxs/{company}/{site}/jobs`) emits no
  per-listing category field, and
- the detail endpoint's `jobPostingInfo` only carries `jobFamily` on some
  tenants — on others the field is absent entirely, leaving `department` null.

The category does exist server-side: every list response carries a `facets`
array whose `jobFamilyGroup` entry enumerates the board's categories with
value ids and per-value job counts, and the endpoint honors
`appliedFacets: { jobFamilyGroup: [valueId] }` to return only the postings in
that bucket. So each posting's category is recoverable as "the bucket that
returns it", at the cost of one paginated pass per category value.

## Goals

1. When a board advertises a `jobFamilyGroup` facet, build a
   jobPostingId → category map by paginating every facet value, and emit it
   as `JobPostDto.department`.
2. Run the bucketed pass in parallel with the existing unfiltered list pass
   (two coarse streams; each internally sequential with the existing 1–2 s
   courtesy sleep — never more than ~2 requests in flight).
3. Degrade silently when facets are absent: no extra requests, current
   behavior preserved.
4. Bound the added work: cap the number of facet values paginated
   (`WORKDAY_CATEGORY_FACET_CAP = 50`); a failed bucketed page or a failed
   stream yields a partial/empty map, never a failed scrape.

## Non-goals

- No intra-path parallelism: list pages and bucket pages each stay sequential.
- No attempt to derive categories for jobs not returned by any bucket.
- No change to detail enrichment (already parallel at concurrency 5).

## Design

`scrape()` fetches page 1 once (unfiltered) — it seeds both the listing set
and the facet catalog, so enumerating categories costs zero extra calls.
Then two streams run via `Promise.allSettled`:

- **Stream A** — the existing paginated list pass, resuming after the seed
  page (identical stop conditions, dedupe, and courtesy sleep).
- **Stream B** — for each `jobFamilyGroup` value: sequential
  `appliedFacets`-filtered pagination; every returned listing records
  `categoryMap[workdayListingKey(listing)] = facet.descriptor`. Stops a
  bucket on an empty page, a short page, or reaching `total`; sleeps between
  requests like stream A; a failed bucket logs a warning and continues.

Department precedence in `processListing` (most specific first):
`jobFamily[0].name` (per-job detail field) → facet category →
`subtitles[0]` (existing heuristic) → null.

Cost model (B board jobs, C categorized, N categories, page size 20):
`ceil(B/20) + sum(ceil(n_c/20)) + N` ≤ ~2× the old list pass — overhead
self-limits when coverage is low because bucketing only pays for categorized
jobs.

## Test plan

- Listing page carries `jobFamilyGroup` facet → department populated from
  the bucket, `jobFamily` still wins when both present, subtitles still win
  when facet absent from a job's bucket.
- Uncategorized jobs (in no bucket) keep the pre-change fallback chain.
- No `jobFamilyGroup` facet → zero extra requests beyond the list pass.
- Bucketed stream failure → jobs still emitted, departments fall back.
- More than `WORKDAY_CATEGORY_FACET_CAP` values → bucketing skipped.
- Bucketed `appliedFacets` payload asserted on the POST body.
