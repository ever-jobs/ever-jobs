# Spec: 5025 — Scope corpus-signal enrichment to the returned window

| Field | Value |
| --- | --- |
| Spec ID | 5025 |
| Slug | enrichment-scope |
| Status | implemented |
| Owner | agent |
| Created | 2026-07-30 |
| Last updated | 2026-07-30 |
| Related specs | 740, 721, 5024, 5026 |

## Problem

Second of three contributors to the production 4Gi OOMKill (see Spec 5024 for
the first).

`JobsController.searchJobs` ran liveness and legitimacy enrichment **before**
the pagination slice:

```
aggregateRaw  →  jobs (full deduped corpus)
enrichLiveness(jobs)          ← every job in the corpus
enrichLegitimacy(jobs)        ← every job in the corpus
CSV branch
pagination:  pageJobs = jobs.slice(start, start + pageSize)   ← only now
return { jobs: pageJobs }
```

So a `?paginate=true&page_size=25` request over a 16 000-job corpus issued
**16 000 outbound HTTP liveness probes** and then discarded 15 975 of the
verdicts. `LivenessHttpService` runs a worker pool of concurrency 5 with a 15 s
per-URL timeout, so the handler stays alive for tens of minutes with the entire
corpus pinned in memory.

This matters far more than it looks, because the only production caller sends
the flag on **every** request: `ever-hust/packages/jobs-api/src/index.ts` sets
`liveness=true&legitimacy=true` unless `EVER_JOBS_REQUEST_SIGNALS=false`. Spec
740's "opt-in; zero work on the default path" is true of the code and false of
the deployment.

Combined with Spec 5026 (no server-side request deadline, client aborts at
120 s and retries twice), abandoned handlers accumulate and each one holds a
full corpus. That is the *amplitude* of the sawtooth.

## Scope

Resolve the output window (pagination slice, or the full set for CSV and
non-paginated JSON) **before** enrichment, then enrich exactly the records
being returned.

## Non-goals

- Removing or defaulting-off the liveness/legitimacy flags. The client asked
  for signals on the results it receives, and it still gets them.
- Changing `LivenessHttpService` concurrency, timeouts or batching.
- Pagination semantics: `count`, `total_pages`, `next_page` etc. continue to
  describe the **full** corpus.

## Contracts

| Request shape | Enriched set | Returned set |
| --- | --- | --- |
| `?paginate=true&page=N&page_size=K` | the K jobs on page N | same K jobs |
| no `paginate` | full deduped corpus | same |
| `?format=csv` (with or without `paginate`) | full deduped corpus | same — CSV exports everything |

Ordering is preserved: liveness runs before legitimacy, because
`enrichLegitimacy` folds in `job.liveness?.state === 'expired'` as its
`redirectsOffPlatform` input.

## Test plan

`apps/api/__tests__/jobs/corpus-signals.spec.ts`, using a liveness stub that
records every URL it is asked about:

- 500-job corpus, `paginate=true&page=2&page_size=25` → exactly **25** probes
  (pre-5025: 500), `jobs` has 25 entries, `count` still reports 500.
- 100-job corpus, page 2 of 10 → probed URLs are exactly jobs 10–19, and every
  returned job carries both signals.
- No pagination → full set still enriched (30 of 30).
- `format=csv` with `paginate=true` → full set enriched (40 of 40), since CSV
  returns everything.

Existing Spec 740 cases (default path attaches nothing; each flag works alone)
must stay green.
