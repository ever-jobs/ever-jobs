# Tasks: 1686 — the last 33, finished by reading them

- [x] T1 — Enumerate and classify every remaining service by catch shape. Acceptance: 38 total — 33 needing work, 5 (`joincom`, `careerbuilder`, `monster`, `simplyhired`, `tesla`) correct as-is because they have no catch and the fan-out's `rejected` branch classifies their throw.
- [x] T2 — `scripts/codemod/apply-fallthrough-diagnostics.ts`: judgement supplied per file (declaration line, accumulator, which catch), mechanics automated (brace matching, import insertion, CRLF/BOM preservation, scope verification). Acceptance: it does not guess the declaration point — that guess is what made Spec 1685's automatic version fail `tsc` on half its output.
- [x] T3 — Auto-derive the unambiguous entries. Acceptance: 15 applied, `tsc` clean.
- [x] T4 — Fix the applier's assignment indentation. Acceptance: cosmetic, but it would have landed wrong in 15 files; caught and re-verified before continuing.
- [x] T5 — Resolve the files with multiple terminal returns by recognising the early `return new JobResponseDto([])` as a guard rather than the terminal. Acceptance: 11 more applied; the applier correctly refused `personio` and `exa` with `CATCH_HAS_RETURN`.
- [x] T6 — Hand-edit the 5 singular services. Acceptance: `avature` (accumulator mapped only at the return, catch inside the loop `break`s), `loxo` (two surfaces — the last tried owns the reason), `personio` (two domains + XML parse, three distinct failure points), `builtin`/`dice` (multi-strategy — the primary failure is a routing signal, reported only if every fallback is also empty), `tiktok` (nested try/finally, returned a bare `{ jobs }`).
- [x] T7 — Upgrade guard clauses found while reading: missing `companySlug`, uninitialised Exa client, neither Personio domain answering. Acceptance: `bad_input`/`empty` with a detail rather than a bare empty result — inputs and configuration failing, not empty boards.
- [x] T8 — Final census. Acceptance: **1,827 of 1,832 report a reason, 5 delegate by design, 0 unmigrated.** 33 files, `tsc` 0 errors, no EOL churn, targeted suites green.
- [x] T9 — Docs: `.specify` spec/plan/tasks, `docs/index.md` row + footer, `docs/log.md` entry; `lint:docs` clean.

## Note on the previous spec's wording

Spec 1685 called these "hand review", which reads as someone else's job. It only ever meant "needs
per-file judgement rather than a pattern". The judgement was the work; the mechanics stayed
automated. Nothing here required a different pair of hands.
