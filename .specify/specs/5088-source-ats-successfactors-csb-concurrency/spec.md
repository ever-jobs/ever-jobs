# Spec: 5088 — SuccessFactors CSB concurrency

| Field          | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Spec ID        | 5088                                                    |
| Slug           | source-ats-successfactors-csb-concurrency             |
| Status         | in progress                                             |
| Owner          | agent                                                   |
| Created        | 2026-08-30                                              |
| Last updated   | 2026-08-30                                              |
| Supersedes     | (none)                                                  |
| Related specs  | 5055, 5087                                              |

## 1. Problem Statement

`SuccessFactorsService.scrapeCsb()` harvests Career Site Builder (CSB) portals by:

1. Walking `tile-search-results` pages one at a time.
2. Sleeping `SF_DELAY_MIN` to `SF_DELAY_MAX` (1.5–3 s) between each page.
3. Fanning out detail-page fetches with a concurrency of `SF_CSB_DETAIL_CONCURRENCY = 5`.

For a tenant with ~180 jobs and 25 jobs per page, this yields 8 tile pages and ~180 detail fetches. The serial tile walk plus the per-page sleep adds ~15–20 s, and the detail fan-out with concurrency 5 adds another ~10–15 s. A full-board `resultsWanted=9999` scrape therefore takes ~35–40 s, which exceeds upstream callers' 30 s timeout.

## 2. Goals

- Reduce the end-to-end CSB harvest time for medium-to-large boards to well under 30 s.
- Keep the same job count and output shape.
- Avoid triggering rate limits or anti-bot blocks.

## 3. Non-Goals

- No change to OData or native HTML fallback paths.
- No change to `companyUrl`/slug resolution logic.
- No new retry/back-off policy; `HttpClient` already handles retries.
- No increase in the CSB page size; the server ignores the `count` query parameter and always returns 25 jobs per page.

## 4. Design

### 4.1 Concurrent tile pages

Replace the serial `collectCsbTiles` loop with a batched loop that fetches up to `SF_CSB_PAGE_CONCURRENCY` (default 4) tile pages concurrently using `Promise.allSettled`. The batch is processed in startrow order; if a page returns no jobs, no new ids, or an error, the loop stops before starting the next batch. This preserves the existing "stop on empty/duplicate page" semantics while removing the artificial `randomSleep` between pages.

### 4.2 Higher detail concurrency

Raise `SF_CSB_DETAIL_CONCURRENCY` from `5` to `10`. Detail pages are independent, idempotent, and served by the same CSB origin; a higher concurrency reduces the detail phase by roughly half without a measurable increase in errors in live probes.

### 4.3 Constants

Add in `successfactors.constants.ts`:

- `SF_CSB_PAGE_CONCURRENCY = 4` — number of tile-search-results pages fetched concurrently.

Update:

- `SF_CSB_DETAIL_CONCURRENCY = 10` — number of detail pages fetched concurrently.

Remove the per-page `randomSleep` call from `collectCsbTiles`. A small inter-batch sleep can be added later if telemetry shows rate-limiting; live probes with no sleep completed without 429s for the tested tenant.

### 4.4 Ordering and de-duplication

`collectCsbTiles` still accumulates `SfCsbListItem[]` and deduplicates by `jobId`. Processing results in startrow order ensures the first empty/duplicate page terminates the walk; any concurrently fetched later pages in the same batch are ignored once termination is detected.

## 5. Acceptance

- `SuccessFactorsService.scrape()` for a CSB tenant with ~180 jobs and `resultsWanted=9999` completes in less than 15 s in live probes.
- The job count matches the pre-change value for the same tenant.
- All existing `source-ats-successfactors` Jest tests pass.
- `tsc --noEmit` is clean for the package.
- New unit tests verify that `collectCsbTiles` stops when a batch contains an empty/duplicate page.

## 6. Risks

- Higher concurrency may trigger rate limiting on some CSB tenants. The `HttpClient` retry/back-off path handles `429 Retry-After`, but if a tenant is stricter we may need to dial `SF_CSB_PAGE_CONCURRENCY` or `SF_CSB_DETAIL_CONCURRENCY` back down.
- Concurrent tile fetching may make the "stop on empty page" heuristic slightly more expensive if the last batch contains pages beyond the end of the list; the waste is bounded to one batch.
- This is a performance change scoped to CSB; it does not address the separate `urlopen` timeout in upstream callers.
