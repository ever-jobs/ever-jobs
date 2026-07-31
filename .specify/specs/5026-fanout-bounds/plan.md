# Plan: 5026 — Bounded search fan-out

| Field | Value |
| --- | --- |
| Spec ID | 5026 |
| Status | implemented |
| Created | 2026-07-30 |

## Approach

### 1. Extract `scrapeOne()`

The per-source closure inside the old `map()` becomes a private method taking
`(site, scraper, input)`. Body is copied verbatim — retry-policy resolution,
the circuit-breaker wrap, the duration timer, the metric increments, the
site-tagging loop, the error branch. Keeping it byte-identical makes the diff
reviewable: everything else in this PR is scheduling.

### 2. Shared-cursor worker pool

Copied in shape from `LivenessHttpService.checkBatch`
(`packages/plugins/liveness-http/src/liveness-http.service.ts:62-94`), which is
the established in-repo pattern for bounded fan-out:

```
results = new Array(n); cursor = 0
worker() = loop { i = cursor++; if i >= n return; results[i] = await scrapeOne(i) }
await Promise.allSettled(min(concurrency, n) workers)
```

Writing by index preserves input order, so the downstream site/date sort is
untouched. Each worker catches its own error and stores a `rejected` result,
so one bad source cannot stall the pool — matching the previous
`Promise.allSettled` semantics.

### 3. Deadline

`deadlineAt = now + deadlineMs` computed once. Each worker checks it *before
starting* an item; past the deadline it marks the item skipped and `continue`s,
which drains the remaining queue quickly rather than dispatching it.

Deliberately does **not** interrupt in-flight scrapers: they carry their own
per-source timeouts and retry budgets, and aborting a socket mid-read gains
little while risking half-parsed state. The goal is bounding how long the
handler can *live*, not killing work already paid for.

## Why not `server.requestTimeout`

It caps how long the server waits to *receive* the complete request from the
client — it does not abort a long-running handler. Setting it would not stop a
20-minute fan-out. A fan-out-level deadline is the mechanism that actually
bounds handler lifetime without touching the plugin contract.

## Harness repair

`jobs.service.spec.ts`'s `createService` set `service.scraperMap`, a field the
service stopped reading when it moved to `PluginRegistry`. All 9 routing /
tagging / error-handling cases had been failing on `develop` as a result.
Replaced with a stub registry (plus `configService` and `metrics` stubs, which
the fan-out path now needs). `deadlineMs` defaults to `0` in the harness so
pre-existing cases are unaffected.

## Risks

| Risk | Mitigation |
| --- | --- |
| Wall-clock regression on wide searches | Documented trade-off; `EVER_JOBS_SEARCH_CONCURRENCY` is tunable and the default (64) is generous. |
| Deadline silently truncating results | Logged at `warn` with the skipped count, and counted under a distinct metric status. |
| Result ordering changes | Results written by input index; ordering asserted by the existing sort tests. |
| New metric label value | `deadline_skipped` — one additional bounded value on an already-bounded `status` label. |

## Rollback

Single commit. Reverting restores the unbounded `Promise.allSettled(map(...))`.
Setting `EVER_JOBS_SEARCH_CONCURRENCY` very high and `EVER_JOBS_SEARCH_DEADLINE_MS=0`
approximates the old behaviour without a deploy.
