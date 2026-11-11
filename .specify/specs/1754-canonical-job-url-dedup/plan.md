# Plan — Spec 1754

1. `packages/common/src/utils/job-url-dedup.ts`: pure helpers, exported from `utils/index.ts`.
2. `apps/api/src/jobs/jobs.aggregator.ts`: `dedupByUrl` option, `EVER_JOBS_DEDUP_BY_URL` switch,
   pass at the top of `dedupAndPersist` (before the engine, so assignment indexes stay aligned).
3. Tests next to each; docs index and log.

Risks: a wrong skip loses a posting, hence default off, tracking-only parameter list, fragment kept,
title required to match. Next slice: expose the switch as a request parameter and add the skip
count to the response metrics.
