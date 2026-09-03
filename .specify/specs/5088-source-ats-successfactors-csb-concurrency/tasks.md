# Tasks: 5088 — SuccessFactors CSB concurrency

- [ ] T1 — Add `SF_CSB_PAGE_CONCURRENCY = 4` and update `SF_CSB_DETAIL_CONCURRENCY = 10` in `successfactors.constants.ts`. Acceptance: constants are exported and `tsc --noEmit` clean.
- [ ] T2 — Refactor `SuccessFactorsService.collectCsbTiles` to fetch tile pages in concurrent batches and stop on empty/duplicate/error. Remove per-page `randomSleep`. Acceptance: existing tests still pass; a manual probe with ~180 jobs completes in < 15 s.
- [ ] T3 — Extend `__tests__/successfactors-csb.service.spec.ts` with batching and early-termination tests. Acceptance: new tests pass.
- [ ] T4 — Update `docs/index.md` and `docs/log.md` with Spec 5088. Acceptance: no broken links.
- [ ] T5 — Run plugin Jest suite and `tsc --noEmit`. Acceptance: all green.
- [ ] T6 — Push branch and open PR. Acceptance: PR description follows the concise external-audience format.
