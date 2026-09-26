# Spec: 1709 — Solid.Jobs full coverage: every division, paging, client-side filters, full mapping

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| Spec ID        | 1709                                   |
| Slug           | solidjobs-full-coverage                |
| Status         | done                                   |
| Owner          | agent                                  |
| Created        | 2026-09-25                             |
| Last updated   | 2026-09-25                             |
| Supersedes     | (none) — follow-up to 718              |
| Related specs  | 718, 1696, 1697, 1699, 5082, 5024      |

## 1. Problem Statement

Spec 718 shipped `source-solidjobs` against the public offers endpoint
`GET https://solid.jobs/public-api/offers/{division}?campaign=api`. Three gaps
kept most of the board out of reach:

| Where (pre-1709) | What | Effect |
|---|---|---|
| `resolveDivisions()` | Falls back to `['it']` | The seven non-IT divisions were never fetched unless an operator set `SOLIDJOBS_DIVISIONS`. |
| `buildDivisionUrl()` | Sends only `campaign` | The server's default page is 500 offers, so at most 500 per division were ever seen. |
| `scrape()` | One `Promise.allSettled` over all divisions | No paging loop; every division fired at once. |
| `matchesSearch()` | Whole term as one substring of one field | `java senior`, `react typescript` never matched; `sprzedaz` did not match `Sprzedaż`. |
| `mapJob()` | Leaves `datePosted`, `companyLogo`, `skills`, `jobLevel`, `jobFunction`, `workFromHomeType`, `employmentType`, the country unset | Freshness filters, logos, skill facets, seniority and hybrid never applied. |
| `scrape()` catch | `allSettled` never throws | Every division failing looked exactly like an empty board. |
| `SOLIDJOBS_HEADERS` | Pinned a desktop-browser User-Agent over `input.userAgent` | Not needed: the honest UA is served. |

Measured on 2026-09-24, a default scrape could reach at most 500 of 1,707 IT
offers and none of the ~2,055 non-IT offers — about 3,260 of ~3,760 live
offers were never fetched.

## 2. Goals

- **Coverage.** Page through each division and scan all eight divisions by
  default, stopping as soon as `offset + resultsWanted` matching offers are
  held.
- **Fidelity.** Emit every field the payload already carries.
- **Filtering.** Honour `searchTerm` (token-based, diacritic-insensitive),
  `location`, `isRemote`, `jobType`, `hoursOld` and `offset` client-side — the
  server ignores filter parameters.
- **Honest failure reporting.** A failed division or page surfaces as a
  diagnostic instead of a silent short or empty list.
- **Keep every Spec 718 behaviour reachable** (owner rule): each behaviour
  change has an env switch back.

## 3. Non-Goals

- Server-side filter parameters (previously observed to be ignored; never sent).
- `pageSize > 500` or `pageIndex >= totalPages` (not probed; never sent).
- A country filter: the board is Poland-only and `ScraperInputDto` defaults
  `country` to USA, so a hard filter would zero this source in every default
  fan-out.
- A crawl manifest on the decorator: `IPluginMetadata` has no `crawl` field in
  this tree yet (follow-up).

## 4. User / Caller Stories

> As an **API caller**, I want a Solid.Jobs search for `handlowiec` to reach
> the sales division, so that non-IT roles are findable at all.

> As an **API caller**, I want `hoursOld`, `location` and `jobType` to narrow
> Solid.Jobs results, so that this source behaves like its siblings.

> As an **operator**, I want a failed Solid.Jobs division to show up in the
> per-source diagnostics, so that an outage is not mistaken for an empty board.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | Default division list is all eight public divisions, largest first: `it, sales, marketing, logistics, finances, engineering, other, hr`. | must |
| FR-2  | `SOLIDJOBS_DIVISIONS` (comma-separated) replaces the list, lower-cased, trimmed, de-duplicated, in the operator's order; search hints never reorder it. | must |
| FR-3  | Without the override, divisions whose hint stems start a word of the folded search term move to the front (stable); every division stays eligible. | should |
| FR-4  | Requests carry `campaign`, `pageSize`, `pageIndex` in that order. Unfiltered: `pageSize = min(500, offset + resultsWanted)`; filtered: 500. | must |
| FR-5  | Pages within a division are sequential. Stop on: enough matches through this division, empty page, no new offers (server ignores `pageIndex`), a page wholly older than `hoursOld`, the last page (`totalPages`, or a short page without an envelope), 20 pages, or the time budget. | must |
| FR-6  | At most 2 divisions in flight. Unfiltered, a new division starts only once the in-flight divisions' `totalCount` shows they cannot fill the request; filtered, divisions overlap. | must |
| FR-7  | Merge in division order (not completion order), de-duplicate by `jobOfferKey`, then `slice(offset, offset + resultsWanted)`. | must |
| FR-8  | `searchTerm`: every token (split on whitespace, `/`, `,`) of the folded term occurs in the folded title, company, division, category, sub-category, experience level or a skill name. `ł`/`Ł` fold to `l`/`L`. | must |
| FR-9  | `location`: country words (`Poland`, `Polska`, `PL`, `cała Polska`) are dropped; `remote`/`zdalnie`/`praca zdalna` mean remote; `Warsaw`/`Cracow`/`Breslau`/`Danzig` map to the Polish spelling; the needle matches an offer location as whole words, in either direction. | must |
| FR-10 | `isRemote` filters only when `true`. `jobType`: FULL_TIME/PART_TIME read `contractTime`; CONTRACT = a B2B/UZ/UoD primary or secondary salary; INTERNSHIP = intern/trainee/staż/praktyk in the experience level or title; anything else matches nothing. | must |
| FR-11 | `hoursOld` keeps offers whose `validFrom` (else `updatedAt`) is inside the window; an undated offer is kept. | must |
| FR-12 | Mapping: `datePosted` (source calendar day) plus the Spec 1696 instant fields; `companyLogo` only for absolute http(s) URLs; `skills` trimmed and de-duplicated case-insensitively; `jobLevel` = experience level; `jobFunction` = humanised category (`B2BSales` → `B2B Sales`); `workFromHomeType` from `isRemote`/`isHybrid`; `employmentType` = distinct contract codes of both salaries (`UZ, B2B`); compensation falls back to `secondarySalary`; `countryCode = 'PL'`; `location.country` and every `locations[]` entry default to `Country.POLAND`. | must |
| FR-13 | Diagnostics: failures and fewer jobs than wanted → the first failure's classification (the fan-out infers `partial` when jobs > 0); failures but enough jobs → none (logged); budget reached and fewer jobs than wanted → `partial`, or `timeout` with no jobs; an invalid payload counts as a failure (`unknown`). | must |
| FR-14 | HTTP: `userAgent = input.userAgent` or the honest constant; `retries`, `retryDelay`, `retryBackoff`, `retryMaxDelay`, `rateDelayMin`, `rateDelayMax`, `requestTimeout` pass through; headers no longer pin a User-Agent. | must |
| FR-15 | Env switches restore Spec 718 behaviour: `SOLIDJOBS_PAGINATE=false`, `SOLIDJOBS_SEARCH_MODE=phrase`, `SOLIDJOBS_INPUT_FILTERS=false`, `SOLIDJOBS_DIVISIONS=it`. | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Requests for a default fan-out (15 results, no filter) | 1 |
| NFR-2  | Requests in flight to solid.jobs | ≤ 2 |
| NFR-3  | Wall-clock budget per scrape | 90 s (under the 120 s fan-out deadline); `SOLIDJOBS_TIME_BUDGET_MS` overrides |
| NFR-4  | Requests per scrape, worst case | 8 divisions × 20 pages; ~12 for a full scan today |

## 7. Contracts

### 7.1 API / Interface

```ts
GET https://solid.jobs/public-api/offers/{division}?campaign=api&pageSize={1..500}&pageIndex={0-based}
Accept: application/json

interface SolidJobsResponse {
  jobs: SolidJobsOffer[];
  pageIndex?: number;
  pageSize?: number;
  totalCount?: number;
  totalPages?: number;
}
// SolidJobsOffer gains `secondarySalary?: SolidJobsSalary | null`;
// employmentType now also "UoD".
```

Env vars (all read on every scrape):

| Variable | Default | Effect |
|---|---|---|
| `SOLIDJOBS_DIVISIONS` | unset (all 8) | Division list, operator order. `it` = Spec 718 scope. |
| `SOLIDJOBS_PAGINATE` | on | `false`/`0`/`no`/`off` = one un-paged `?campaign=api` request per division. |
| `SOLIDJOBS_SEARCH_MODE` | `tokens` | `phrase` (alias `legacy`) = the Spec 718 whole-phrase matcher. |
| `SOLIDJOBS_INPUT_FILTERS` | on | `false`/`0`/`no`/`off` = ignore `location`, `isRemote`, `jobType`, `hoursOld`. |
| `SOLIDJOBS_TIME_BUDGET_MS` | 90000 | Wall-clock budget. |
| `EVER_JOBS_POSTED_TIME_DETAIL` | on | (Spec 1696) `false` = emit `datePosted` only. |

### 7.2 Errors

| Reason | When |
| ------ | ---- |
| `fetch_error` / `timeout` / `blocked` / … | First failed page, via `classifyScrapeError`, when fewer jobs than wanted were returned. |
| `unknown` | A page answered without a `jobs` array. |
| `partial` | Time budget reached with some jobs; detail `time budget N ms reached; scanned X/Y divisions`. |
| `timeout` | Time budget reached with no jobs. |

## 8. Test Plan

- Unit (`__tests__/solidjobs.service.spec.ts`): the Spec 718 suite, updated for
  the new URLs, the board-level country, de-duplication and diagnostics.
- Unit (`__tests__/solidjobs.coverage.spec.ts`): paging, early stop, legacy
  envelope, ignored `pageIndex`, page cap, division order under a delayed
  mock, hint ordering, override order, the two-in-flight ceiling, token search,
  location / isRemote / jobType / hoursOld / offset filters, every mapped
  field, diagnostics (page failure, all timeouts, budget partial/timeout),
  User-Agent and option pass-through, and every env switch.
- Unit (`__tests__/solidjobs.filters.spec.ts`): the pure helpers.
- Mutation controls: concurrency 8, speculative unfiltered starts, no `ł`
  fold, no `hoursOld` page stop and no diagnostics each turn the suite red.
- E2E (`__tests__/solidjobs.e2e-spec.ts`, live): ≤ 3 results per test; field
  shape, token search, a non-IT division.

## 9. Open Questions

(none)

## 10. Decisions

- **D-01 — Unfiltered scans do not speculate.** The design's worker pool would
  start two divisions at once even when the first page of `it` fills the
  request. Unfiltered, every offer counts, so the scheduler waits for the
  in-flight division's `totalCount` and starts another only if the known totals
  cannot fill the request. A default fan-out is one request, as FR/NFR-1 state.
  Filtered scans still overlap two divisions, since a division's yield is only
  known once read.
- **D-02 — Stop on the prefix, not only per division.** A division stops paging
  once the divisions up to and including it hold `need` matches (current
  counts are lower bounds on the final ones), so the first `need` offers of the
  division-ordered merge are the same whichever request finishes first.
- **D-03 — Whole-word location matching.** Plain substring containment would
  match `Koło` for a `Kołobrzeg` search. Needle and offer location are reduced
  to letter/digit words and compared as whole consecutive words, which still
  matches `Warszawa, Mazowieckie` against `Warszawa` and `Warszawa-Wola`
  against `warszawa`.
- **D-04 — Hint stems start a word.** `hr` must not fire on `chrome`, nor `cad`
  on `academy`. A stem that starts with punctuation (`.net`) matches anywhere.
- **D-05 — An invalid payload is a failure.** A 200 without a `jobs` array is
  reported (`unknown`), not treated as an empty division.
- **D-06 — Spec 1696 posting-time fields.** `datePosted` comes from
  `postedTimeFields(postedFromTimestamp(validFrom || updatedAt))`, which keeps
  the `toDateOnly` calendar day and adds `datePostedAt` / precision / basis
  behind that spec's own kill switch.
- **D-07 — Old behaviour stays reachable.** Each change has an env switch back
  (§7.1). The old browser User-Agent is not kept as a constant: a caller can
  still send any agent through `input.userAgent`.
- **D-08 — robots.txt.** `User-agent: *` allows `/` and disallows only
  `/management/` and `/admin/`; `/public-api/` is allowed. The response carries
  `Cache-Control: public,max-age=3600`, so scheduled crawls more often than
  hourly only re-read cached data.

## 11. References

- `packages/plugins/source-solidjobs/src/solidjobs.service.ts`
- `packages/plugins/source-solidjobs/src/solidjobs.filters.ts`
- `packages/plugins/source-solidjobs/src/solidjobs.constants.ts`
- `.specify/specs/718-source-solidjobs/spec.md`
- Live probe, 2026-09-24: 3 requests ≥ 2 s apart with the honest User-Agent
  (`robots.txt`; `it` `pageSize=3&pageIndex=1` → `totalCount 1707`, `totalPages 569`;
  `sales` `pageSize=3&pageIndex=0` → `totalCount 763`), ~9–10 s per request.
