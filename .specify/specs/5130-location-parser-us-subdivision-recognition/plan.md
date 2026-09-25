# Plan: 5130 — Location parser: US state names, territories, and dotted codes

| Field | Value |
| --- | --- |
| Spec ID | 5130 |
| Status | implemented |
| Created | 2026-09-17 |

## Phases

1. **Lookup tables** — add `US_TERRITORY_NAMES` (name → display) and
   `US_TERRITORY_DISPLAY_NAMES` (set for implied-US checks); dot-strip the
   code lookup in `normalizeUsState`.
2. **Slots** — internal `usSubdivision(value)`; apply in `parseSingleLabel`
   (fused-qualifier + bare token), `parseCommaParts` (trailing state,
   `X, Country` city slot, single remaining part), and the fused-qualifier
   re-check inside the per-part loop.
3. **`City ST` split** — `bareLabelWithStateSuffix(only)` helper returning
   `{ city, state }` for title-case prefix + trailing US code; used in both
   single-token paths and the `X, Country` city slot.
4. **Merge/firm** — territory display names count as US in
   `impliedCountry` and `tryCommaGroupSplit`'s firm check.
5. **Tests + verify** — `location-parser.spec.ts` cases; run the common
   suite; `tsc --noEmit`; `lint:docs`.

## Packages touched

- `packages/common` (`src/utils/location-parser.ts`,
  `__tests__/location-parser.spec.ts`).

## Risks

- `'City ST'` splitting a legit single name ending in a code-shaped word —
  bounded by requiring the last token to be an actual US code and the prefix
  title-case; worst case is a rare false split.
- Non-code `state` values downstream — already emitted today via the
  verbatim `'City, Subdivision'` path (`'X, Puerto Rico'` →
  `state: 'Puerto Rico'`), so consumers already tolerate names; the only
  code-assumption is the parser's own `US_STATE_AND_TERRITORY_CODES`
  checks, extended here.
