# Spec: 5171 — location-object-mapper

| Field | Value |
| --- | --- |
| Spec ID | 5171 |
| Slug | location-object-mapper |
| Status | draft |
| Owner | agent |
| Created | 2026-10-09 |

## Problem

Structured location *objects* have no shared mapping path: ~241 plugin files
hand-construct `LocationDto` and ~126 carry a named mapper, each with a
partial alias table — fields the author didn't name silently drop (Dayforce:
geo feed emits `cityName`/`isoCountryCode`/`formattedAddress`; only
`stateCode` was mapped, so city/country/address vanished). There is also no
catch-all: fields with no DTO slot (`coordinates`, `locationId`, …) are lost.

## Scope

- `toLocationDtos(input, opts?)` / `toLocationDto(input, opts?)` in
  `@ever-jobs/common` — runtime-key mapping of location objects/strings/arrays
  to `LocationDto`; no dependency on feed type declarations.
- `LocationDto.extras?: Record<string, unknown>` — verbatim bag for source
  fields with no DTO slot; informational only (never display/dedup/canonical
  key). `OfficeDto` inherits it.
- Dayforce migration: all `postingLocations`/`PostingLocations` → `locations[]`,
  primary `location` = first usable; flat-field fallback preserved.
- Shared JSON-LD migration: `mapLocations` in `jsonld.ts` reuses the mapper
  internally, preserving the `JobPostingLdLocation` adapter contract
  (`state`→`region`, label join, address-array expansion, postal-only results).

## Non-goals

- No changes to `displayLocation()`, `formatJobLocation()`, or canonical-key
  logic; no new remote/workplace behavior.
- No ledger/reporting APIs, no posting-level extras, no `areaHierarchy`.
- Other plugins adopt later; migration is opportunistic, not a flag day.

## API and inputs

- `toLocationDtos(input: unknown, opts?) → LocationDto[]` — accepts a location
  object, string, or array; reads runtime own-data keys only (no getters, no
  inherited fields, no input mutation). Skips unusable entries; keeps usable
  ones in source order; dedupes exact-mapped duplicates (fields + extras).
- `toLocationDto(input, opts?) → LocationDto | null` — first usable plural
  result or `null` (`[null, {}, {city:'Berlin'}]` → Berlin).
- A usable result needs meaningful `name`/`text`/`city`/`state`/`country`/
  `streetAddress`/`postalCode`; street-only and postal-only survive;
  extras alone never create a location.
- Absent/null/empty/whitespace values are no value; numeric zero survives.

## Selection (`opts.in`)

- `opts.in`: one dotted selector path or ordered fallback paths
  (e.g. `['postingLocations','PostingLocations']`); first path yielding ≥1
  usable location wins; every selector failing → `[]`/`null`. The whole
  posting is NEVER mapped as fallback — siblings must not merge
  (`{location:{city:'Paris'}, office:{country:'US'}}` ≠ "Paris, US").
- Wrappers (`jobLocation`, `location`, `office`, `geo`, `locations`) require
  direct input or `opts.in` — no arbitrary container search.
- Within a selected location only `address`/`postalAddress` auto-descend:
  root slots win, address fills missing slots, conflicting address values go
  to extras; `address` then `postalAddress`; address arrays expand to
  separate locations (Place-level name/extras copied, geography never
  merged); a string `address` supplies `streetAddress` only.
- Bounds: 8 selector segments, 1 auto address edge, 4 nested array levels;
  cycles skipped.

## Alias membership (case-insensitive, every dotted segment)

- `city`: `city`, `addressLocality`, `locality`, `town`, `cityName`,
  `municipal`, `municipality`, `city_name`, `municipality_name`, `ort`.
- `state`: `state`, `addressRegion`, `province`, `stateName`, `state_name`,
  `stateCode`, `stateProvince`, `state_province`, `subdivision`,
  `subdivisionFullName`, `countrySubdivisionLevel1.codeValue`,
  `CountrySubDivisionCode`.
- `country`: `country`, `addressCountry`, `countryName`, `countryCode`,
  `country_code`, `country_name`, `isoCountryCode`, `isoCountry`, `land`.
- `postalCode`: `postalCode`, `postal`, `zip`, `postal_code`, `postcode`,
  `zip_code`, `zipCode`, `plz`, `codePostal`.
- `streetAddress`: `streetAddress`, `street`, `addressLine1`,
  `street_address`, `address_line1`, `addressLine`, `address1`, `line1`.
- `name`: `name` only — the source's entity/site label.
- `text`: `text`, `locationText`, `locationStr`, `location_string`,
  `formatted`, `formattedAddress`, `fullLocation`, `locationLabel`,
  `display_name`, `locationName`, `libelle` — the source's geographic label
  (`locationName`/`libelle` observed as geo labels in fixtures).
- Ambiguous label keys carry no default slot — `officeName`, `siteName`,
  `displayName`, `descriptor`, `label`, `title` → extras (`officeName`
  proven ambiguous: "The Hive" vs "El Segundo" fixture values); feeds
  declare `nameKeys`/`textKeys` when semantics are known.
- `region`, `county`, `area` are excluded from defaults (US county ≠ state;
  EMEA/APAC regions aren't states) → extras unless a plugin overrides.
- `formattedAddress` maps only to `text`; a verified street-only feed may
  override into `streetAddress` via `aliases`.

## Options

- `aliases`: add case-insensitive dotted paths per slot.
- `nameKeys`/`textKeys`: add paths to the label sets; explicit assignment
  removes the path from other sets; assigning one path to two slots (incl.
  casing overlaps) is a config error.
- `prefer`: one preferred source path per slot (must already belong to the
  slot's alias set or supported object leaves); used only to resolve genuine
  conflicts — e.g. `{prefer:{state:'subdivisionFullName'}}` keeps the richer
  name over the code.
- `extrasLimits`: `{maxBytes?; maxDepth?; maxNodes?}` — defaults 4096
  serialized UTF-8 bytes, depth 3 (extras root = 1), 2000 examined
  properties/array entries; raise only for verified larger payloads.
- `parseTextFallback` (object input, default false): parse the selected
  `text` with caller-supplied `ParseLocationOptions`; fills only missing
  structured slots, never overwrites or resolves conflicts; if any
  overlapping inferred field conflicts, all inferred fields are rejected.
  Direct string input is trusted location text → per-site results from
  `parseLocationList([input])`, each input parsed separately, original kept
  as `text`, `Remote` labels preserved verbatim.

## Coercion and object-valued fields

- Strings accepted for every slot; finite numbers only for `postalCode`
  (`0`→`'0'`); booleans/non-finite rejected → extras.
- Trim structured slots and `name`; preserve selected `text` verbatim.
- Object-valued alias → leaf candidates, no subfield priority:
  `country`: `.alpha2Code`/`.name`/`.descriptor`/`.code`;
  `city`/`state`: `.name`/`.descriptor` (`.code` needs explicit dotted
  alias); other slots scalar-only. `.id` is never geography.

## Agreement, conflicts, stored representation

- Collect all usable slot candidates; group by comparison value:
  `country` via `canonicalCountryName({isoCountryNames:true})` (NL↔
  Netherlands agree); `state` via `normalizeUsState` when country resolves
  to US or is absent (a CA↔California pair agrees WITHOUT minting US
  country; explicit non-US country disables it); other slots compare
  case-insensitively except `text` (exact). Failed normalization ≠
  agreement.
- Conflict resolution: usable explicit `prefer` path → scalar canonical
  field whose name matches the slot (`city` over `cityName`) → else the
  slot stays unset. Exact spelling breaks casing ties only for explicit
  `prefer`. Never resolve by alias or key order.
- Stored form within the agreeing group: explicit preference → scalar
  canonical field → recognized full name → lexical source-path order.
  Store the source value post-coercion; normalization is for comparison
  only. Identical copies are consumed together; alternatives/conflicts
  survive in extras.
- Examples (all must hold): `{city:'Paris',City:'Paris'}`→Paris (both
  consumed); `{city:'Paris',City:'Lyon'}`→unset city unless
  `{prefer:{city:'City'}}`→Lyon; `{city:'Paris',cityName:'Lyon'}`→Paris;
  `{town:'Paris',cityName:'Lyon'}`→unset;
  `{country:{alpha2Code:'DE',name:'Germany',id:'123'}}`→Germany +
  `extras.country`; `{stateCode:'CA',stateName:'California'}` no country→
  California; `{country:{alpha2Code:'DE',name:'France'}}`→unset.
- Extras-only DTOs are not returned.

## Extras

- Carry-all default: every unconsumed JSON-safe field within the selected
  location lands in extras (ids, coordinates, location types…).
  Consumption tracked by leaf path (`country.name` used → `country.id`/
  `country.code` still residual; do not copy a consumed subtree wholesale).
- Filters: `keep` absent → all eligible residuals; `keep:[]` → none
  (intentional exception to empty-equivalence); nonempty `keep` → listed
  dotted paths + descendants; `drop` wins over `keep`.
- Incoming `extras` flatten into output extras (never `extras.extras`);
  raw fields win key collisions; `__proto__`-style keys via safe property
  construction; cyclic/unsupported values omitted.
- Limits enforced during traversal (no pre-clone); oversize residuals
  omitted whole (no string/array truncation); omissions tracked internally
  for dedup — no reporting API.

## Collection deduplication

- Remove only exact-duplicate mapped DTOs (all mapped fields + JSON extras;
  key order ignored, array order preserved, absent/empty optional slots
  equivalent); keep first in source order.
- Never dedupe entries whose residuals were removed by filters/limits —
  equal retained fields don't prove equal sites.
- Geographic consolidation stays in job canonicalization.

## Display and key compatibility

- `displayLocation()`, `formatJobLocation()`, canonical-key logic
  unchanged. Recovered geography and extra Dayforce sites can change that
  source's keys — document in the release note. JSON-LD geography/labels
  preserved unless a fixture documents an intentional correction.

## Dayforce migration

- `postingLocations`/`PostingLocations` → `toLocationDtos` → all usable
  entries to `locations[]`; `location` = first usable.
- No array → map explicit `{city,state,country}` flat-field object.
- Keep existing `isRemote`/`TelecommutePercentage`/per-location `isRemote`
  checks. Sanitized fixture covers `cityName`/`stateCode`/`isoCountryCode`/
  `formattedAddress` + multi-site postings; assert display/key effects of
  recovered fields separately.

## JSON-LD migration

- `mapLocations` reuses the mapper; adapter contract preserved:
  `state`→`region`, `label` = joined city/region/country or `null`,
  address-array expansion, postal-only results; `addressCountry.name`
  preferred on genuine conflicts to keep existing name behavior.

## Acceptance

- All agreement/conflict examples pass; casing variants identical; forced
  name/text double-assignment rejected; empty preferred aliases don't hide
  valid candidates; numeric postal zero survives; booleans/ids never become
  geography; US equivalence with US/absent country only; entity labels stay
  names; `text` verbatim; sibling sites never merge; street/postal-only
  survive; extras-only → null; extras survive remapping + JSON round-trip,
  filters/collisions/cycles/limits covered; exact dupes collapse, distinct
  ids/omissions stay separate.
- Dayforce + JSON-LD existing tests green; new fixtures pass; `tsc`,
  `lint:docs` clean.
