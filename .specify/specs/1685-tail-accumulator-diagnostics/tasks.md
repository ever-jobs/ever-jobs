# Tasks: 1685 — the tail cluster returning the accumulator without a reason

- [x] T1 — Re-cluster the 164 remaining services by what the last catch of the brace-matched `scrape()` body does. Acceptance: D=126, B=30, A=5, C/F=3 — and the finding that **cluster A was never broken**, since those five let the error propagate to the fan-out's `rejected` branch, which already classifies it.
- [x] T2 — `scripts/codemod/tail-accumulator-catch-diagnostics.ts` for cluster D. Acceptance: `transformed=126 corrupt=0`, matching the cluster count independently.
- [x] T3 — Anchor must tolerate a trailing comment. Acceptance: the common shape is `return new JobResponseDto(jobPosts); // partial results`; a `;$` anchor matched only **2 of 126**.
- [x] T4 — Anchor must accept a call expression argument (47 files return `jobPosts.slice(0, resultsWanted)`), capturing it whole and verifying balanced parens with no top-level comma. Acceptance: an existing second argument can never be mangled.
- [x] T5 — Scope proved by brace matching and re-derived from the output (Spec 1684's lesson). Acceptance: independent re-check finds 0 violations across 126 files.
- [x] T6 — Apply. Acceptance: 126 files uniformly `+5/-1`, zero outliers, no EOL churn, `tsc --noEmit` 0 errors, targeted suites green.
- [x] T7 — Cluster B: attempt, evaluate, **abandon**. Acceptance: the three-point transform's own gate rejected 31 of 37 as ambiguous (multiple `err` catches), and `tsc` rejected 3 of the remaining 6 with `Cannot find name 'diagnostics'`. Reverted in full (`tsc` back to 0) and the tool **deleted** rather than left in-tree for someone to trust later.
- [x] T8 — Docs: `.specify` spec/plan/tasks, `docs/index.md` row + footer, `docs/log.md` entry; `lint:docs` clean.

## What remains — enumerated, not rounded away

**38 services**, of which only 33 are actually wrong:

- **30 (cluster B)** — catch falls through to a later return; needs a `diagnostics` variable threaded through. Hand edits; the codemod attempt is documented above so nobody repeats it.
- **5 (cluster A)** — `source-ats-joincom`, `source-ats-successfactors`, `source-careerbuilder`, `source-monster`, `source-simplyhired`, `source-tesla` class: no catch in `scrape()`, so the throw reaches the fan-out and is classified there. **Correct as-is; changing them would be a regression.**
- **3 (clusters C/F)** — ambiguous shapes, hand review.

Final state of the sequence: **1,801 of 1,839 services report a real reason, 5 are correct by
design, and 33 are documented for hand review.**
