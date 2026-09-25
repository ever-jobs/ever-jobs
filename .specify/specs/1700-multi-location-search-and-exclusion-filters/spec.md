# Spec: 1700 — Multi-location search and exclusion filters

| Field          | Value                                        |
| -------------- | -------------------------------------------- |
| Spec ID        | 1700                                         |
| Slug           | multi-location-search-and-exclusion-filters |
| Status         | done                                         |
| Owner          | agent                                        |
| Created        | 2026-09-25                                   |
| Last updated   | 2026-09-25                                   |
| Supersedes     | (none)                                       |
| Related specs  | 5026, 5082, 5095, 1680, 1689                 |

## 1. Problem Statement

Two things callers ask for cannot be expressed in one search today.

**Several places.** "Backend engineer in New York, Chicago and Austin" takes three requests. Each one
pays the whole fan-out, gets its own cache entry and its own dedup pass, and the caller merges the
results. Every plugin understands exactly one `input.location`; about 850 company/ATS plugins fetch
the whole board and filter by location substring locally, and cap at `resultsWanted` *inside* that
loop — so "call once without a location and post-filter" returns the wrong window.

**Things to leave out.** Nothing in the REST DTO, GraphQL input, CLI or MCP tool lets a caller say
"drop jobs that mention X". The naive version is wrong in predictable ways, measured over 2,365 real
titles on a large public ATS board:

| Term | Bare-substring hits | Whole-token hits | Dropped only by substring (all false positives) |
|---|---:|---:|---|
| `sci` | 19 | 0 | "Research Scientist", "Flight Sciences Engineer" |
| `poly` | 2 | 0 | "… (Polymeric Ablatives)" |
| `lead` | 130 | 123 | "Compliance Leader", "Senior Leadership Recruiter" |

Descriptions arrive as entity-escaped HTML, requirements are phrased in words ("Top Secret security
clearance with … Polygraph") rather than one acronym, and "No clearance required" must not count.

A live probe of a public job API with a server-side location filter showed that the location is a
real filter (New York 13,864 vs Chicago 9,650 results) and that 6 of 20 page-0 ids came back for
both cities — so a per-location fan-out yields distinct jobs *and* needs same-source duplicate
removal.

## 2. Goals

- `locations: string[]` on every search surface; the query runs once per location for every
  selected source, each call with the caller's own `offset` and `resultsWanted`.
- One failing location never discards another location's jobs; a source that refuses us (429,
  block, open breaker) is not asked for its remaining locations.
- Same posting, same source, two locations → one row, whether or not `?dedup=false`.
- `excludeTitleTerms`, `excludeKeywords`, `excludePresets` (first preset: `security_clearance`) as a
  per-request view filter after dedup.
- Callers that send none of the new fields see byte-identical behaviour, plugin inputs, cache keys
  and responses.

## 3. Non-Goals

- Per-location `country`/`distance`, tagging a job with the location that produced it, and
  one-upstream-request-for-all-locations per plugin (follow-ups).
- Pushing negative terms down into sources; back-filling to `resultsWanted` after exclusion;
  `excludeCompanies`.
- Changing any plugin. Plugins still see a single `input.location` and never see `locations`.
- A shared GET response memo for repeated identical board fetches (see D-03; follow-up).

## 4. User / Caller Stories

> As an **API caller**, I want **one request for several cities**, so that **I pay one fan-out and
> get one merged, de-duplicated result**.

> As a **job seeker without a clearance**, I want **to drop clearance-required roles without
> maintaining a word list**, so that **the list only shows jobs I can take**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `ScraperInputDto.locations?: string[]` (≤ 25 entries, ≤ 200 chars each, validated). No constructor default. | must |
| FR-2  | Resolution: `location` first, then `locations`; NFC + trim + whitespace collapse; case-insensitive de-dup keeping the first spelling; diacritics kept distinct; blanks/non-strings dropped. | must |
| FR-3  | Cap: `EVER_JOBS_SEARCH_MAX_LOCATIONS` (default 10, clamped to [1, 25]); entries over the cap become `location:<text>` `bad_input` diagnostic rows. | must |
| FR-4  | 0 or 1 resolved location → the legacy single-location path; `locations` absent → the input object is untouched. | must |
| FR-5  | ≥ 2 locations → per site, locations run sequentially (sites stay parallel under the existing pool), each call a fresh clone with `location` set and `locations` removed. | must |
| FR-6  | Polite stop: a 429 (thrown or in a swallowed `fetch_error` diagnostic), a `blocked` outcome or an open breaker ends that site's loop; the rest are reported as not attempted and counted as `location_skipped`. | must |
| FR-7  | Deadline checked before and raced during every location call; skipped locations report `timeout`. | must |
| FR-8  | Same-source identity de-dup across locations (site + id + jobUrl; either alone when the other is missing; neither → keep). | must |
| FR-9  | One diagnostic row per (site, location) carrying `location`; `site` stays the bare key. | must |
| FR-10 | Pause of `EVER_JOBS_SEARCH_LOCATION_INTERVAL_MS` (default 500, `0` disables) between consecutive attempted location calls to one source. | should |
| FR-11 | Cache key: exclusion fields never keyed; `locations` keyed order- and case-insensitively on the searched set; a one-entry list keys like `location`. | must |
| FR-12 | Exclusion matcher: whole tokens, phrases, trailing-`*` prefix (≥ 3 chars), aliases (`sr`/`snr`↔`senior`, `jr`↔`junior`), negation-aware in the same clause, HTML-safe, linear, never a regex over caller input; separator-less scripts use a literal substring. | must |
| FR-13 | Exclusions run in the aggregator after dedup; a cluster is dropped when any member matches; persistence still receives every canonical record. | must |
| FR-14 | REST `exclusion_metrics` (`samples` only with `?diagnostics`), GraphQL `exclusionMetrics`, CLI stderr summary, MCP `excluded` — each present only when an exclusion field was supplied. `/analyze` analyses the filtered set. | must |
| FR-15 | CLI `--locations`, `--exclude-title`, `--exclude-keyword`, `--exclude-preset` on `search` and `compare`; MCP `locations`, `exclude_title_terms`, `exclude_keywords`, `exclude_presets`. | must |

## 6. Non-Functional Requirements

| ID    | Requirement | Target |
| ----- | ----------- | ------ |
| NFR-1 | Never more than one in-flight call per (search, source) from the location fan-out | 1 |
| NFR-2 | Exclusion matching worst case (50 terms × 8 tokens × 100 KB description) | < 200 ms per job |
| NFR-3 | Exclusion failure never fails a search | unfiltered list + `exclusion_error` |
| NFR-4 | Metrics cardinality | no `location` label; one new bounded status value |

## 7. Contracts

### 7.1 API / Interface

```ts
// packages/models
export const HARD_MAX_SEARCH_LOCATIONS = 25;
export const DEFAULT_MAX_SEARCH_LOCATIONS = 10;
export enum ExclusionPreset { SECURITY_CLEARANCE = 'security_clearance' }
class ScraperInputDto {
  locations?: string[];
  excludeTitleTerms?: string[];   // ≤ 50, ≤ 100 chars
  excludeKeywords?: string[];     // ≤ 50, ≤ 100 chars
  excludePresets?: ExclusionPreset[];
}

// packages/common
resolveSearchLocations(input, max?): { locations: string[]; overCap: string[] };
searchLocationsCacheKey(locations): string[];
clampMaxLocations(raw): number;
compileJobExclusions(spec): CompiledJobExclusions;
matchJobExclusion(job, compiled): ExclusionMatch | null;
applyJobExclusions(jobs, specOrCompiled): { kept; excluded; metrics };

// apps/api
class LocatedSourceDiagnosticDto extends SourceDiagnosticDto { location: string }
interface AggregateOptions { exclusions?: JobExclusionSpec | CompiledJobExclusions }
interface AggregateResult { exclusionMetrics?; excludedSamples?; exclusionError? }
```

REST response (additive, only when an exclusion field was supplied):

```jsonc
"exclusion_metrics": {
  "excluded_count": 12, "excluded_raw_count": 15,
  "by_term": [{ "term": "security clearance", "source": "preset:security_clearance", "count": 9 }],
  "ignored_terms": [{ "term": "a*", "reason": "prefix_too_short" }],
  "samples": [{ "id": "…", "site": "…", "title": "…", "term": "ts sci", "source": "…", "field": "description" }]
}
```

### 7.2 Errors

| Code | Meaning |
| ---- | ------- |
| 400 (validation) | `locations` > 25 / entry > 200 chars / non-string; exclusion list > 50 / term > 100 chars / non-string; unknown preset |
| `ERR_EXCLUSION_FAILED` | The exclusion filter threw; the unfiltered list is returned with `exclusion_error` |

Ignored-term reasons (reported, never thrown): `empty`, `too_long`, `too_many_tokens`,
`prefix_too_short`, `over_limit`, `unknown_preset`.

## 8. Test Plan

- Unit: `search-locations.spec.ts`, `job-exclusion.spec.ts` (P1–P8 pitfalls, 40-title preset
  fixture, timing guards), `scraper-input-search-filters.spec.ts`.
- Service: `jobs.service.multi-location.spec.ts` — legacy path untouched, collapse, per-location
  clones, no shared cursor/budget, sequential-per-site/parallel-across-sites, isolation, polite stop
  (thrown 429/403, swallowed block/rate limit), no stop on 404/5xx, breaker, identity de-dup,
  deadline, cap, env fallback, routing, pause.
- Aggregator / API: `jobs.aggregator.exclusions.spec.ts`, `search-filters.api.spec.ts` (cache keys,
  response keys, pagination after exclusion, liveness only on kept jobs, `/analyze`, ValidationPipe
  400s, resolver, GraphQL schema).
- CLI / MCP: `search-filters.command.spec.ts`, `tools-search-filters.spec.ts`.
- Live: `apps/api/__tests__/search-multi-location.e2e-spec.ts` — two upstream GETs, one per location; exclusion invariants on
  the same live result.

## 9. Open Questions

Recorded for `docs/questions.md` (integrator), each with the default this change ships:

- Q-A Default location cap — **10** (hard 25), operator-tunable.
- Q-B Stop a source's remaining locations after a refusal — **yes**.
- Q-C Tag jobs with the search location(s) that produced them — **no** (adds a field to REST,
  GraphQL and CSV).
- Q-D Allow `locations` with the catalogue-wide default site selection — **allowed**; the deadline
  bounds it and skips appear in diagnostics.
- Q-E Default pause between one source's location calls — **500 ms**, until the crawl-policy host
  limiter and a shared GET memo land.

## 10. Decisions

- **D-01 — The fan-out lives in `JobsService.searchJobsWithDiagnostics`, not the aggregator.** The
  controller calls the service directly; one change there covers REST, GraphQL, CLI, `/analyze` and
  `JobsAggregator.aggregate`.
- **D-02 — Identity key is site + id + jobUrl.** An id-only key would collapse different postings
  from plugins that derive `id` from the row index; requiring both keeps them apart while the same
  posting under two locations still collapses.
- **D-03 — No shared GET memo in this change** (superseded by the review fixup, T13). Collapsing
  identical board fetches needs a hook in the shared HTTP client, which this change did not own.
  Instead calls are sequential per source with a configurable pause (FR-10), bounded by the cap and
  the deadline. The review fixup added the scoped memo (`runWithHttpMemo`, GET and POST, one scope
  per source location loop, `EVER_JOBS_SEARCH_LOCATION_MEMO`) and plugin-declared request gaps (T14).
- **D-04 — Located rows are a subclass in `apps/api`.** `LocatedSourceDiagnosticDto` adds
  `location` without touching the shared DTO; rows serialise with the extra field and consumers that
  group by `site` are unaffected.
- **D-05 — Exclusion is a view.** The cache stores the raw fan-out and persistence receives every
  canonical record; `per_source` keeps reporting fan-out counts (pre-dedup, pre-exclusion).
- **D-06 — Presets have no bare `sci`/`poly`/`secret`,** and "enhanced reliability" is not a
  preset term (it reads as an SRE phrase); "reliability status" covers the vetting level.
- **D-07 — Unknown presets are dropped, not failed, outside the validated REST path** (CLI, MCP,
  direct helper use) and reported as `unknown_preset`.
- **D-08 — Exclusion keys only when supplied.** An empty list is still "supplied": the metrics key
  appears (zeroed) and nothing is removed.

## 11. References

- `apps/api/src/jobs/jobs.service.ts` — `planLocations`, `scrapeSiteAcrossLocations`,
  `mergeLocationOutcomes`.
- `apps/api/src/jobs/jobs.aggregator.ts`, `jobs.controller.ts`, `jobs.resolver.ts`,
  `gql-types.ts`, `search-cache-params.ts`.
- `packages/common/src/utils/search-locations.ts`, `packages/common/src/utils/job-exclusion.ts`.
- Spec 5026 (bounded fan-out), 5082 / 1680 (diagnostics), 5095 (`companyDomain:` rows), 1689
  (GraphQL validators).
