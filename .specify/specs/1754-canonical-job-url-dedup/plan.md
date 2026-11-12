# Plan — Spec 1754

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1754       |
| Status       | done       |
| Last updated | 2026-11-12 |

1. `packages/common/src/utils/job-url-dedup.ts`: pure helpers, exported from `utils/index.ts`.
2. `apps/api/src/jobs/jobs.aggregator.ts`: `dedupByUrl` option, `EVER_JOBS_DEDUP_BY_URL` switch,
   pass in `aggregateRaw`, only when the dedup engine does not run (`dedup=false` or no engine bound).
3. Tests next to each; docs index and log.

Risks: a wrong skip loses a posting, hence default off, tracking-only parameter list, fragment kept,
same canonical URL and the same company, title, location and employment class required to match. Next slice: expose the switch as a request parameter and add the skip
count to the response metrics.
