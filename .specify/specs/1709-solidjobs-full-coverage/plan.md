# Plan: 1709 — Solid.Jobs full coverage: every division, paging, client-side filters, full mapping

| Field        | Value      |
| ------------ | ---------- |
| Spec         | spec.md    |
| Spec ID      | 1709       |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

The change stays inside `packages/plugins/source-solidjobs`. Registration is
untouched (Spec 718 already wired all four registration files).

1. **Constants.** The eight divisions in default order, the page-size and
   page-count caps, the concurrency ceiling, the time budget, the board
   country, the search-hint stems, the contract-form glossary, the honest
   User-Agent, and one env-var name per switch.
2. **Types.** The paging envelope (optional, so a page without it still
   parses), `secondarySalary`, and optional fields that can be absent.
3. **Filters (`solidjobs.filters.ts`, new).** Pure helpers: `foldText`,
   token search, the Spec 718 phrase matcher, the location needle, job-type
   rules, the `hoursOld` window, the filter builder, hint ordering and the
   CamelCase humaniser.
4. **Service.** A scheduler over divisions (≤ 2 in flight; unfiltered waits
   for `totalCount` before starting another), a sequential per-division page
   loop with every stop condition, a deterministic merge, per-offer mapping
   with full field coverage, and a diagnostics step.
5. **Tests.** The Spec 718 suite updated; two new suites (service coverage,
   pure helpers); synthetic fixtures modelled on the live wire shapes; the live
   e2e refreshed and kept small.

## 2. Phases

### Phase 1 — Fetch

- Goal: every division, paged, bounded, with honest failures.
- Exit criteria: default fan-out = 1 request; full scan paged; failures surface.

### Phase 2 — Filter and map

- Goal: client-side filters and every payload field mapped.
- Exit criteria: filter and mapping tests green; mutation controls red.

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/plugins/source-solidjobs` | constants, types, new `solidjobs.filters.ts`, service rewrite of fetch/filter/map, 3 fixtures, 2 new suites, updated unit + e2e suites |
| `packages/common`, `packages/models` | (no change — uses `postedFromTimestamp`, `postedTimeFields`, `parseLocationList`, `classifyScrapeError`, `ScrapeDiagnostics`) |

## 4. Dependencies

None added.

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Newest-first ordering is not guaranteed (seen on 6 offers) | M | L | The `hoursOld` stop needs a whole page outside the window, so at worst one page is wasted; no in-window offer on a fetched page is lost. |
| Page drift while paging | M | L | Per-division key set skips repeats; a removal can skip one offer at a page boundary, as on any paged board. |
| ~9–10 s per request | H | M | 90 s budget with a `partial` diagnostic; default fan-out is one small request. |
| Server starts rejecting paging parameters | L | H | `SOLIDJOBS_PAGINATE=false` restores the un-paged request. |
| A new division appears | L | L | `SOLIDJOBS_DIVISIONS` covers it until the constant is updated. |

## 6. Rollback Plan

Revert the commit (it touches only this plugin and its spec folder), or use
the env switches: `SOLIDJOBS_DIVISIONS=it`, `SOLIDJOBS_PAGINATE=false`,
`SOLIDJOBS_SEARCH_MODE=phrase`, `SOLIDJOBS_INPUT_FILTERS=false` together give
the Spec 718 request and matching. No data is stored.

## 7. Migration Plan

None. Output only gains fields; `location.country` changes from `null` to
`Country.POLAND`.

## 8. Open Questions for Plan

- Declare `crawl: { maxConcurrentPerHost: 2, minIntervalMs: 1000 }` once
  `IPluginMetadata` gains a `crawl` field.
