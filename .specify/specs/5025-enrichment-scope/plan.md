# Plan: 5025 — Scope corpus-signal enrichment to the returned window

| Field | Value |
| --- | --- |
| Spec ID | 5025 |
| Status | implemented |
| Created | 2026-07-30 |

## Approach

One structural edit inside `JobsController.searchJobs`. Hoist the window
resolution above the enrichment block and introduce a single `outputJobs`
binding that every exit path returns.

Before:

```
enrich(jobs) → CSV? → paginate? slice → return
```

After:

```
isCsv / paginate → compute page + slice into outputJobs
enrich(outputJobs)
CSV? → jobsToCsv(outputJobs)
paginate? → return { …, jobs: outputJobs }
return { …, jobs: outputJobs }
```

`paginate` is computed as `!isCsv && parseBool(paginateRaw)`, which preserves
the pre-existing precedence: the CSV branch used to run before the pagination
branch, so `format=csv&paginate=true` exported the whole set. Folding `isCsv`
into the `paginate` predicate keeps that behaviour while letting one variable
drive both the window and the response shape.

`page` / `pageSize` / `totalPages` are declared before the `if` so the
pagination response block can still read them.

The non-paginated JSON exit returns `outputJobs` rather than `jobs`. They are
the same reference on that path; using `outputJobs` keeps the invariant
"the enriched set is exactly the returned set" visible at every exit.

## Why this is not a behaviour change

On the paginated path the extra verdicts were computed and then dropped by
`jobs.slice(...)` — they never reached a client. The only observable
differences are that the request finishes in seconds instead of minutes and
that far fewer outbound probes hit job boards.

## Risks

| Risk | Mitigation |
| --- | --- |
| CSV + paginate precedence silently flips | `paginate = !isCsv && …` encodes the old ordering; covered by a dedicated test. |
| Liveness/legitimacy ordering inverted | Order preserved and the coupling is called out in a comment; legitimacy reads `liveness?.state`. |
| Pagination metadata drifts | `count`/`total_pages` still derive from `jobs.length`; asserted in tests. |

## Rollback

Single commit, single method. Revert restores the prior ordering.
