# Spec: 5172 — jsonld-joblocation-mapper

| Field | Value |
| --- | --- |
| Spec ID | 5172 |
| Slug | jsonld-joblocation-mapper |
| Status | draft |
| Owner | agent |
| Created | 2026-10-09 |

## Problem

The surveyed plugins embed their own `application/ld+json` extractor and
hand-map the schema.org `jobLocation` Place to `LocationDto` — the same
`addressLocality` / `addressRegion` / `addressCountry` / `postalCode` /
`streetAddress` vocabulary the spec-5171 mapper already covers. Each
hand-rolled reader drops whatever it didn't name (Place-level `name`,
`streetAddress`, `postalCode`, `addressCountry` object forms, extra Places
beyond `[0]`) and duplicates the same first-Place/first-address logic.

## Scope

Mechanical adoption of `toLocationDtos` in the plugins whose extractor
yields a schema.org `jobLocation` (Place or Place[]):

akkencloud, arcoro, bizneo, brassring, careerplug, cezanne, concludis,
exacthire, expr3ss, hireful, hreasily, hron, inrecruiting, jobtrain, keka,
mindscope, namely, otys, pageup, paychex, pcrecruiter, peoplestrong,
prescreen, rexx, scouttalent, snaphunt, taleez, vivahr, workforce (29).

Surveyed but out of scope (no structured `jobLocation` branch exists to
replace — adoption would be a new data source, not a mechanical swap):
isolved (location comes from the jobs API `city`/`abbreviation`/`iso3`
fields), stepstone (location is parsed from DOM text via
`parseLocationList`).

Per plugin:

- Call `toLocationDtos(jobLocation)` on the plugin's own `jobLocation` value
  (the Place or Place[] — **not** the inner `address`; Place-level `name` and
  `address[]` expansion need the whole Place).
- `location` = first mapped result (`toLocationDto` / `dtos[0] ?? null`).
- `locations[]` = all mapped results **only where the plugin already emits a
  per-site list** (bizneo, exacthire, hreasily, inrecruiting, pcrecruiter,
  prescreen). Plugins emitting `locations: [location]` keep the single-element
  form. Plugins emitting no `locations[]` keep emitting none — filling it
  would shift `dedupKey` for every multi-site job (Spec 5123); that is a
  per-plugin correction with a release note, not this PR.
- Replace only the structured-address branch. Plugin-side fallbacks survive
  verbatim: pageup's `?? decodeMaybe(labelLocation)`, brassring's `?? job.city`,
  careerplug/snaphunt's `applicantLocationRequirement(s)` country, peoplestrong's
  `item.city`/`item.location`, any `og:`/`<title>`/listing-text chains.

## Non-goals

- No parser rewrite: each plugin keeps its own `extractJobPostingLd`; we do
  **not** switch them to shared `parseJobPostingLd` (that would change
  title/company/date/employmentType too and drop Place `name`/`streetAddress`/
  `extras` via the `JobPostingLdLocation` adapter).
- No `locations[]` additions where none exist today; no `dedupKey` changes.
- No remote-detection changes; `jobLocationType` handling untouched.
- JSON-API plugins with schema-ish fields (ashby, softgarden, successfactors,
  talentreef) are a separate cohort; string-location plugins (aurora_tech)
  out of scope.
- No test changes: each plugin's existing tests must pass unmodified.

## Contract

- Input: the plugin's `jobLocation` (Place | Place[] | null/undefined).
- Output: `LocationDto[]` via `toLocationDtos`; `location` = `dtos[0] ?? null`.
- The mapper auto-descends `address`/`postalAddress`, expands `address[]`
  into per-site entries, maps `name` → `name`, and carry-all `extras`
  preserves unclaimed fields (`@type`, `geo`, ids).

## Test plan

- `npx jest` per touched plugin spec — all existing assertions green with no
  test edits.
- `npx tsc -b` clean; `npm run lint:docs` clean.

## Acceptance criteria

- All 29 in-scope plugins route `jobLocation` through `toLocationDtos`.
- No plugin's emitted `location`/`locations` shape changes in a way that
  alters `dedupKey` (no newly-populated `locations[]`).
- Every pre-existing fallback chain still executes when the mapper yields `[]`.
- Zero test modifications.
