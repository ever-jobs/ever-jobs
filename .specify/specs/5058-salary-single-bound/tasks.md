# Tasks: 5058 — Single-bound salary parsing

- [x] T01 Add lead-in / trailer vocabulary + scale-word constants to `helpers.ts`.
- [x] T02 Add `SingleBoundSalaryMatch` type + `matchSingleBoundSalary()` with the
      numeric-boundary and range-tail lookaheads.
- [x] T03 Wire the single-bound branch into `extractSalary` after the range
      cascade misses (interval hint | magnitude, bounds check, one-sided result).
- [x] T04 Add the Spec-5058 `describe` block to `helpers.spec.ts` (lower/upper,
      trailer shapes, K-suffix, magnitude, hint, bounds, range-not-truncated,
      prose immunity, scale-word guard, `salaryToCompensation` one-sided DTO).
- [x] T05 Run `npx jest packages/common` — 200 tests green.
- [x] T06 Docs: `docs/index.md`, `docs/log.md` (top entry), `docs/questions.md`
      (Q-090 for the deferred to-range / symbol-less scope).
- [x] T07 Diff/privacy scan (no private refs, no session URLs); commit + PR.
