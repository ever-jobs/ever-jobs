# Spec: 5060 — Opt-in bare state/province classification in the shared location parser

| Field | Value |
| --- | --- |
| Spec ID | 5060 |
| Slug | location-bare-state-province |
| Status | implemented |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | 5024/5025/5026/5027 (isRemote + location parsing), 5059 (company plugin whose only location signal is a bare state) |

## Problem

The shared `parseLocationText` / `parseLocationList` only fill the `state` field
when the input is an exact `City, ST` pair (a comma-separated city + 2-letter
code). The private `normalizeUsState()` already maps **both** a full US state
name (`"Virginia"`) and a 2-letter code (`"VA"`) to a canonical code — but it is
only reached inside `canonicalUsLocation()`, which requires at least two
comma-separated parts. So a **lone token** carrying no city (`"Virginia"`,
`"VA"`) skips that path entirely and lands in the `city` field with `state`
empty.

That is wrong for a source whose only location signal is a bare state. It cannot
be fixed by unconditionally promoting any bare state token, because that would
change behaviour for every existing caller and misclassify real bare city names
that happen to equal a state word (e.g. `"Virginia"`, MN; `"Washington"`, a
city) — a decision that must stay per-source.

## Scope

- Add an **opt-in** flag to `parseLocationText` and `parseLocationList` so a
  caller can request that a bare token equal to a known US state/territory
  **name** or **code** be classified as a **state-only** `LocationDto`
  (`{ state: 'VA' }`), reusing the existing `normalizeUsState()`.
- Default behaviour (flag absent / false) is **byte-for-byte unchanged** for
  every current caller.
- No new state/territory data — reuse the existing US name + code maps.

## Approach

- New exported `ParseLocationOptions { allowBareStateProvince?: boolean }`.
  - Signature is intentionally generic (`StateProvince`) so a later spec can
    extend the opt-in to Canadian provinces / other subdivisions without another
    signature change. This spec ships **US-only** behaviour (the shared maps are
    US-only today).
- `parseLocationText(raw, options?)` and `parseLocationList(rawLocations,
  options?)` gain the optional parameter; `parseLocationList` forwards `options`
  to `parseLocationText`.
- The bare-state branch runs **only** when `options.allowBareStateProvince` is
  true **and** the (qualifier-stripped) geographic text contains no comma — i.e.
  strictly after the existing `City, ST` path, so that path is untouched. It
  calls `normalizeUsState()`; on a hit it returns `{ state: CODE }` (no city),
  otherwise it falls through to today's `city` fallback.

## Contract

```ts
export interface ParseLocationOptions {
  allowBareStateProvince?: boolean; // default false
}

// default (flag off) — unchanged:
parseLocationText('Virginia').location            // → { city: 'Virginia' }
parseLocationList(['Virginia']).location          // → { city: 'Virginia' }

// opt-in (flag on):
parseLocationText('Virginia', { allowBareStateProvince: true }).location
  // → { state: 'VA' }   (displayLocation() === 'VA')
parseLocationText('VA', { allowBareStateProvince: true }).location
  // → { state: 'VA' }
parseLocationText('Richmond, VA', { allowBareStateProvince: true }).location
  // → { city: 'Richmond', state: 'VA' }   (City, ST path wins, unchanged)
parseLocationText('Ontario', { allowBareStateProvince: true }).location
  // → { city: 'Ontario' }  (not in the US-only map → stays a city)
```

## Files

- `packages/common/src/utils/location-parser.ts`
- `packages/common/__tests__/location-parser.spec.ts`

## Non-goals

- Enabling the flag for any existing caller (this spec only adds the capability;
  Spec 5059's IperionX plugin is the first consumer, in its own PR).
- Canadian provinces / non-US subdivisions (the name reserves room; no data
  added here).
- Promoting a bare state when a city is also present, or changing the `City, ST`
  path.
- Any global/default behaviour change.

## Test plan

- Flag **off** (default): bare `"Virginia"` / `"VA"` stay `city`, `state`
  undefined — for both `parseLocationText` and `parseLocationList`.
- Flag **on**: bare name `"Virginia"` → `{ state: 'VA' }`, no city;
  `displayLocation()` === `'VA'`.
- Flag on: bare code any case (`"va"`) and multi-word name (`"Rhode Island"`) →
  correct code; `parseLocationList(['Virginia'], { … })` → state-only.
- Flag on: `City, ST` (`"Richmond, VA"`) unchanged (no regression).
- Flag on: a non-state token (`"Springfield"`), a Canadian province
  (`"Ontario"`), and a comma-bearing unsafe label are **not** promoted.
