# Tasks: 1684 — the tail cluster whose catch returns a bare empty result

- [x] T1 — Re-scope the tail by brace-matching `scrape()` rather than taking the last catch in the file. Acceptance: corrects the earlier classifier, which conflated the outer catch with per-item and helper catches; 264 remaining services resolve into 68 clusters, most of the large ones being inner catches out of scope here.
- [x] T2 — Identify the largest genuinely mechanical cluster: exactly one catch binding `err` whose own block returns `new JobResponseDto([])`. Acceptance: 100 services, needing no restructuring.
- [x] T3 — `scripts/codemod/tail-empty-catch-diagnostics.ts` with brace matching, not a spanning regex. Acceptance: the return is *proved* to sit inside the catch block; `source-ats-loxo`, whose bare return is at method level, is correctly skipped.
- [x] T4 — Postcondition that re-derives scope **from the output**: the inserted call must sit inside an `err`-binding catch in the rewritten text. Acceptance: this is precisely the check the first version lacked — its spanning regex crossed a closing brace and produced `Cannot find name 'err'`, which parsed fine and passed every other gate. Only `tsc` caught it.
- [x] T5 — Only catches binding `err` are eligible; `error`/`e` are left alone rather than renamed. Acceptance: no variable renaming anywhere in the diff.
- [x] T6 — Apply. Acceptance: 100 files uniformly `+2/-1`, zero outliers; both diff forms report 100 (no EOL churn); `tsc --noEmit` **0 errors**.
- [x] T7 — Independent re-check, written not to reuse the codemod's own logic so it cannot share a blind spot: every inserted call's nearest enclosing catch binds `err`. Acceptance: 0 violations.
- [x] T8 — Targeted suites green across transformed plugins.
- [x] T9 — Docs: `.specify` spec/plan/tasks, `docs/index.md` row + footer, `docs/log.md` entry; `lint:docs` clean.

## Notes

**What remains, stated plainly:** 164 services still report `empty` for real failures — 162 whose
`scrape()` has no bare-empty catch return (catches inside loops or helpers, or they rethrow), and 2
with several such returns, flagged for hand review. The honest end state of this sequence is
**1,721 of 1,839 migrated, 164 documented** — not "done".

**Partial results are untouched.** Plugins in this cluster discard whatever they had accumulated when
they fail, because their accumulator is declared inside the `try` and is out of scope in the catch.
Recovering it needs a per-file hoist and its own review; this spec only makes the failure legible.
