# Spec: 5084 — Workday pagination never stops when a tenant re-serves page 1

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Spec ID        | 5084                                       |
| Slug           | workday-pagination-no-progress-guard       |
| Status         | done                                       |
| Owner          | agent                                      |
| Created        | 2026-06-28                                 |
| Last updated   | 2026-06-28                                 |
| Supersedes     | (none)                                     |
| Related specs  | 5025, 5037, 5082, 5083, 5085                |

## 1. Problem Statement

`source-ats-workday` pages the CXS jobs endpoint until the **server** hands back a short or empty
page. Both loop exits are properties of the response, not of the client:

```ts
const resultsWanted = input.resultsWanted ?? 100;
while (listingsToEnrich.length < resultsWanted) {
  const listings = (await client.post(apiUrl, { limit: 20, offset, searchText: '' })).data?.jobPostings ?? [];
  if (listings.length === 0) break;              // exit A
  offset += listings.length;
  if (listings.length < WORKDAY_PAGE_SIZE) break; // exit B
}
```

Some Workday tenants answer an **out-of-range offset by re-serving page 1** instead of an empty page.
Two conditions then combine into an unbounded loop:

- the board's job count is an exact multiple of `WORKDAY_PAGE_SIZE` (20), so the loop never sees a
  short page and does request one offset past the end; and
- the tenant wraps that request back to page 1 — a **full** page, forever.

Neither exit can fire. `listingsToEnrich.length` counts pushes, not distinct jobs, so the same 20
jobs re-served look exactly like progress, and `resultsWanted` becomes the only reachable exit.

Measured on two live tenants, same page size (20):

```
wisk.wd108/Wisk_Careers   offset 0  total=20  n=20   offset 20  total=20  n=20 (= page 1, byte-identical)   offset 40  n=20
jsx.wd503/JSX_Careers     offset 0  total=24  n=20   offset 20  total=24  n=4                               offset 40  n=0
```

- JSX is safe on condition 1 alone: its 4-item second page trips exit B, so its out-of-range behavior
  is never exercised.
- A non-wrapping tenant with exactly 20 jobs is safe on condition 2 alone: exit A fires.
- The wrapping tenant with a multiple-of-20 count fails both. Verified on these **2** tenants only;
  how common the wrapping behavior is across Workday is unknown.

Not specific to 20 jobs: any wrapping tenant whose count is a multiple of 20 (40, 60, 100…) behaves
the same, and a board can enter and leave the condition as it gains or loses a posting.

Two consequences, the second worse than the first:

- **A caller with `resultsWanted: 9999` gets a successful 200 containing ~9999 copies of ~20 jobs**
  after ~500 list requests and ~20 minutes. Only a client-side read timeout, or a downstream de-dup
  the caller may or may not have enabled, stands between that payload and the caller's store.
- **A self-inflicted 429 storm.** `buildResponse` → `fetchDetails` issues one detail request per
  entry of `listingsToEnrich` (5 at a time), with no de-dup: the same ~20 detail URLs are requested
  ~500 times each. Observed: hundreds of
  `WARN [HttpClient] Request failed with 429, retrying (1/3) in 1000ms...` lines. Aggravated by
  `workday.service.ts` catching a pagination failure, logging it, and then **enriching the accumulated
  listings anyway** — spending hundreds of requests on a listing set it just declared untrustworthy.

The shared-client shortcomings that storm exposed — retry lines that name no request, and 429 handled
without reading `Retry-After` — are **Spec 5085**, since they affect every HTTP plugin rather than
Workday.

## 2. Goals

- Workday pagination terminates on **client-side** evidence, never solely on server page shape.
- No response can contain more listings than the board has distinct postings.
- Detail enrichment issues at most one request per distinct posting.
- A pagination failure does not fund hundreds of detail requests.
- Detail-failure volume is summarized per scrape rather than left as an unbounded stream of lines.

## 3. Non-Goals

- No change to what Workday fields are scraped, parsed, or mapped, nor to any response shape.
- No page-count cap. Page count cannot distinguish "500 pages because the server repeats itself" from
  "500 pages because the board is large" — measured page-1 totals include `boeing.wd1` 767 (39 pages)
  and `nvidia.wd5` 2000 (100 pages), so any cap low enough to bound the bug truncates real boards, and
  a silently truncated harvest is worse than a loop that announces itself. The no-progress guard
  bounds the waste at one page with no magic number.
- No use of `facets[]` counts as a job-count signal: they are filter counts, not job counts
  (on the wrapping tenant, `locationMainGroup` summed to 0 while three other groups summed to 20),
  they overcount multi-valued facets, and they come from the same response as `total`.
- No HTML scraping of the board for a count: the board is an SPA shell (7,346 bytes, zero requisition
  ids, no count text, no embedded JSON or JSON-LD) rendered from the same CXS endpoint.
- No change to `WORKDAY_PAGE_SIZE`; `limit: 21` on the wrapping tenant returns `total: null` and 0
  postings, so 20 is the ceiling it honors.
- No change to `packages/common` or the shared HTTP client: retry-log attribution and `Retry-After`
  are Spec 5085, independent of this fix and applicable to every plugin.

## 4. Design

### 4.1 Pagination terminates on distinct-job progress

Track distinct postings by `externalPath` while paging (falling back to `title` when a listing has no
path, so a pathless listing is not silently dropped):

- append only listings whose key is new;
- after each page, if it contributed **zero** new listings, stop and log the reason — the server is
  repeating itself, and one wasted page is the entire cost;
- `total` fast path: when `total` is a number **greater than zero**, stop once `offset >= total`. This
  ends the wrapping case on iteration 2 and is free (already in the response). It cannot be the only
  guard: on the wrapping tenant the *real* second page reports `total: 0` (`limit=10, offset=10` →
  `total=0` with 10 genuine new postings), so a naive `offset >= total` would truncate valid boards —
  hence "greater than zero" and hence the no-progress guard is primary;
- `resultsWanted` now bounds **distinct** postings, so a duplicate page can no longer be mistaken for
  progress toward it.

### 4.2 Enrichment cannot multiply requests

- De-dupe by the same key immediately before `fetchDetails`, so even a future pagination bug cannot
  fan out to more detail requests than there are distinct postings.
- On a pagination failure (`diagnostics` set), **skip enrichment**: return the diagnostics-carrying
  empty response rather than spending hundreds of requests on an untrustworthy listing set.

### 4.3 Failure volume is summarized

Detail failures name the tenant, and each scrape logs one `N of M detail requests failed` line, so a
caller reading the log sees the scale of a failure without counting lines.

## 5. Changes

1. `packages/plugins/source-ats-workday/src/workday.constants.ts` — `workdayListingKey` helper.
2. `packages/plugins/source-ats-workday/src/workday.service.ts` — distinct-progress pagination,
   `total` fast path, de-dupe before enrichment, no enrichment after a pagination failure, detail
   failure summary.

## 6. Test Plan

- Workday, wrapping tenant: a fake client that returns page 1 for every offset yields **20** jobs
  (not `resultsWanted`), issues **2** list requests, and **20** detail requests.
- Workday, honest multi-page tenant (24 jobs, 20 + 4): still yields 24 with no premature stop, proving
  the guard does not truncate.
- Workday, real second page reporting `total: 0`: still paged (zero/absent `total` ignored).
- Workday, `resultsWanted` smaller than the board: bounds distinct postings.
- Workday, pagination throws: no detail requests, diagnostics preserved.
- `npx tsc --noEmit` clean; `npm run lint:docs` clean; touched suites green.
