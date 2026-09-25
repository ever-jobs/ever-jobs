# Plan 5124 — Location parser rewrite + join-then-reparse caller cleanup

| Field | Value |
|---|---|
| Spec | 5124 |
| Slug | `location-parser-rewrite` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5118, 5119, 5120, 5121, 5122, 5123 |

## Phases

### P1 — Parser rewrite (packages/common)

- `src/utils/location-parser.ts`: full rewrite keeping the public surface
  (`parseLocationText`, `parseLocationList`, `normalizeUsState`,
  `normalizeCountryOnly`, `ParseLocationOptions`, `ParsedLocationText`,
  `ParsedLocationList`). New internals:
  - `COUNTRY_ALPHA3` (71-entry explicit map), `BARE_STATE_NAME_COLLISIONS`
    (`washington|new york|georgia`), `SITE_DESCRIPTOR_RE`.
  - `normalizeCountryOnly` extended: config names + `korea`→`South Korea` +
    alpha-2 + alpha-3.
  - `isWorkplaceQualifierOnly` — strips `hybrid|remote` words then `and|or`
    via a replacer that preserves `/^[A-Z]{2}$/` tokens (Oregon `OR` etc.).
  - `affixStrip` — qualifier/dash-affix removal + edge-separator trim.
  - `parseSingleLabel` — remote-fused peel → whole-country branch (with
    `allowBareStateProvince === false` opt-out) → bare-name resolution →
    `parseCommaParts`.
  - `parseCommaParts` — leading-qualifier shift → per-part affix/dash rules
    (prefix-country, suffix-country, suffix-qualifier, last-part site-name)
    → tail-country dedupe → blob join → 2-part and 1-part branches.
  - `tryWordSplit` — exec-loop tokenizer on `\s+(&|/|and|or)\s+` skipping
    ALL-CAPS 2-letter tokens; soft bare-city validation gated to `&`/`/`.
  - `tryCommaGroupSplit` — width-3/width-2 grouping, pair requires recognized
    state or country.
  - `parseLocationList` — per-entry emit (word-split → group-split →
    single-label), bare-city collapse against structured entries, literal-only
    `commonCountry` (implied vetoes only), merged blob from
    `item.blob ?? item.label`, singleton passthrough.
  - `parseLocationText` — delegates to `parseLocationList([normalized])` so a
    single label gets the full pipeline.
- `__tests__/location-parser.spec.ts` — rewritten suite (27 cases) encoding
  the approved outputs.

### P2 — Caller rewiring (17 plugins)

Three shapes of fix, all ending in structured `LocationDto`/`locations[]`:

1. **Array→blob joiners** (`google`, `ibm`, `meta`, `talroo`, `reliefweb`):
   pass the wire array to `parseLocationList` instead of `join(', ')`; emit
   `location` + `locations`.
2. **Field→join→reparse** (`submit4jobs`, `canekast`, `builtin`,
   `successfactors` ×3): build `LocationDto` from the fields directly; flat
   scraped text goes to `parseLocationText`; emit `locations` singleton.
3. **Family normalizers + hand-rolled splitters** (`mokahr`, `beesite`,
   `beisen`, `isolved`, `solides`, `jobvite`, `workingnomads`, `glassdoor`):
   replace private `split(',')` bodies with the shared parser; thread a new
   `locationEntries` triple array through the normalized-job types
   (`MokaHrJob`, `BeeSiteJob`, `BeisenJob`) so `locations[]` carries one
   entry per wire-site; singleton `locations` fallback elsewhere.

### P3 — Docs + validation

- Spec/plan/tasks (this dir), `docs/index.md` row, `docs/log.md` entry.
- Jest: touched suites + `packages/common`; `npm run build`; no lint config
  exists in-repo (jest + tsc are the gates).

## Risks

- Merged `location.city` blobs change shape for multi-site labels (now
  geo-only, verbatim) — acceptable: the field is back-compat and consumers
  re-parse it; the blob is *more* regular now.
- Bare-state resolution defaults on — a caller that stored bare-name cities
  sees `state` now; `allowBareStateProvince: false` preserves the old read.
- `'China'` etc. correctly moves from `state` to `country` (literal rule) —
  one fixture expectation updated.
