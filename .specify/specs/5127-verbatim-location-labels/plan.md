# Plan 5127 — Verbatim-label plugins emit parsed `location` + `locations[]`

| Field | Value |
|---|---|
| Spec | 5127 |
| Slug | `verbatim-location-labels` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5124, 5125, 5126 |

## Phases

### P1 — Classify (done)

Audit of all `*.service.ts` location emits: 936 files emit
`new LocationDto({city: <label>})` with no parse call. Breakdown: ~844 in the
dominant const-assigned template (`const locationStr = <label>; … ? new
LocationDto({city: locationStr}) : null`), ~72 helper-emit structured triples
(`{city,state,country}` literals — need only the `locations: [location]`
singleton emit), ~30 inline-conditional/manual shapes, ~15 empty-`{}`
placeholders (out of scope), `city:'Remote'` fallbacks and structured city
passthroughs (out of scope).

### P2 — Mechanical transform (done)

A one-off codemod (kept out of the repo, run locally) applied two transforms:

1. `const X = COND ? new LocationDto({city:EXPR}) : null;` →
   `const XParsed = parseLocationList([EXPR]);` +
   `const X = COND ? XParsed.location : null;`; the DTO literal gains
   `...(XParsed.locations.length > 0 ? { locations: XParsed.locations } : {})`
   after the `location` prop; `isRemote` becomes
   `(OLD) || XParsed.remoteMentioned` — old expr parenthesised (bare
   `??`/`||` mixing is a SyntaxError); `parseLocationList` merged into the
   `@ever-jobs/common` import (alphabetical).
2. Helper-emit structured literals: hoist `const location` ahead of the DTO
   literal and emit `locations: [location]` when non-null.

### P3 — Manual pass (done)

Files whose shape defeated the template: `wellfound` (whole wire array —
only file that indexed `[0]` into a `locations[]` wire field), `dvinci`
(`extractLocations(opening)` maps all wire entries via `fromStructured`),
`dice`/`dribbble` (API + card paths), `monster` (both paths; structured
city+stateProvince direct emit — no round-trip), `techcareers`,
`careerbuilder`, `coroflot`, `jobsdb`, `stepstone`. Label-fallback helpers
in `beetween`, `talentsoft`, `zimyo`, `darwinbox`, `talentadore`,
`talentreef`, `pinpoint` → `parseLocationText`.

### P4 — Spec expectations (done)

Generated happy-path specs pinned the old whole-label `city`. Updated
mechanically from HEAD with the real parser computing expectations:
literal `toBe('LABEL')` → parsed-city literal or `toBeUndefined()`;
`toBe(<wire>.location.name)` → `toBe(parseLocationText(<wire>.location.name).location?.city)`;
`toContain('Remote')` on a remote-prefixed label → parsed-city assert.
The pin still verifies the plugin routes the wire label through the shared
parser end-to-end.

### P5 — Gates + ceremony

`npx tsc --noEmit -p tsconfig.base.json`, all 819 touched `__tests__`
suites, `npm run lint:docs`, `npm run build`; spec/index/log; PR to
`develop`; CI green.

## Risks

- `location` for a single label is now the parsed structured DTO — the
  sanctioned Spec-5124 contract; generated spec expectations updated.
- `??`/`||` mixing and `LocationDto` import drift — covered by tsc.
- ~35 residual edge shapes still under-verified locally; CI's
  source-scraper shards are the real gate.
