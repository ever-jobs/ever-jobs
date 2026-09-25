# Spec: 1721 — NDJSON search stream, configurable fan-out deadline, per-job dedup key

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1721                                     |
| Slug           | ndjson-search-stream                     |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-24                               |
| Last updated   | 2026-09-25                               |
| Supersedes     | (none)                                   |
| Related specs  | 003, 5025, 5026, 1720, 1723              |

## 1. Problem Statement

A catalogue-wide search takes ~2.5 minutes and returns 20–30 k jobs. Today a caller has two
bad options:

- **JSON, unpaginated** — one response body built by `JSON.stringify` over the whole array,
  held in memory twice (objects + string) and delivered only at the very end. Any proxy with a
  60 s idle timeout kills it, and the client sees nothing until everything is done.
- **JSON, paginated** — `?paginate=true&page_size≤100`, where each page re-runs (or re-reads
  from cache) the whole fan-out. The main consumer stores only page 1, and because results are
  sorted by site name, page 1 is always sources beginning with "a".

In addition:

- the fan-out deadline is configurable only through `EVER_JOBS_SEARCH_DEADLINE_MS`, a name the
  consumer contract (v1) calls `EVER_JOBS_FANOUT_DEADLINE_MS`;
- consumers that must deduplicate across runs and across keyword/list calls have no stable key
  per job; the dedup engine computes one (`canonicalJobId`) but never returns it.

## 2. Goals

- `?format=ndjson`: headers immediately, heartbeat/progress while scraping, one line per job,
  a terminal `end` line — or an `error` line and no `end` on failure.
- `EVER_JOBS_FANOUT_DEADLINE_MS` (alias, takes precedence) with the default unchanged.
- `dedupKey` on every job in every output (JSON, CSV, NDJSON, GraphQL).
- (FR-15, 2026-09-25) The `end` line says whether the crawl was complete — whether the fan-out
  deadline or the job ceiling left selected sources unscraped — so a consumer never mistakes a
  truncated crawl for the whole catalogue.

## 3. Non-Goals

- Streaming *while* scraping (emitting jobs before the fan-out ends). Dedup, liveness and
  legitimacy need the whole set, and the contract requires the JSON order.
- Cancelling in-flight scrapers on client disconnect (no `AbortSignal` in the plugin contract).
  FR-14 only stops *starting* new ones, exactly like the deadline.
- Changing the JSON response shape (only the additive `dedupKey` per job). FR-15's completeness
  record is reported on the NDJSON `end` line only; JSON callers keep `per_source_summary` (which
  counts the skipped rows but does not name the bound that stopped the fan-out).
- Cancelling or resuming a truncated crawl. FR-15 only reports it.

## 4. Caller Stories

> As a **corpus builder**, I want every job of a 25 k-job search as a stream, so that I never
> have to paginate and never lose the connection to an idle-timeout.

> As a **corpus builder**, I want a stable `dedupKey` per posting, so that I can upsert the same
> posting seen from a job board today and from the company's ATS tomorrow into one row.

> As a **corpus builder** that closes postings which a crawl no longer returns, I want the `end`
> line to tell me when the crawl was cut short, so that a deadline or job-ceiling stop never makes
> me close hundreds of postings whose source was simply never scraped.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `POST /api/jobs/search?format=ndjson` answers `200` with `Content-Type: application/x-ndjson; charset=utf-8`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`. The first line is written as soon as the fan-out starts (on a cache hit, the first job line), so headers reach the client immediately. | must |
| FR-2  | While scraping (and while dedup/liveness run), a `{"type":"progress","sourcesDone":n,"sourcesTotal":m,"jobs":k}` line is written at fan-out start and then at most every ~10 s (`NDJSON_HEARTBEAT_MS = 10 000`). `jobs` counts raw jobs collected so far. | must |
| FR-3  | Then exactly one `{"type":"job","data":{…}}` line per job, in the same order and with the same per-job JSON as the unpaginated JSON response (`JSON.stringify(job)`; any extra field another feature adds passes through untouched). | must |
| FR-4  | Then exactly one `{"type":"end","total":N,"deduped":bool,"durationMs":ms}` (plus FR-15's completeness fields); `total` equals the number of job lines. | must |
| FR-5  | Any failure after headers were sent writes `{"type":"error","message":"…"}` and closes the stream with **no** `end` line. Consumers must treat a missing `end` as truncated. | must |
| FR-6  | `paginate`, `page`, `page_size` are ignored in NDJSON mode. `dedup`, `liveness`, `legitimacy` apply exactly as for JSON (liveness still subject to Spec 1723's gate and cap). Cache read/write is identical to JSON. | must |
| FR-7  | Lines are written one at a time with back-pressure (`write()` → `drain`); the full payload is never materialised as one string. On client disconnect the writer stops writing (the scrape itself cannot be cancelled). | must |
| FR-8  | Unknown `type` values are reserved for future use; consumers must ignore them. | must |
| FR-9  | `search.deadlineMs` resolves `EVER_JOBS_FANOUT_DEADLINE_MS`, then `EVER_JOBS_SEARCH_DEADLINE_MS`, then `120000`. Blank / non-numeric values fall through to the next source; `0` or negative disables the deadline (existing semantics). | must |
| FR-10 | Every returned job carries `dedupKey`: `canonicalJobId(canonicalKeyInputForJob(job))` — `sha256(normalizeCompany(company) + "|" + normalizeTitle(title) + "|" + <location component>)`, where the location component is built from the flat `location`, the per-site `locations[]` (Spec 5123) and `isRemote` (Spec 1689 remote bucket) exactly as the dedup engine builds `canonicalJobId`. The engine and `dedupKeyForJob` both take their key input from the one shared helper `canonicalKeyInputForJob` (`@ever-jobs/common`), so they cannot read different fields. Computed on the output set for `dedup=true` and `dedup=false`, from cache or fresh. Absent only when a job has neither title nor company. **Keys change once (2026-09-25 review fix):** before the shared helper, `dedupKeyForJob` passed only title/company/flat location, so for a posting with `locations[]` whose site set differs from its flat label (every multi-location posting) or a remote posting with no concrete site (`isRemote` + country-only or no location, e.g. a parsed `Remote - US`) the returned key differed from the engine's cluster id. Those postings get a new `dedupKey` once — now equal to the cluster id; every other posting keeps its key. | must |
| FR-11 | CSV gains a `dedupKey` column automatically; nested arrays inside object fields are joined with `; ` (same as top-level arrays) so extra structured fields remain readable. GraphQL `JobPostGql` gains `dedupKey`. | must |
| FR-12 | (review fix, 2026-09-25 — tightens FR-1) The very first line, `{"type":"progress","sourcesDone":0,"sourcesTotal":0,"jobs":0}`, is written synchronously when the stream is created — before the cache lookup — so headers flush immediately on a cache hit too (where dedup and persistence of a large set can take seconds before the first job line) and heartbeats cover that phase. The fan-out-start line with the real `sourcesTotal` follows as before. | must |
| FR-13 | (review fix) Input the service would reject before any scraping — a `companyDomain` that resolves to no plugin while nothing else is selected, an unknown `siteCategories` value from a caller that bypassed validation — is checked before the stream is created and answered with **400**, not with `201` + an `error` line. | must |
| FR-14 | (review fix) When the NDJSON client disconnects, the fan-out stops **starting** sources (checked next to the deadline; in-flight sources finish), skipped sources count as `cancelled_skipped` in `scraper_requests_total`, and the partial result is **not** cached, deduped or persisted — a retry must never be served a truncated set from the cache. | must |
| FR-15 | (integration fix, 2026-09-25) The `end` line carries four additive fields: `complete` (boolean), `stopReason` (`"deadline"` \| `"job_ceiling"` \| `null`), `sourcesSkipped` (integer ≥ 0) and `sourcesFailed` (integer ≥ 0). `complete` is `false` exactly when `stopReason` is set: the fan-out deadline (`EVER_JOBS_FANOUT_DEADLINE_MS`) or the raw-job ceiling (`EVER_JOBS_MAX_JOBS_PER_SEARCH`) left at least one selected source unscraped. `stopReason` names the bound that tripped **first** when both did. | must |
| FR-16 | Counting. `sourcesSkipped` = selected sources that contributed nothing because the fan-out stopped: not started at the deadline, not started at the job ceiling, or abandoned mid-flight at the deadline (`FanoutDeadlineError`). `sourcesFailed` = sources that **ran** and ended with a failure reason (`blocked`, `browser_unavailable`, `fetch_error`, `timeout`, `bad_input`, `circuit_open`, `not_registered`, `unknown`); `ok`, `empty` and `partial` (jobs AND an error) are not failures, and a skipped source is never also counted as failed. Failures never make a crawl incomplete. Keyword-only sources that list mode does not dispatch (Spec 1720) are neither skipped nor failed. The per-source rows keep their existing reasons (an abandoned source is still `timeout`). Once the deadline has abandoned a source, no further source starts: the deadline timer is scheduled against libuv's cached loop time and can fire a few ms before `Date.now()` reaches the deadline, which used to let the worker start one more source after the deadline had already cut one short. | must |
| FR-17 | Cache. A fresh fan-out writes the completeness record next to the raw set, under the same cache parameters with `endpoint: "search-completeness"`, so every change to the search cache key moves both. A cache hit reports the record of the crawl that produced it. On the NDJSON path a hit whose record is missing or malformed (written before FR-15, or evicted on its own) is treated as a **miss** — the fan-out runs and both entries are rewritten — so the `end` line never guesses. The JSON path serves such a hit as before and never reads the record (it does not report completeness). | must |
| FR-18 | A `JobsService` that reports no completeness (not the shipped one) gets the four fields **omitted** from the `end` line and a warning logged — never a guessed value. Consumers must therefore treat a missing `complete` (also what servers older than FR-15 send) as "not known to be complete". | must |

## 6. Non-Functional Requirements

| ID    | Requirement | Target |
| ----- | ----------- | ------ |
| NFR-1 | Peak extra memory of NDJSON vs JSON | one line buffer (≤ one job) + the stream high-water mark |
| NFR-2 | Time to first byte | immediate — the first line exists before the cache lookup (FR-12) |
| NFR-3 | `dedupKey` cost | one sha-256 per returned job (~25 µs) |

## 7. Contracts

### 7.1 Wire format

```text
{"type":"progress","sourcesDone":0,"sourcesTotal":0,"jobs":0}
{"type":"progress","sourcesDone":0,"sourcesTotal":1669,"jobs":0}
{"type":"progress","sourcesDone":412,"sourcesTotal":1669,"jobs":6120}
{"type":"job","data":{"id":"…","title":"…","dedupKey":"4f1c…",…}}
…
{"type":"end","total":21873,"deduped":true,"durationMs":151234,"complete":true,"stopReason":null,"sourcesSkipped":0,"sourcesFailed":38}
```

A crawl the deadline cut short (FR-15) — every job it did collect is still streamed:

```text
{"type":"end","total":14022,"deduped":true,"durationMs":120412,"complete":false,"stopReason":"deadline","sourcesSkipped":611,"sourcesFailed":35}
```

Failure: `…{"type":"error","message":"<reason>"}` then EOF, no `end`.

### 7.2 Interface

```ts
export interface SearchProgress { sourcesDone: number; sourcesTotal: number; jobs: number }
export interface SearchRunOptions {
  onProgress?: (progress: SearchProgress) => void;
  isCancelled?: () => boolean;            // FR-14 — checked before each source starts
}
// JobsService.searchJobsWithDiagnostics(...) → { jobs, perSource, completeness, cancelled?: true }
// FR-15 — apps/api/src/jobs/search-completeness.ts
export type SearchStopReason = 'deadline' | 'job_ceiling';
export interface SearchCompleteness {
  complete: boolean;                  // false ⇔ stopReason !== null
  stopReason: SearchStopReason | null; // the first bound that tripped
  sourcesSkipped: number;             // not started, or abandoned mid-flight, because of a bound
  sourcesFailed: number;              // ran and ended with a failure reason (not ok/empty/partial)
}
export const SEARCH_COMPLETENESS_CACHE_ENDPOINT = 'search-completeness';
export function isSearchCompleteness(value: unknown): value is SearchCompleteness; // cache read-back guard
export class FanoutDeadlineError extends Error {} // jobs.service.ts — the mid-flight abandonment (message unchanged)
// JobsService.assertSearchable(input): void — FR-13, throws the service's own BadRequestException
export function canonicalKeyInputForJob(job: Pick<JobPostDto,'title'|'companyName'|'location'|'locations'|'isRemote'>): CanonicalKeyInput; // @ever-jobs/common — the ONE key input
export function dedupKeyForJob(job: Pick<JobPostDto,'title'|'companyName'|'location'|'locations'|'isRemote'>): string | undefined; // = canonicalJobId(canonicalKeyInputForJob(job))
class JobPostDto { dedupKey?: string | null }
```

## 8. Test Plan

- Controller (`jobs.controller.ndjson.spec.ts`): header set; first line is progress; order
  progress → job… → end; each `data` deep-equals the corresponding job of the JSON path
  (`JSON.parse(JSON.stringify(job))`); `total` equals job-line count; pagination params
  ignored; error after start → `error` line and no `end`; cache hit streams jobs; heartbeat
  timer emits progress with fake timers; extra fields pass through untouched.
- Config (`search-config.spec.ts`): deadline env precedence and parsing.
- `dedupKeyForJob` (common): same posting from two sources (different `site`, `id`, URL, case,
  punctuation, `Inc.` suffix) → same key; different title → different key; matches
  `canonicalJobId`; class vs plain `LocationDto` → same key. Review fix: `canonicalKeyInputForJob`
  passes `locations[]` and `isRemote`; `dedupKeyForJob` equals the `DedupHybridService` cluster id
  for a remote country-only posting (parsed `Remote - US`), a multi-location posting and every
  input of a mixed batch (`dedup-hybrid.service.spec.ts`), and the aggregator's returned key equals
  the engine assignment for both (`jobs.aggregator.dedup-key.spec.ts`).
- Aggregator: `dedupKey` present on `dedup=true`, `dedup=false`, no-engine paths.
- Review fixes: a cache hit streams `progress` → `job` → `end`, and the first line is readable
  while dedup/persistence of the cached set is still running (FR-12); an unresolvable
  `companyDomain` makes the handler throw `BadRequestException` before any stream exists and
  the fan-out never runs (FR-13); after `res` emits `close`, no further source is started,
  `cacheService.set` and `aggregateRaw` are not called (FR-14); service-level test that
  `isCancelled` stops the worker pool and reports `cancelled: true`.
- FR-15..FR-18 — service (`jobs.service.list-mode.spec.ts`, "crawl completeness"): every source
  ran with fetch_error/blocked/partial/empty/circuit_open outcomes → complete, 3 failed; the job
  ceiling → `job_ceiling`, unstarted sources skipped and not failed; the deadline → `deadline`,
  the abandoned source and the unstarted ones skipped (rows still `timeout`); abandonment with
  nothing left to start still incomplete; with `Date.now()` frozen (a timer firing ahead of the
  wall clock) no source starts after an abandonment; both bounds → the first one; a self-inflicted 503 under
  an armed deadline is failed, not skipped; list-mode keyword skips and an empty selection are
  complete; a disconnect is not a bound. Controller (`jobs.controller.ndjson.spec.ts`, "crawl
  completeness on the end line"): deadline / ceiling / failures-only end lines; the record is
  cached next to the raw set with identical parameters; a hit reports the cached record without
  a fan-out; a hit with no or a malformed record re-runs the fan-out on NDJSON and rewrites both
  entries while JSON still serves it; a service without a record gets the fields omitted; a
  cancelled fan-out still has no `end` line. Pure helpers (`search-completeness.spec.ts`):
  failure reasons, record building, the cache guard (legacy job array, bad `stopReason`, bad
  counts).

## 9. Open Questions

- FR-15..FR-18 open no new question: the alternatives and the default taken are recorded as
  D-04..D-08 below.

- Q-103 — `dedupKey` derivation: per-job key vs cluster id. Default: per-job key (identical to
  the cluster id for every representative the aggregator returns, and stable across runs even
  when fuzzy clustering picks a different head).

## 10. Decisions

- D-01 — NDJSON is returned as a Nest `StreamableFile` over a `PassThrough` (passthrough `@Res`
  stays as-is), so Nest's interceptors finish before the first byte leaves; flushing headers
  from inside the handler would make `LoggingInterceptor`'s `X-Process-Time` throw.
- D-02 — The producer runs detached after the handler returns; every failure inside it becomes
  an `error` line, never an unhandled rejection.
- D-03 — `EVER_JOBS_SEARCH_DEADLINE_MS` keeps working; the contract name is an alias with
  precedence.
- D-04 (FR-15) — **Failures do not make a crawl incomplete.** Options were (A) `complete` means "no
  bound stopped the fan-out", failures reported separately; (B) `complete` also false when any
  source failed. A catalogue-wide crawl always has failing sources (dozens of blocked or dead
  boards), so (B) would make `complete` permanently false and useless as a signal. Chose A; the
  consumer gets `sourcesFailed` to apply its own threshold.
- D-05 (FR-15) — **`stopReason` is the first bound that tripped**, not a list. Both bounds in one
  crawl are rare (the ceiling stops starting sources at once; the deadline only matters for what
  is still running), and a single value keeps the contract's `"deadline" | "job_ceiling" | null`
  shape. `sourcesSkipped` counts the sources skipped by either.
- D-06 (FR-16) — **`partial` is not a failure** (it returned jobs); an abandoned-at-deadline source
  is **skipped, not failed** (the bound, not the source, is why its jobs are missing); a source that
  timed out on its own HTTP timeout is failed. The per-source reasons are unchanged, so JSON
  `per_source` rows read exactly as before.
- D-07 (FR-17) — **A separate cache entry, not an envelope.** Wrapping the raw set as
  `{ jobs, completeness }` would have changed the value every existing cache reader and test
  relies on ("the cache holds the RAW fan-out"), and entries written by the previous version would
  have become unreadable mid-rollout. The sibling entry costs one extra cache read per hit; the two
  entries share parameters and TTL, and the rare case where only one survives is FR-17's miss.
- D-08 (FR-17) — **An NDJSON hit without a record re-runs the fan-out** rather than reporting
  "unknown". The window is one cache TTL after an upgrade, only for Redis-backed caches (the
  in-memory cache starts empty), and it lets a consumer of this version rely on the fields always
  being present.

## 11. References

- `apps/api/src/jobs/jobs.controller.ts`, `apps/api/src/jobs/ndjson-writer.ts`
- `apps/api/src/config/search-config.ts`, `packages/common/src/canonical-key.ts`
