# Spec: 5058 — Single-bound salary parsing (lower-only / upper-only)

| Field | Value |
| --- | --- |
| Spec ID | 5058 |
| Slug | salary-single-bound |
| Status | implemented |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | 012 (european salary parser), 014/015/019 (salary parser residuals), 5018 (shared compensation resolution), 5045/5057 (company plugins that meet single-amount pay) |

## Problem

`extractSalary` (and therefore `salaryToCompensation` / `compensationFromSalary`)
only recognises a **two-ended range** (`min – max`). The regex cascade — prefix /
suffix / bare — always captures two numbers around a dash, and the bounds check
enforces `min < max`. A posting that states a **single** bound is dropped:

- lower-only: `"From $48,000.00 per year"`, `"$120,000+"`, `"at least $90k"`
- upper-only: `"Up to $90,000"`, `"$60,000 or less"`

These are real, employer-published figures (e.g. Spec 5057 FLYMOTION's live role
states `Pay: From $48,000.00 per year`). Without shared support such a figure is
simply lost — or would have to be worked around in individual plugins,
duplicating parsing logic that belongs in the shared helper.

## Scope

- Extend `extractSalary` to recognise a single stated bound **after** the
  two-ended range cascade misses, setting only `minAmount` (lower marker) or only
  `maxAmount` (upper marker) — never a fabricated opposite end.
- Reuse the existing currency detection, locale dispatch, K-suffix arithmetic,
  interval magnitude inference / hint, and lower/upper bounds check.
- `compensationFromSalary` already emits a one-sided `CompensationDto` when only
  one bound is present (Spec 5018), so `salaryToCompensation` gains single-bound
  support with no change to the mapping layer.

## Approach

- New module-private `matchSingleBoundSalary(salaryStr, symbolAlt, numSrc)` tried
  only when the prefix / suffix / bare range patterns all miss.
- The amount **must** carry a currency symbol / ISO code (prefix `$100k` or
  suffix `100k €`); bare numbers never match, so prose like `"at least 5 years"`
  or `"up to 3 reports"` is immune.
- Direction is read from an English lead-in keyword (`from`, `starting at`,
  `at least`, `minimum of` → lower; `up to`, `no more than`, `maximum of` →
  upper) or a trailing marker (`+`, `or more`, `and up` → lower; `or less`,
  `or under` → upper). Keyword-led shapes are tried before trailer shapes.
- Guards:
  - a numeric-boundary lookahead forces the number to match maximally so
    backtracking can't capture `100` out of `100,000`;
  - a range-tail lookahead rejects a `"from $X to $Y"` range so it is NOT
    truncated to a min-only floor (it stays a no-match, its prior behaviour,
    since the range cascade only recognises dash separators);
  - a scale-word lookahead (`million` / `billion` / …) prevents lifting `$5`
    out of `"from $5 million"`.
- The single value is intervalled + bounds-checked exactly like a range end:
  explicit `options.interval` wins, else magnitude (hourly < 350 < monthly <
  30000 ≤ yearly); the annualised value must sit within `[lowerLimit,
  upperLimit]` or the parse is discarded.

## Contract

```ts
// unchanged signature; new behaviour when no two-ended range is present
function extractSalary(
  salaryStr: string | null,
  options?: ExtractSalaryOptions,
): ExtractSalaryResult;
// e.g. extractSalary('From $48,000 per year')
//   → { interval: 'yearly', minAmount: 48000, maxAmount: null, currency: 'USD' }
//      extractSalary('Up to $90,000')
//   → { interval: 'yearly', minAmount: null, maxAmount: 90000, currency: 'USD' }
```

- Two-ended range behaviour is **byte-for-byte unchanged** — the single-bound
  path runs only after the range cascade returns no match, so every existing
  fixture stays green.
- A single bound below `lowerLimit` / above `upperLimit` (annualised) yields the
  all-`null` envelope, same as a range end.
- `salaryToCompensation('From $48,000 per year')` →
  `CompensationDto { minAmount: 48000, interval: YEARLY }` (no `maxAmount`).

## Files

- `packages/common/src/utils/helpers.ts`
- `packages/common/__tests__/helpers.spec.ts`

## Non-goals

- Adding `"from $X to $Y"` (word-separator) **range** parsing — out of scope; the
  guard only ensures such input is not mis-read as a single bound (Q-090).
- Symbol-less single amounts under a country hint (`"at least 90 000"`) — deferred
  to avoid prose false positives (Q-090).
- Non-English lead-in vocabulary.
- Changing `CompensationDto`, the currency/locale layer, or the bounds defaults.

## Test plan

- lower-only `"From $X per year"` → `minAmount` only, `maxAmount` null.
- upper-only `"Up to $Y"` → `maxAmount` only, `minAmount` null.
- trailer shapes `"$X+"` (floor) and `"$Y or less"` (ceiling).
- K-suffix on a single bound (`"from $120K"` → 120000).
- magnitude interval for a single bound (`"starting at $25/hr"` → hourly).
- explicit interval hint on a single bound.
- bounds rejection (single value below the floor → null).
- dash range still wins (`"from $100,000 - $150,000"` → both ends).
- `"from $X to $Y"` NOT truncated to a floor (stays null).
- symbol-less prose ignored (`"at least 5 years"` → null).
- scale-word guard (`"from $5 million"` → null).
- `salaryToCompensation` threads a single bound into a one-sided `CompensationDto`.
