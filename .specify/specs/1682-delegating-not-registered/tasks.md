# Tasks: 1682 — 699 delegating plugins report a registry miss as `not_registered`

- [x] T1 — `scripts/codemod/delegating-diagnostics.ts`: validating transform for the 699 delegating services. Acceptance: dry run reports `transformed=699 skipped=841 corrupt=0` with the census backend split (Ashby 219, SmartRecruiters 217, Lever 180, Recruitee 83) and no unexpected skip reasons.
- [x] T2 — Codemod safety: mandatory `--expect`, precondition gate, postcondition gate (TypeScript `parseDiagnostics`, exactly one `not_registered`, no surviving bare empty return, exact line delta), and non-zero exit on any mismatch. Acceptance: a codemod that cannot fail loudly is not safe at this scale.
- [x] T3 — EOL/BOM preservation: read bytes, normalise in memory only, restore on write. Acceptance: `git diff --numstat` equals `git diff --ignore-all-space --numstat` (1,398 both).
- [x] T4 — Derive the backend label from the adjacent logger line rather than hard-coding it. Acceptance: a new backend needs no codemod change, and the seven company names containing `\'` are handled because the capture ends before the company name.
- [x] T5 — `scripts/codemod/delegating-diagnostics-specs.ts`: add the `not_registered` assertions to the 699 specs, reading the label from the sibling service migrated in pass 1 so the passes cannot disagree. Acceptance: `transformed=699 corrupt=0`.
- [x] T6 — Apply both passes. Acceptance: 699 services uniformly `+7/-1`, 699 specs uniformly `+4/0`, zero outliers.
- [x] T7 — Sabotage verification: flip `not_registered` to `empty` in one service and confirm its spec FAILS. Acceptance: the new assertion has teeth, unlike the `expect(result.jobs).toHaveLength(0)` it joins. Reverted after.
- [x] T8 — `tsc --noEmit` clean across the monorepo; targeted suites green (one per backend, both escaped-apostrophe names, plus a wider spread).
- [x] T9 — Docs: `.specify` spec/plan/tasks, `docs/index.md` row + footer, `docs/log.md` entry; `lint:docs` clean.

## Notes

**No bot review on this PR.** 1,398 files exceeds Greptile's 100-file limit, so it will post
"Too many files changed for review" and leave no findings. That is precisely why the mechanical
gates above carry the weight, and why the diff is exactly two shapes and nothing else — it is
reviewable by shape rather than by reading 1,398 hunks.

**Still to come:** PR 4 the 822 canonical-swallow services + 806 specs (plus `source-company-tiktok`
by hand), PR 5 the 268-file tail clustered by exact catch-tail with a dry run per cluster.
