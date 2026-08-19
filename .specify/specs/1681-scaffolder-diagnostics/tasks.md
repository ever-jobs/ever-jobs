# Tasks: 1681 — Stop the generators minting the swallowed-error shape

- [x] T1 — `scaffold-company-source.ts`: emit `classifyScrapeError` in the models import, return `new JobResponseDto(jobs, classifyScrapeError(err))` from the catch, and `new JobResponseDto(jobs)` on the success path. Acceptance: no emitted `return { jobs };`; `jobs` passed rather than `[]` so partial results survive.
- [x] T2 — `scaffold-{ashby,lever,recruitee,smartrecruiters,workable}-company-source.ts`: emit `ScrapeDiagnostics` and report the registry miss as `new ScrapeDiagnostics('not_registered', '<Backend> source plugin is not registered')`. Acceptance: each backend emits its own message; no bare `return new JobResponseDto([]);`.
- [x] T3 — Generated test template asserts `result.diagnostics?.reason === 'fetch_error'` for the 500 its own mock throws. Acceptance: asserting `jobs` alone passed before and after a botched change, so the reason assertion is the one that pins the contract.
- [x] T4 — Export `scaffoldOne` from the five delegating scaffolders. Acceptance: importable by a spec — being module-private is why none of them had tests.
- [x] T5 — New `scripts/__tests__/scaffold-delegating-company-source.spec.ts`, parameterised over all five backends. Acceptance: 16 tests covering delegation shape, the `not_registered` contract, absence of the swallow, and cross-backend consistency.
- [x] T6 — Extend `scripts/__tests__/scaffold-company-source.spec.ts` to pin the emitted catch and both return shapes. Acceptance: it asserted URLs and class names but never the error handling, so the template was previously unpinned.
- [x] T7 — End-to-end smoke: scaffold a throwaway plugin, wire it, run its generated suite (**11/11**), revert. Acceptance: `git status` shows only the intended `scripts/` changes afterwards.
- [x] T8 — Docs: `.specify` spec/plan/tasks, `docs/index.md` row + footer, `docs/log.md` entry; `lint:docs` clean and `scripts/__tests__` green (**182/182 across 11 suites**, up from 166).

## Notes

**Emitted comments must not contain backticks.** The templates are TypeScript template literals, so
a backtick inside an emitted comment terminates the string. This bit twice while writing this PR —
`Cannot find name 'jobs'` and `Cannot find name 'not_registered'` — each caught by the compiler
through the scaffolder's own suite rather than by review.

**Still to come:** PR 3 the 699 delegating services + specs, PR 4 the 822 canonical services + 806
specs (plus `source-company-tiktok` by hand), PR 5 the 268-file tail clustered by exact catch-tail.
