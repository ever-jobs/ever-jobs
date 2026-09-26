# Plan 5125 — Positional location-label parsers swapped onto the shared parser

| Field | Value |
|---|---|
| Spec | 5125 |
| Slug | `positional-location-parsers` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5124 |

## Phases

### P1 — Inventory and classification

Audit every plugin with a private `split()`/`parts[i]` location parser and
classify it:

- **Swap** — positional label→`LocationDto` helper: replace with the shared
  parser, emit `locations[]` (59 plugins, listed in tasks).
- **Defer** — label parse coexists with structured multi-site wire data
  (group-3 follow-up) or by-design exception: `altamira`, `bizneo`,
  `cornerstone`, `eightfold`, `exacthire`, `hreasily`, `icims`,
  `inrecruiting`, `pcrecruiter`, `prescreen`, `jsonld`.
- **Leave** — `split()` feeding a non-location field (title format, keyword
  composites, URL segments, department strings) is untouched.

### P2 — Rewiring shapes

1. **Straight swap** (majority): `parseLocationText(label).location` replaces
   the private positional body; DTO gains `location` +
   `...(location ? { locations: [location] } : {})`.
2. **Label arrays** (`microsoft`, `nvidia`, `zoom`, `themuse`, `solidjobs`):
   `parseLocationList(names)` → merged `location` + `locations` list.
3. **Tuple helpers** (`authenticjobs`, `umantis`, `trackerrms`, `androidjobs`,
   `devopsjobs`): signature kept (input filters / normalized-job triples),
   body delegates to `parseLocationText`.
4. **Prose-regex** (`harri`, `workstream`): address-regex match →
   `parseLocationText`; inferred `country:'US'`/`'GB'` stamps dropped.
5. **Country stamps**: `amazon` `?? 'US'` removed; `argospace`/`thinkorbital`
   `Country.USA` + `US_STATE_ABBREVIATIONS` map removed; `bdjobs`/`naukri`
   keep board-level `Country.*` fallbacks.
6. **Greeting**: Korean-country/remote token pre-checks retained; geographic
   remainder → `parseLocationText`.

### P3 — Validation + docs

- jest across the 59 touched plugin packages; `tsc --noEmit` (full base
  tsconfig) clean; no eslint config exists — jest + tsc are the gates.
- Spec dir + `docs/index.md` row + `docs/log.md` entry; conventional commits;
  PR to `develop` off `origin/develop`.

## Risks

- `location.city` values change for labels the positional parser mis-split —
  that is the intended fix; `text` keeps provenance.
- `locations[]` is additive; consumers ignoring it are unaffected.
- Removed `USA`/`US` stamps: two fixture expectations updated; downstream
  filtering on inferred `USA` country would see `null` — per approved
  literal-country semantics (Spec 5124).
