# Plan 5126 — Structured wire location entries emitted as per-site `locations[]`

| Field | Value |
|---|---|
| Spec | 5126 |
| Slug | `structured-location-entries` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5124, 5125 |

## Phases

### P1 — Audit (done)

Each deferred plugin reads `[0]`/first from a structured multi-site wire field:
`bizneo`/`exacthire`/`hreasily`/`inrecruiting`/`pcrecruiter`/`prescreen` JSON-LD
`jobLocation` Place[]; `cornerstone` `requisition.locations[]`;
`eightfold` `standardizedLocations`/`locations`; `icims` `|`/`;`-separated card
cells; `jsonld` `posting.locations`; `altamira` single `locationText`
(singleton — emit `[location]`).

### P2 — Rewire per plugin

Two shapes, matching the Spec-5124 pattern:

1. **Triple threading** (`bizneo`, `exacthire`, `hreasily`, `icims`,
   `inrecruiting`, `pcrecruiter`): a `locationEntries?: {city,state,country,
   streetAddress?,postalCode?}[]` field is added to the normalized-job type;
   the board-normalize step fills it with one triple per wire entry;
   `extractLocations()` prefers it and falls back to `[merged]`.
2. **Direct mapping** (`altamira`, `cornerstone`, `eightfold`, `prescreen`,
   `jsonld`): the extractor itself maps the wire array to `LocationDto[]`
   inline; DTO emits `location: entries[0] ?? merged` + `locations`.

Free-text label fallbacks (card labels, display strings, listing locations)
all delegate to `parseLocationText`. Bespoke **wire-order** parsers stay:
`altamira` slug-tail `Country-Region-City`, `icims` `CC-ST-City` cells,
`eightfold` `"Country, State, City"` entry strings — the order is the wire
format, not a display label.

### P3 — Tests + docs

One `locations.spec.ts` per package covering multi-entry emit, singleton, and
label fallback; re-run all 11 suites; spec/index/log per ceremony.

## Risks

- `location` must keep its exact prior value (first entry / merged) — asserted
  by the existing suites.
- `LocationDto` already supports `streetAddress`/`postalCode` (Spec 5121) —
  carried through for `inrecruiting`/`pcrecruiter`.
