# Plan 5164

| Spec | 5164 — search-deadline-override |
| --- | --- |
| Package | apps/api (`jobs.controller.ts`, `jobs.service.ts`, `config/configuration.ts`) |
| Effort | small — ~60 LoC + tests |

## Approach

- `configuration.ts`: add `search.deadlineMaxMs` via the existing local
  `parseInt(env, fallback)` helper — `EVER_JOBS_SEARCH_DEADLINE_MAX_MS`,
  default `0` (uncapped).
- `jobs.controller.ts`:
  - `@ApiQuery` entry for `deadline_ms` (after `include_raw`).
  - `@Query('deadline_ms') deadlineMsRaw?: string` appended after
    `includeRawRaw` (positional-args comment preserved).
  - `parseDeadlineMs` helper — deliberately not `parseNum` (which folds `0`
    into the default): absent → `undefined`; `Number(v)` non-finite or `< 0` →
    `BadRequestException`; else the number.
  - Ceiling check where the param is parsed: `deadlineMax > 0 &&
    (deadlineMs === 0 || deadlineMs > deadlineMax)` →
    `BadRequestException` naming the max.
  - Pass `deadlineMs` through the existing options object on the
    `searchJobsWithDiagnostics` call.
  - Cache-write guard: skip `cacheService.set(cacheParams, rawJobs)` when
    `perSource.length === 1` and the row's `reason` is not `ok`/`empty`.
- `jobs.service.ts`:
  - `options` gains `deadlineMs?: number`.
  - Single-source gate beside the `captureRaw` check (before the zero-source
    early return): `deadline_ms requires exactly one source; got N` → 400.
  - `deadlineMs` for `deadlineAt` = `options?.deadlineMs ?? config value`.
  - Deadline-exceeded warning mentions `?deadline_ms`.

## Risks

- None structural — the deadline mechanism (`deadlineAt`, `withDeadline`,
  drain semantics) is unchanged; only the value source becomes per-request.
- Cache guard is behaviour-visible only on failed single-source searches
  (previously cached `[]`; now re-scraped) — the intended fix.
