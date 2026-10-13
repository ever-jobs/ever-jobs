# Spec: 5164 — Per-request search deadline (`?deadline_ms`) + deadline ceiling + single-source cache-write guard

| Field | Value |
| --- | --- |
| Spec ID | 5164 |
| Slug | search-deadline-override |
| Status | draft |
| Owner | agent |
| Created | 2026-09-28 |
| Related specs | 5026 (fanout-bounds), 5161 (raw-http-capture), 5082 (per-source diagnostics) |

## Problem

Spec 5026 bounds a fan-out's wall-clock at `search.deadlineMs` (default 120 s,
env `EVER_JOBS_SEARCH_DEADLINE_MS`). Two gaps:

1. **The deadline is deployment-global.** A single-source scrape that
   legitimately outlasts 120 s — e.g. a large board whose slow recovery pass
   pushes a scrape to ~150 s — is abandoned by `withDeadline` mid-flight and
   its whole result discarded. The only fix today is raising the env var for
   every request. The caller (who knows how patient it is) has no per-request
   way to declare a budget.
2. **Failed results are cached.** `jobs.controller.ts` writes `rawJobs` to the
   response cache unconditionally. A deadline-abandoned (or otherwise failed)
   single-source search caches `[]` for the full TTL — every identical call
   for the next hour returns the poisoned empty result instead of re-scraping.

## Proposal

- **`deadline_ms` query parameter** on `POST /api/jobs/search`. Optional; when
  absent the config deadline applies. A present value replaces
  `EVER_JOBS_SEARCH_DEADLINE_MS` for that request only; `0` means "no
  deadline" — the same semantics `0` has on the config side.
- **Server-side ceiling** `EVER_JOBS_SEARCH_DEADLINE_MAX_MS` (new env var).
  Unset = uncapped (single-tenant default, behaviour unchanged). When set, a
  request with `deadline_ms` of `0` or `> max` is rejected 400 naming the max;
  any other value is used as given. Reject, not clamp: a silent clamp fails
  subtly (the scrape is abandoned earlier than the caller expected and the
  partial result looks complete). `0` reads as "infinite deadline" and is
  therefore above any max — an operator who wants to forbid unbounded calls
  gets exactly that.
- **Single-source scope** — same gate as `include_raw` (Spec 5161): accepted
  only when the request resolves to exactly one source, otherwise 400. The
  gate bounds *width* — a multi-source call runs `concurrency` scrapes wide,
  so a caller-supplied deadline extension on a fan-out would hold ~64× more
  working memory for the extension window. The ceiling bounds duration; the
  gate bounds width. GraphQL stays config-only.
- **Cache-write guard** — keep normal cache semantics (no read-skip; a
  `deadline_ms` request may still be served from cache — the deadline changes
  how the search runs, not what it returns). Instead, stop poisoning the
  write: when the request resolved to exactly one source **and** that source's
  `per_source` reason is not `ok`/`empty`, skip `cacheService.set`. A failed,
  abandoned, blocked, or browser-less single-source result is never the thing
  to serve for an hour. `partial` also skips the write — partial data
  shouldn't sit in cache for the TTL either. The guard is intentionally
  single-source only: on multi-source searches at least one failure is normal
  (e.g. every browser plugin reports `browser_unavailable` on browser-less
  deployments), so a fan-out-wide rule would disable caching entirely.
- **Plumbing** — `deadline_ms` is passed as
  `searchJobsWithDiagnostics(input, { captureRaw, deadlineMs })`, never as a
  `ScraperInputDto` field. A DTO field would leak into `cacheParams` (two
  calls differing only in deadline would produce different cache entries) and
  into every plugin's input.
- **Validation** — missing = config default. Non-numeric or negative → 400.
  Parsed with a dedicated helper, not `parseNum`, which folds `0` into the
  default (`Number(v) || undefined`).
- **Observability** — the post-fan-out deadline warning gains
  `?deadline_ms` alongside `EVER_JOBS_SEARCH_DEADLINE_MS` so an operator
  reading logs sees the per-request knob.

## Contracts

| Setting | Where | Default | Meaning |
| --- | --- | --- | --- |
| `deadline_ms` | `POST /api/jobs/search` query param | absent = config | Per-request fan-out wall-clock budget, ms. `0` = no deadline. Single-source requests only. |
| `search.deadlineMaxMs` | `EVER_JOBS_SEARCH_DEADLINE_MAX_MS` | `0` = uncapped | Server-side ceiling for `deadline_ms`; request `0` or `> max` → 400. |

Behaviour matrix (`deadline_ms` value × ceiling):

| `deadline_ms` | max unset | max set |
| --- | --- | --- |
| absent | config default | config default |
| `0` | deadline disabled | **400** (infinite > max) |
| `n ≤ max` | `n` used | `n` used |
| `n > max` | `n` used | **400** naming max |
| negative / non-numeric | 400 | 400 |

## Non-goals

- No `ScraperInputDto` / `JobResponseDto` shape changes.
- No GraphQL surface (config-only there, matching `include_raw`).
- No per-source / per-plugin deadline — the param sets the fan-out budget,
  which for a single-source request is the scrape's budget.
- No clamping of out-of-range values — the API rejects honestly rather than
  silently rewriting caller intent.
- No abort/cancel propagation into running scrapers (the 5026 non-goal
  stands): an extended deadline merely allows a scrape to finish.

## Test plan

- `deadline_ms` absent → config default governs (no override passed).
- `deadline_ms=0` with max unset → deadline disabled for that call.
- `deadline_ms=0` with max set → 400.
- `deadline_ms` > max (max set) → 400 naming the max.
- `deadline_ms` valid → `searchJobsWithDiagnostics` receives it via options;
  a scrape that outlasts the config deadline but fits the override completes.
- Multi-source request carrying `deadline_ms` → 400 (selection of 2 or 0
  alike), same check as `include_raw`.
- Non-numeric / negative `deadline_ms` → 400.
- `deadline_ms` does not appear in `cacheParams`.
- A request with `deadline_ms` is still served from cache (no read-skip).
- Single-source search whose source ends with a failure reason
  (`timeout`, `fetch_error`, `blocked`, `partial`, …) → no cache write; a
  repeat call re-scrapes.
- Single-source `ok`/`empty` results are still cached as before.
- Multi-source search with a failing source → cache write still happens
  (guard is single-source only).
