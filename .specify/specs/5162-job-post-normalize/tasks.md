# Tasks 5162

| Field | Value |
| ----- | ----- |
| Spec | `.specify/specs/5162-job-post-normalize/spec.md` |
| Plan | `.specify/specs/5162-job-post-normalize/plan.md` |

- [ ] T1. `job-post-normalize.ts` in `packages/common/src/utils` +
  `normalizeJobPost` export via `utils/index.ts`.
- [ ] T2. `jobs.service.ts`: normalize pass over `allJobs` after
  `postProcessSalary`, before sort.
- [ ] T3. `packages/common/__tests__/job-post-normalize.spec.ts` per the spec's
  test plan.
- [ ] T4. `jest` scoped run + `tsc` typecheck + lint.
- [ ] T5. `docs/index.md` row + `docs/log.md` prepend; commit, push, PR to
  `develop`.
