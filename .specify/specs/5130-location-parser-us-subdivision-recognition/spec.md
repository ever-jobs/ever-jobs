# Spec: 5130 — Location parser: US state names, territories, and dotted codes

| Field | Value |
| --- | --- |
| Spec ID | 5130 |
| Slug | location-parser-us-subdivision-recognition |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-17 |
| Related specs | 5124, 5127 |

## Problem

`location-parser.ts` misreads four US-subdivision label shapes, verified against
live boards:

- **`'Name, Country'` city slot** — the `X, USA` branch checks the city slot
  against 2-letter codes only (`US_STATE_AND_TERRITORY_CODES`), so state
  **names** fall through to `city`: `'Arizona, USA'` emits
  `{ city: 'Arizona', country: 'United States' }` instead of
  `{ state: 'AZ', country: 'United States' }`.
- **Territory names unrecognized** — `'Puerto Rico, USA'` lands in `city`
  (same bug), and a bare `'Puerto Rico'` emits `{ city: 'Puerto Rico' }`
  while a bare `'Virginia'` correctly emits `{ state: 'VA' }`. (A
  `'X, Puerto Rico'` tail already resolves via the generic verbatim-
  subdivision path — `state: 'Puerto Rico'` — the name just isn't known to
  the US-subdivision machinery.)
- **Dotted codes** — `'D.C'` / `'D.C.'` / `'N.Y.'` resolve to nothing, so
  `'Washington, D.C'` leaves the tail unhandled. Worse, inside a
  comma-packed group (`'Bristol, RI, Washington, D.C'`) the unresolved tail
  fails `tryCommaGroupSplit`'s firm check and the whole 4-part label
  collapses into one `city` blob.
- **Unseparated `'City ST'`** — `'Bristol RI'` (space-joined, no comma)
  emits `{ city: 'Bristol RI' }` instead of `{ city: 'Bristol', state: 'RI' }`.

## Scope

`packages/common/src/utils/location-parser.ts` only:

- `normalizeUsState` — strip periods before the code lookup so `D.C.` → `DC`,
  `N.Y.` → `NY` (any dotted 2-letter code).
- New `US_TERRITORY_NAMES` map — lowercase name → display name:
  `puerto rico` → `Puerto Rico`, `guam` → `Guam`,
  `virgin islands` / `u.s. virgin islands` → `U.S. Virgin Islands`,
  `american samoa` → `American Samoa`,
  `northern mariana islands` → `Northern Mariana Islands`. Emits the
  display name verbatim — not a code — matching the existing verbatim-
  subdivision convention (`'Ontario'`).
- New internal `usSubdivision(value)` — `normalizeUsState` result or
  territory display name. Used wherever a US subdivision can appear: bare
  single-token labels, the `X, Country` city slot, the fused-qualifier
  slot, and the trailing-state slot.
- `X, Country` city slot — `usSubdivision(city)` replaces the codes-only
  check; `BARE_STATE_NAME_COLLISIONS` stays exempt so `'New York, USA'`
  remains a city. The same slot also tries the `'City ST'` split when the
  state check fails (`'Bristol RI, USA'` → city + state + country).
- `'City ST'` split — a bare label ending in a US-state code with a
  title-case city prefix (`isBareCityCandidate`) emits
  `{ city, state }` (`'Bristol RI'`, `'San Juan PR'`,
  `'Washington D.C'`). Gated on `allowBareStateProvince` like the other
  bare-state reads.
- `impliedCountry` and the `tryCommaGroupSplit` firm check — recognize the
  territory display names as US subdivisions so `state: 'Puerto Rico'`
  implies `United States` for merge/veto and counts as a firm pair.

## Non-goals

- No plugin changes — all callers get the fixes through `parseLocationList`
  / `parseLocationText`.
- `normalizeUsState` keeps its code-or-null contract (plugins call it
  directly with `?? raw` fallbacks); territory names live in the internal
  `usSubdivision` helper.
- No country stamping on bare state/territory labels — `'Puerto Rico'`
  emits `{ state: 'Puerto Rico' }` without a country, matching
  `'Virginia'` → `{ state: 'VA' }`.
- No change to `BARE_STATE_NAME_COLLISIONS` membership or the
  `allowBareStateProvince` flag semantics.

## Contracts

- `'Arizona, USA'` → `{ state: 'AZ', country: 'United States' }`;
  `'Puerto Rico, USA'` → `{ state: 'Puerto Rico', country: 'United States' }`.
- `'Puerto Rico'` → `{ state: 'Puerto Rico' }`; `'Virginia'` →
  `{ state: 'VA' }` (unchanged).
- `'Washington, D.C'` / `'Washington, D.C.'` →
  `{ city: 'Washington', state: 'DC' }`; `'Albany, N.Y.'` →
  `{ city: 'Albany', state: 'NY' }`.
- `'Bristol, RI, Washington, D.C'` → two entries:
  `{ city: 'Bristol', state: 'RI' }` and
  `{ city: 'Washington', state: 'DC' }`.
- `'Bristol RI'` → `{ city: 'Bristol', state: 'RI' }`;
  `'New York, USA'` → `{ city: 'New York', country: 'United States' }`
  (collision exemption preserved).
- `'X, Puerto Rico'` → `{ city: 'X', state: 'Puerto Rico' }` (value
  unchanged; now recognized as a US subdivision for merge/firm logic).

## Test plan

- Extend `location-parser.spec.ts` with one case per contract bullet above,
  plus regressions: `'New York, USA'` stays city, `'Ontario, Canada'`
  verbatim path unchanged, `'Washington, D.C'` inside a comma group splits.
