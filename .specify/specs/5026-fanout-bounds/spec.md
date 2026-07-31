# Spec: 5026 — Bounded search fan-out (concurrency + deadline)

| Field | Value |
| --- | --- |
| Spec ID | 5026 |
| Slug | fanout-bounds |
| Status | implemented |
| Owner | agent |
| Created | 2026-07-30 |
| Last updated | 2026-07-30 |
| Related specs | 005, 721, 5024, 5025 |

## Problem

Third of three contributors to the production 4Gi OOMKill (Specs 5024 and 5025
cover the first two).

`JobsService.searchJobs` dispatched every selected source at once:

```ts
const results = await Promise.allSettled(
  selectedScrapers.map(async ({ site, scraper }) => { … }),
);
```

No concurrency limiter, no time budget. Two things make that severe here:

1. **The default selection is the entire catalogue.**
   `ScraperInputDto`'s constructor sets `this.siteType = Object.values(Site)`,
   and `main.ts` runs `ValidationPipe({ transform: true })`, which constructs
   the DTO — so `input.siteType` is never empty and `searchJobs` always takes
   the *explicit* branch. The ATS-exclusion fallback at `jobs.service.ts:73-77`
   is unreachable in practice. A default search therefore opens ~1 800
   concurrent HTTP conversations, holding every response body, parsed DOM and
   result array in memory simultaneously.
2. **Nothing bounds handler lifetime.** The Hust client aborts at 120 s and
   retries twice, but Node does not cancel a Nest handler on client
   disconnect, and no `requestTimeout` is configured. Abandoned handlers keep
   running — and keep holding their full object graph — for as long as the
   slowest source takes.

`AGENTS.md` §6 already mandates bounded concurrency ("`p-limit` /
`Promise.allSettled`"); the fan-out simply predates it. Note also that
`ScraperInputDto.maxConcurrentCompanies` exists but has zero consumers.

## Scope

- Replace the unbounded `Promise.allSettled(map(...))` with a shared-cursor
  worker pool of width `search.concurrency`.
- Add a wall-clock budget `search.deadlineMs` for the whole fan-out: once
  exceeded, no further sources are **started**; the remainder drain as skipped.
- Extract the per-source dispatch into `scrapeOne()` so the pool has a plain
  unit of work. Body unchanged.

## Non-goals

- **Narrowing the default `siteType`.** Deleting the constructor default would
  cut the fan-out from ~1 800 to the 11-site `defaults.siteNames` allowlist and
  is by far the largest single reduction available — but it changes what
  results callers get back, so it needs sign-off from the Hust side first.
  Recorded in `docs/questions.md`. This spec is the safety net, not the cure.
- Cancelling in-flight sources on client disconnect. The deadline bounds when
  new work *starts*; propagating an `AbortSignal` from `request.on('close')`
  into every scraper is a larger change across the plugin contract.
- `server.requestTimeout`. It governs how long the server waits to *receive* a
  request, not how long a handler may run, so it does not address this.

## Contracts

| Setting | Env | Default | Meaning |
| --- | --- | --- | --- |
| `search.concurrency` | `EVER_JOBS_SEARCH_CONCURRENCY` | 64 | Max sources dispatched simultaneously. Clamped to `[1, 512]`; non-finite / out-of-range falls back to the default. |
| `search.deadlineMs` | `EVER_JOBS_SEARCH_DEADLINE_MS` | 120 000 | Fan-out wall-clock budget. `0` or negative disables. |

Behaviour:

- Results are collected by input index, so ordering and the subsequent
  site/date sort are unchanged.
- A source that fails is recorded as `rejected` and does not stall the pool or
  affect its peers (unchanged semantics — `Promise.allSettled` before, per-item
  `try/catch` now).
- Sources skipped by the deadline increment
  `ever_jobs_scraper_requests_total{status="deadline_skipped"}` — a new, bounded
  label value alongside `success` / `error` / `circuit_open`.
- Whatever completed before the deadline is still returned. The deadline sheds
  work; it never fails the request.
- The deadline is enforced **twice**: before starting an item, and as a race
  against the in-flight `scrapeOne`. The pre-start check alone was insufficient
  — a source whose socket never settles would keep its worker pending, so
  `Promise.allSettled` never resolved and the handler was pinned forever, which
  is precisely the zombie-handler failure this spec exists to stop. The
  underlying promise cannot be cancelled (no `AbortSignal` in the plugin
  contract — task T11), so it runs on detached until its own HTTP timeout
  fires; what is guaranteed is that the *handler* returns and the response is
  sent.
- `search.concurrency` is **clamped**, not merely floored. `Math.max(1, x)`
  would accept `Infinity` or `1e9`, and since the pool spawns
  `min(concurrency, sources)` workers either value silently restores the
  unbounded fan-out. Out-of-range and non-finite values fall back to the
  default.

## Trade-off

For a genuinely catalogue-wide search, capping at 64 serialises the work into
~28 waves, so wall-clock rises. That is the intended exchange: peak memory
drops from O(sources) to O(concurrency). If the default `siteType` is narrowed
(see Non-goals), concurrency can drop to 16–32 with no latency cost.

## Test plan

`apps/api/src/jobs/__tests__/jobs.service.spec.ts`, with a scraper that records
simultaneous in-flight calls:

- 20 sources at concurrency 4 → observed peak ≤ 4, peak > 1 (really parallel),
  all 20 still run, all 20 results collected.
- Concurrency 1 → peak exactly 1.
- 12 sources, 30 ms each, concurrency 1, deadline 60 ms → some started, not all;
  the completed ones are still returned.
- `deadlineMs: 0` → every source runs.
- A failing source among peers → the other 5 still run and return.

This file's harness is repaired as part of the spec: it set a
`service.scraperMap` field the service stopped using when it migrated to
`PluginRegistry`, so all 9 routing/tagging cases had been failing on `develop`.
