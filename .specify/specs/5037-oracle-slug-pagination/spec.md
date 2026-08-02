# Spec: 5037 — oracle-slug-pagination (colon-slug addressing + pagination fix)

| Field | Value |
| --- | --- |
| Spec ID | 5037 |
| Slug | oracle-slug-pagination |
| Status | implemented |
| Owner | agent |
| Created | 2026-07-07 |
| Last updated | 2026-07-07 |
| Related specs | 013 |

## Problem

The Oracle plugin (Spec 013) has three bugs that surface when a real tenant
board is addressed by `companySlug`:

1. **Slug format mismatch (0 jobs).** Callers pass `{subdomain}:{siteNumber}`
   (e.g. `acme-saasfaprod1:CX_1`). `composeUrlFromSlug` assumes
   `{subdomain}-{region}` and splits on the last dash, producing an invalid URL
   (the colon makes the `URL` constructor treat the right half as a port) ->
   `ERR_ORACLE_BAD_TENANT` -> 0 jobs.

2. **`siteNumber` not derived from the slug/URL.** The site (`CX_1`) lives in
   the slug (`:CX_1`) and in the CandidateExperience URL path
   (`/sites/CX_1`), but the plugin reads it only from `input.siteNumber`,
   defaulting to `CX_45001`. Wrong site -> wrong job set.

3. **Under-pagination (199 vs 244).** The pagination loop breaks on the first
   page shorter than `ORACLE_RECORDS_PER_PAGE` (100). Oracle returns short
   pages mid-run (offset 0->100, 100->99, 200->44 for a 244-job board), so
   the scrape stops at 199 instead of 244. Pagination must terminate on
   `TotalJobsCount` / empty page, not a short-page heuristic.

## Scope

- Fix slug resolution to accept the colon-delimited `{host-or-subdomain}:{siteNumber}` form.
- Extract `siteNumber` from the slug (`:CX_…`) and from `companyUrl` path (`/sites/CX_…`).
- Fix pagination to use `TotalJobsCount` instead of the short-page heuristic.
- Keep the legacy `{subdomain}-{region}` slug form working for back-compat.

## Non-goals

- Adding new fields (description, compensation, employment type) — deferred to Spec 016.
- Changing the `ScraperInputDto` schema (the existing `siteNumber` field suffices).
- Upstream slug-emission changes in the calling system (out of scope for this plugin).

## Contracts

### Accepted `companySlug` forms

| Form | Example | Host resolution |
| --- | --- | --- |
| `{fullHost}:{siteNumber}` | `fa-esbv-saasfaprod1.fa.ocs.oraclecloud.com:CX_1` | verbatim (preferred) |
| `{subdomain}:{siteNumber}` | `fa-esbv-saasfaprod1:CX_1` | compose `.fa.ocs.oraclecloud.com` |
| `{subdomain}-{region}` | `eeho-us2` | legacy compose `.fa.{region}.oraclecloud.com` |
| `{fullHost}` | `ewvl.fa.us8.oraclecloud.com` | verbatim, default site |

### `siteNumber` precedence

1. `input.siteNumber` (explicit override)
2. Slug-derived (`:CX_1` after colon)
3. URL-derived (`/sites/CX_1` in `companyUrl` path)
4. `ORACLE_DEFAULT_SITE_NUMBER` (`CX_45001`)

### Pagination termination

- Stop when `collected.length >= min(TotalJobsCount, resultsWanted)`.
- Stop on empty `requisitionList[]` (safety net).
- Hard ceiling `ORACLE_MAX_PAGES` (50) unchanged.

## Test plan

- Unit tests for every slug form (full-host:site, bare-sub:site, full-host us8,
  siteNumber override, URL-path extraction).
- Unit test proving short mid-pages don't stop pagination (100+99+45 -> 244).
- Live validation against 4 tenants (pod / region / site -> jobs):
  - `fa.ocs` / CX_1 -> 243 (API reports 244; offset pagination yields 243)
  - `fa.us8` / CX_1 -> 19
  - `fa.us8` / CX_2 -> 96
  - `fa.us6` / CX -> 158
