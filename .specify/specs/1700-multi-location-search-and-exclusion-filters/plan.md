# Plan: 1700 — Multi-location search and exclusion filters

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1700       |
| Status       | done       |
| Last updated | 2026-09-25 |

## Approach

Two independent features that share one input DTO and one set of surfaces.

**Multi-location** is a scheduling change inside the existing Spec 5026 worker pool. The unit of
work stays "one site"; in multi mode that unit runs its locations one after another, so the pool's
concurrency and deadline semantics carry over unchanged and one search never opens concurrent
conversations with one source.

1. `resolveSearchLocations` / `clampMaxLocations` / `searchLocationsCacheKey` in
   `@ever-jobs/common` — pure input resolution.
2. `JobsService.planLocations` — absent `locations` returns the same input object; 0/1 resolved
   location collapses to the legacy path; ≥ 2 selects multi mode.
3. `JobsService.scrapeSiteAcrossLocations` — per-location clone, deadline check + race, polite stop
   on refusal, politeness pause between attempted calls. Never throws.
4. `JobsService.mergeLocationOutcomes` — same-source identity de-dup and one
   `LocatedSourceDiagnosticDto` per (site, location). Over-cap entries become `location:` rows.
5. `searchCacheParams` — one cache-key builder for REST and GraphQL.

**Exclusions** is a pure matcher plus one insertion point.

1. `job-exclusion.ts` in `@ever-jobs/common` — one fixed tokenizer for text and terms (linear
   entity decode + tag strip, NFKD fold, clause ids, aliases), term compilation into a title scope
   and a description scope, token-by-token matching with same-clause negation windows.
2. `JobsAggregator.aggregateRaw` — match every raw row once; pass-through paths filter rows, the
   dedup path drops whole clusters; persistence untouched; failures degrade to the unfiltered list.
3. Controller / resolver pass `exclusions` only when supplied and render metrics; `/analyze`
   filters with the same helper. CLI and MCP map their flags/arguments.

## Files

| File | Change |
| ---- | ------ |
| `packages/models/src/dtos/scraper-input.dto.ts` | `locations`, exclusion fields, limit constants, per-location wording on `resultsWanted`/`offset` |
| `packages/models/src/enums/exclusion-preset.enum.ts` (new) + `enums/index.ts` | `ExclusionPreset` |
| `packages/common/src/utils/search-locations.ts` (new) | resolution, cap, cache key |
| `packages/common/src/utils/job-exclusion.ts` (new) | matcher, presets, metrics |
| `packages/common/src/index.ts` | exports the two helpers |
| `apps/api/src/jobs/jobs.service.ts` | multi-location scheduling, polite stop, identity de-dup, located rows, config readers |
| `apps/api/src/jobs/jobs.aggregator.ts` | exclusions, metrics, samples, `ERR_EXCLUSION_FAILED` |
| `apps/api/src/jobs/search-cache-params.ts` (new) | shared cache-key builder |
| `apps/api/src/jobs/jobs.controller.ts` | cache key, exclusions wiring, `exclusion_metrics`, `/analyze` |
| `apps/api/src/jobs/jobs.resolver.ts`, `gql-types.ts` | GraphQL fields (validated), `ExclusionPreset` enum, `exclusionMetrics` |
| `apps/cli/src/commands/search.command.ts`, `compare.command.ts` | `--locations`, `--exclude-*` |
| `apps/mcp/src/index.ts`, `apps/mcp/src/tools.ts` | tool schema, request body, `excluded` |
| `tool_manifest.json` | input properties, features, examples |

## Configuration

| Setting | Env var | Default | Notes |
| ------- | ------- | ------- | ----- |
| `search.maxLocations` | `EVER_JOBS_SEARCH_MAX_LOCATIONS` | 10 | clamped to [1, 25]; bad values → default |
| `search.locationIntervalMs` | `EVER_JOBS_SEARCH_LOCATION_INTERVAL_MS` | 500 | clamped to [0, 10000]; `0` disables |

Both are read through the config key first and the env var second, so a `configuration.ts` entry
can be added later without a code change here.

## Verification

Jest suites listed in the spec's test plan; `tsc --project tsconfig.typecheck.json --noEmit`; one
live run of `search-multi-location.e2e-spec.ts` (two upstream GETs).
