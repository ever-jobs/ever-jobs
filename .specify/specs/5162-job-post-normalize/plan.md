# Plan 5162

| Field | Value |
| ----- | ----- |
| Spec | `.specify/specs/5162-job-post-normalize/spec.md` |
| Package | `packages/common`, `apps/api` |

## Phase 1 — util

- `packages/common/src/utils/job-post-normalize.ts`:
  `EDGE_WS_RE`/`INNER_WS_RE` (`\s` + \u200B-\u200D + \uFEFF),
  `cleanEnds` (trim → `null` when blank), `cleanText` (trim + collapse),
  `cleanList` (clean/drop/dedupe), `cleanLocation`, and
  `normalizeJobPost(job): JobPostDto` returning a new object.
- Export from `packages/common/src/utils/index.ts`.

## Phase 2 — service wiring

- `apps/api/src/jobs/jobs.service.ts`: import `normalizeJobPost`; after the
  salary post-processing loop and before sorting, replace each aggregated job
  with its normalized copy.

## Phase 3 — tests & docs

- `packages/common/__tests__/job-post-normalize.spec.ts` per the spec's test
  plan.
- `jest` scoped to the new spec + `tsc` + lint; `docs/index.md` row,
  `docs/log.md` prepend; commit, push, PR to `develop`.

## Risks

- **Identity fields.** Trimming `id`/`atsId`/`jobUrl`/`applyUrl` could split a
  dedupe key that compared raw strings — ends-only trim is still correct
  (stray padding is never meaningful), and inner chars are preserved so no
  silent joining occurs.
- **Ordering vs. salary post-processing.** `postProcessSalary` writes
  `salarySource` — normalize must run after it (it does).
- **Scope.** The pass runs on the aggregated response only; plugin internals
  and cached payloads are unchanged.
