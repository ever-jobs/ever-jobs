# Spec 5127 — Verbatim-label plugins emit parsed `location` + `locations[]`

| Field | Value |
|---|---|
| Spec | 5127 |
| Slug | `verbatim-location-labels` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5124 (shared `parseLocationText`/`parseLocationList`), 5125 (positional-parser swap), 5126 (structured wire entries) |

## Problem statement

The last class of under-parsed location emitters: **919 plugin services**
emit `location: new LocationDto({ city: <label> })` where `<label>` is the
verbatim wire/scraped string — `display_name`, `location.name`, a card cell,
an RSS item field. No parse at all: no remote detection, no state/country
resolution, no `locations[]`. A label like `'Oakland, CA'` lands whole in
`city`; `'Remote - Colombia'` becomes a city; `'Austin, TX; Denver, CO'`
collapses into a single `city` blob.

These plugins are uniform — a generated template produced the same
`const locationStr = <label>; … location: locationStr ? new LocationDto({city: locationStr}) : null`
shape — so the fix is a single mechanical swap onto the shared Spec-5124
parser at the lowest level, plus a small manual pass for files whose shape
didn't match the dominant template.

## Scope

Every plugin that emits a verbatim label through `new LocationDto({ city })`
with no parse call is rewired:

- **Const-assigned label** (dominant generated shape, ~840 files):
  `const locationParsed = parseLocationList([<labelExpr>]);` then
  `location: <cond> ? locationParsed.location : null` and
  `...(locationParsed.locations.length > 0 ? { locations: locationParsed.locations } : {})`
  after the `location` prop. `isRemote` OR-merges the previous expression
  with `locationParsed.remoteMentioned`.
- **Helper-emit structured literals** (~72 files): `const location =
  this.extract<Loc>(job)` hoisted ahead of the DTO literal, emitting
  `locations: [location]` when non-null — these build
  `{city,state,country}` triples from wire fields, so no parse call is
  needed; only the `locations[]` emit is new.
- **Label-fallback helpers** (`beetween`, `talentsoft`, `zimyo`,
  `darwinbox`, `talentadore`, `talentreef`, `pinpoint`) — their
  `extractLocation` helpers return the raw label via
  `parseLocationText(raw).location`.
- **Manual rewires** (10 files whose shape didn't fit the generated
  template): `wellfound` feeds the whole `listing.locations` wire array to
  `parseLocationList`; `dvinci` maps every `opening.locations[]` entry
  structurally via `extractLocations()`; `dice`, `dribbble`, `monster`,
  `techcareers`, `careerbuilder`, `coroflot`, `jobsdb`, `stepstone` each
  route their API and/or card label through `parseLocationList` and emit
  `locations[]` conditionally. `monster`'s
  `\`${city}, ${stateProvince}\`` composition is replaced by a direct
  structured emit — no compose-then-reparse.

Spec-file expectations that pinned the old verbatim-city shape are updated:
literal `location?.city` asserts now pin the parsed city (or
`toBeUndefined()` for qualifier labels), and template asserts of the form
`toBe(<wire>.location.name)` become `toBe(parseLocationText(<wire>.location.name).location?.city)`
— still end-to-end: it verifies the plugin pipes the wire label through the
shared parser.

## Non-goals

- Empty `new LocationDto({})` placeholders (~15 plugins emit no location
  data at all: `upwork`, `vuejobs`, `conservationjobs`, `crunchboard`,
  `drupaljobs`, `elixirjobs`, `golangjobs`, `iosdevjobs`, `pyjobs`,
  `pythonjobs`, `railsjobs`, `realworkfromanywhere`, `wordpressjobs`,
  `exa`) — unchanged, nothing to parse.
- `city:'Remote'` fallback emits (`trossenrobotics`) and structured
  city-field passthroughs (`varbi` `town`, `webcruiter` `Workplace3`,
  `oorwin` `city ?? null`, `paylocity` `city ?? (isRemote ? 'Remote' : null)`)
  — already structured or placeholder, not labels.
- The 61 structured `{city,state,country}` emitters that gained only the
  `locations: [location]` singleton emit keep their literals — no parse
  call needed for already-structured triples.
- Parser feature changes — callsite rewiring only.

## Contracts

- `location` = `locationParsed.location` (parsed merged DTO). For a single
  label the merged `city` is the parsed city part — e.g. `'Oakland, CA'` →
  `{city:'Oakland', state:'CA'}`. Pure-qualifier labels (`'Remote'`,
  `'Hybrid - X'`) are consumed by `isRemote`/`workFromHomeType` and no
  longer mint a `city`.
- `locations[]` = `locationParsed.locations`, emitted only when non-empty.
- `isRemote` = previous expression OR `locationParsed.remoteMentioned`
  (parenthesised to keep `??`/`||` legal).
- `country` fields stay literal-only end to end.

## Test plan

- Every `__tests__` suite under the 919 touched packages re-run (819 spec
  files): generated happy-path specs updated to the parsed-shape contract.
- `npx tsc --noEmit -p tsconfig.base.json`, `npm run lint:docs`,
  `npm run build` clean.
- CI green.
