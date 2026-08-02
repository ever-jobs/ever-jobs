# Plan: 5058 — Single-bound salary parsing

| Field | Value |
| --- | --- |
| Spec ID | 5058 |
| Slug | salary-single-bound |
| Status | done |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Matcher.** Add module-private `matchSingleBoundSalary(salaryStr, symbolAlt,
   numSrc)` in `packages/common/src/utils/helpers.ts`: lead-in / trailer
   vocabulary constants, currency-anchored amount tokens (prefix + suffix),
   numeric-boundary + range-tail + scale-word lookaheads, ordered candidate list.
2. **Wire into `extractSalary`.** Where the prefix/suffix/bare cascade returns no
   match, try the single-bound matcher; on a hit, run the same K-suffix,
   interval (hint | magnitude), and `[lowerLimit, upperLimit]` bounds logic used
   for a range end, then set only the stated `minAmount` / `maxAmount`.
3. **Tests.** New `describe('extractSalary — single stated bound (Spec 5058)')`
   block in `packages/common/__tests__/helpers.spec.ts` covering the test plan.
4. **Docs.** `docs/index.md`, `docs/log.md` (top), `docs/questions.md` (Q-090).

## Packages touched

- `packages/common` only (helper + its tests). No plugin, no new dependency, no
  registration points (this is a shared-utility change, not a source plugin).

## Risks

- **Range regressions.** Mitigated by ordering: single-bound runs only after the
  range cascade misses, so every existing range fixture is untouched. Full
  `packages/common` suite (200 tests) must stay green.
- **Prose false positives.** Mitigated by requiring a currency symbol on the
  amount + the scale-word lookahead; symbol-less numbers never match.
- **Range truncation.** `"from $X to $Y"` must not become a min-only floor —
  covered by the range-tail lookahead (and the numeric-boundary lookahead that
  defeats backtracking around thousands separators).

## Rollback

Revert the single change to `helpers.ts` (the matcher + the `if (!match)`
branch); the range path is independent and unaffected.