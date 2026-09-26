# Spec: 5131 — Dash-prefixed US-state sites (`ST - X` / `ST-X`)

| Field | Value |
| --- | --- |
| Spec ID | 5131 |
| Slug | dash-state-prefix-sites |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-17 |
| Related specs | 5124, 5130 |

## Problem

Workday-style labels put a US-state code ahead of a dash — `'MD - Gaither
Rd., Rockville Corp Hqtrs'`, `'MA - Boston'`, `'MA-Boston'`. Verified on
live boards, the parser mishandles both positions:

- **`ST - X` as a comma part** — the per-part `X - Y` normalization only
  consumes the *last* part, so `'MD - Gaither Rd.'` survives whole and
  lands in `city`: `'MD - Gaither Rd., Rockville Corp Hqtrs'` →
  `{city: 'MD - Gaither Rd.', name: 'Rockville Corp Hqtrs'}`.
- **`ST - X` solo** — the last-part rule strips `X` into `name`, leaving a
  bare `'MD'` that hits `normalizeCountryOnly`'s ISO alpha-2 fallback →
  `{country: 'Moldova', name: 'Gaither Rd.'}`. Most US codes collide with
  an alpha-2 country: `'MA - Boston'` → Morocco, `'CA - San Diego'` →
  Canada, `'IL - Chicago'` → Israel, `'IN - Austin'` → India.
- **`ST-X` unspaced** — `'MA-Boston'` → `{city: 'MA-Boston'}` whole.

## Scope

`packages/common/src/utils/location-parser.ts` only.

- **`ST - ` / `ST-` prefix claims `state` first** — in the per-part dash
  normalization and the bare-token path, a `^[A-Z]{2}` prefix that is a US
  state/territory code is consumed as `state` before the prefix-country,
  last-part site-name, and `normalizeCountryOnly` alpha-2 paths can
  misread it. Unspaced `ST-X` additionally requires a title-case suffix so
  hyphenates like `'CO-OP'` and `'T-Mobile'` survive whole.
- **Suffix classification** — the remainder after `ST - ` goes to `city`,
  unless its tail word is a street suffix → `name` (`'MD - Gaither Rd.'` →
  `{state:'MD', name:'Gaither Rd.'}`; `'MA - Boston'` →
  `{city:'Boston', state:'MA'}`). New `STREET_SUFFIX_RE` (~12 entries:
  `st rd ave blvd dr ln ct pkwy hwy way cir pl`), matched only inside a
  dash suffix — `'Warsaw, PL'` keeps reading as Poland.
- **`City <descriptor>` tail split** — a remaining comma part whose tail
  words all match `SITE_DESCRIPTOR_RE` (`'Rockville Corp Hqtrs'` →
  `'Corp Hqtrs'`) fills `city` with the prefix when `city` is free, else
  joins `name`. Gated on a `state` having been claimed by `ST - `, so a
  bare `'Rockville Corp Hqtrs'` still emits `city` whole.
- Leftover parts after `ST - X` consumption join `name` (`' - '` joined).

## Non-goals

- Multi-state labels (`'MD - A, VA - B'`) — first `ST -` claims the state;
  no multi-entry split (comma groups need ≥4 parts anyway).
- No street-suffix or descriptor additions outside the dash/descriptor
  rules above — the sets are scoped to these paths.
- `normalizeCountryOnly` alpha-2 fallback unchanged — the fix is ordering
  (`state` claimed first), not narrowing the country lookup.

## Contracts

    MA - Boston
{city:'Boston', state:'MA'}

    MA-Boston
{city:'Boston', state:'MA'}

    MD - Gaither Rd.
{state:'MD', name:'Gaither Rd.'}

    MD-Gaither Rd.
{state:'MD', name:'Gaither Rd.'}

    MD - Gaither Rd., Rockville Corp Hqtrs
{city:'Rockville', state:'MD', name:'Gaither Rd. - Corp Hqtrs'}

    MA - Boston, Rockville Corp Hqtrs
{city:'Boston', state:'MA', name:'Rockville Corp Hqtrs'}

    MD - Gaither Rd., Rockville
{city:'Rockville', state:'MD', name:'Gaither Rd.'}

    MD - Gaither Rd., Rockville, United States
{city:'Rockville', state:'MD', name:'Gaither Rd.', country:'United States'}

    MA - Boston, Corp Hqtrs
{city:'Boston', state:'MA', name:'Corp Hqtrs'}

Unchanged (regression guards):

    Rockville Corp Hqtrs        → {city:'Rockville Corp Hqtrs'}
    Warsaw, PL                  → {city:'Warsaw', country:'Poland'}
    MD - Remote                 → {state:'MD'}
    ON - Toronto                → unchanged ('ON' is not a US code)

## Test plan

- `location-parser.spec.ts`: one case per contract row, plus the
  alpha-2-collision regressions (`'MA - Boston'` must not emit Morocco,
  `'MD - Gaither Rd.'` must not emit Moldova) and guard cases
  (`'CO-OP'`/'T-Mobile' stay whole, `'PA - Day'` splits).
