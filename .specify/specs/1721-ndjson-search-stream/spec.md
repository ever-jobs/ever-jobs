# Spec: 1721 — NDJSON search stream, configurable fan-out deadline, per-job dedup key

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1721                                     |
| Slug           | ndjson-search-stream                     |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-24                               |
| Last updated   | 2026-09-24                               |
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

## 3. Non-Goals

- Streaming *while* scraping (emitting jobs before the fan-out ends). Dedup, liveness and
  legitimacy need the whole set, and the contract requires the JSON order.
- Cancelling in-flight scrapers on client disconnect (no `AbortSignal` in the plugin contract).
- Changing the JSON response shape (only the additive `dedupKey` per job).

## 4. Caller Stories

> As a **corpus builder**, I want every job of a 25 k-job search as a stream, so that I never
> have to paginate and never lose the connection to an idle-timeout.

> As a **corpus builder**, I want a stable `dedupKey` per posting, so that I can upsert the same
> posting seen from a job board today and from the company's ATS tomorrow into one row.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `POST /api/jobs/search?format=ndjson` answers `200` with `Content-Type: application/x-ndjson; charset=utf-8`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`. The first line is written as soon as the fan-out starts (on a cache hit, the first job line), so headers reach the client immediately. | must |
| FR-2  | While scraping (and while dedup/liveness run), a `{"type":"progress","sourcesDone":n,"sourcesTotal":m,"jobs":k}` line is written at fan-out start and then at most every ~10 s (`NDJSON_HEARTBEAT_MS = 10 000`). `jobs` counts raw jobs collected so far. | must |
| FR-3  | Then exactly one `{"type":"job","data":{…}}` line per job, in the same order and with the same per-job JSON as the unpaginated JSON response (`JSON.stringify(job)`; any extra field another feature adds passes through untouched). | must |
| FR-4  | Then exactly one `{"type":"end","total":N,"deduped":bool,"durationMs":ms}`; `total` equals the number of job lines. | must |
| FR-5  | Any failure after headers were sent writes `{"type":"error","message":"…"}` and closes the stream with **no** `end` line. Consumers must treat a missing `end` as truncated. | must |
| FR-6  | `paginate`, `page`, `page_size` are ignored in NDJSON mode. `dedup`, `liveness`, `legitimacy` apply exactly as for JSON (liveness still subject to Spec 1723's gate and cap). Cache read/write is identical to JSON. | must |
| FR-7  | Lines are written one at a time with back-pressure (`write()` → `drain`); the full payload is never materialised as one string. On client disconnect the writer stops writing (the scrape itself cannot be cancelled). | must |
| FR-8  | Unknown `type` values are reserved for future use; consumers must ignore them. | must |
| FR-9  | `search.deadlineMs` resolves `EVER_JOBS_FANOUT_DEADLINE_MS`, then `EVER_JOBS_SEARCH_DEADLINE_MS`, then `120000`. Blank / non-numeric values fall through to the next source; `0` or negative disables the deadline (existing semantics). | must |
| FR-10 | Every returned job carries `dedupKey`: `sha256(normalizeCompany(company) + "|" + normalizeTitle(title) + "|" + normalizeLocation(location))` — the same function the dedup engine uses for `canonicalJobId`. Computed on the output set for `dedup=true` and `dedup=false`, from cache or fresh. Absent only when a job has neither title nor company. | must |
| FR-11 | CSV gains a `dedupKey` column automatically; nested arrays inside object fields are joined with `; ` (same as top-level arrays) so extra structured fields remain readable. GraphQL `JobPostGql` gains `dedupKey`. | must |

## 6. Non-Functional Requirements

| ID    | Requirement | Target |
| ----- | ----------- | ------ |
| NFR-1 | Peak extra memory of NDJSON vs JSON | one line buffer (≤ one job) + the stream high-water mark |
| NFR-2 | Time to first byte | ≤ fan-out setup (no scraping) |
| NFR-3 | `dedupKey` cost | one sha-256 per returned job (~25 µs) |

## 7. Contracts

### 7.1 Wire format

```text
{"type":"progress","sourcesDone":0,"sourcesTotal":1669,"jobs":0}
{"type":"progress","sourcesDone":412,"sourcesTotal":1669,"jobs":6120}
{"type":"job","data":{"id":"…","title":"…","dedupKey":"4f1c…",…}}
…
{"type":"end","total":21873,"deduped":true,"durationMs":151234}
```

Failure: `…{"type":"error","message":"<reason>"}` then EOF, no `end`.

### 7.2 Interface

```ts
export interface SearchProgress { sourcesDone: number; sourcesTotal: number; jobs: number }
export function dedupKeyForJob(job: Pick<JobPostDto,'title'|'companyName'|'location'>): string | undefined; // @ever-jobs/common
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
  `canonicalJobId`; class vs plain `LocationDto` → same key.
- Aggregator: `dedupKey` present on `dedup=true`, `dedup=false`, no-engine paths.

## 9. Open Questions

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

## 11. References

- `apps/api/src/jobs/jobs.controller.ts`, `apps/api/src/jobs/ndjson-writer.ts`
- `apps/api/src/config/search-config.ts`, `packages/common/src/canonical-key.ts`
