# Spec: 5173 — api-location-object-adoption

| Field | Value |
| --- | --- |
| Spec ID | 5173 |
| Slug | api-location-object-adoption |
| Status | draft |
| Owner | agent |
| Created | 2026-10-09 |

## Problem

Four JSON-API plugins read structured location objects but hand-map only the
fields they named — the same per-feed key names the spec-5171 mapper already
covers or accepts via options. Each currently drops real fields:

- **gem** — reads only `posting.locations[0].name`; every additional site is
  dropped, and `locations[]` carries at most one parsed entry.
- **recruitly** — reads `cityName`/`regionName`/`countryName`/`countryCode`;
  drops `postCode`, `addressLine`, `latitude`/`longitude`.
- **arbeitsagentur** — reads `arbeitsort.ort/region/land`; drops `plz` and
  `koordinaten`.
- **cornerstone** — `locations ?? location` union handled by a bespoke
  `locationFromObject`; `displayName`/`formattedAddress` parsed only via a
  hand-rolled comma split when `city` is absent.

## Scope

Adopt `toLocationDtos`/`toLocationDto` at each plugin's structured-location
branch, exactly as surveyed:

- **gem** — `toLocationDtos(posting.locations, { textKeys: ['name'], parseTextFallback: true })`.
  `location` = first result; `locations[]` = all results (see Key changes).
  Remote checks (`firstLocation.isRemote`, name text, `job.locationType`)
  unchanged.
- **recruitly** — `toLocationDto(item.location, { aliases: { state: ['regionName'] } })`.
  The mapped DTO flows through the normalised job so `postalCode`,
  `streetAddress` and `extras` (lat/lng) survive to `LocationDto`.
- **arbeitsagentur** — `toLocationDto(entry.arbeitsort, { aliases: { state: ['region'] } })`.
  `ort`/`land`/`plz` are default aliases; `koordinaten` lands in `extras`.
  `homeOffice` → `isRemote` unchanged.
- **cornerstone** — `toLocationDtos(requisition.locations ?? requisition.location, { textKeys: ['displayName'], parseTextFallback: true })`.
  String input flows through the mapper's own string branch; the
  `displayLocation` fallback remains for the mapper-empty case.
  `detectRemote` unchanged.

Cross-cutting:

- `location` = first mapped result in every plugin.
- `locations[]` filled only where the plugin already fills it (gem is the
  sole deliberate exception — see Key changes).
- Every existing fallback chain stays; mapper-empty triggers the same path
  as missing-location today.
- No test modifications; each existing suite must pass unchanged.

## Key changes (deliberate)

- **gem** newly emits multi-site `locations[]` → `dedupKey` site set changes
  for multi-site postings (canonical-key.ts reads every `locations[]` entry).
  Accepted; a release note ships with the PR.
- **cornerstone** `displayName` is claimed into `text` and parsed by
  `parseTextFallback` instead of a positional comma split — richer parse,
  same intent; key-change tests pin the new expectations.

## Non-goals

- adp, clearcompany, hrone — deferred (bespoke dedup loops, flag-bearing
  location rows, or zero gain vs current coverage).
- No remote/`isRemote` behaviour changes beyond preserving existing checks.
- No new `locations[]` population outside gem.
- No changes to `@ever-jobs/common`, `@ever-jobs/models`, or canonical-key.

## Test plan

- Existing jest suites for all four plugins — must pass with no edits.
- New fixture coverage:
  - gem: `gem-batch-response.json` (existing fixture) — multi-site
    `locations[]` + `location` = first site.
  - recruitly: captured fixture asserting `postalCode`/`streetAddress`
    recovery and `regionName` → `state`.
  - arbeitsagentur: captured fixture asserting `plz` → `postalCode`,
    `region` → `state`, `koordinaten` in `extras`.
  - cornerstone: key-change tests pinning text parse of `displayName`.
- `npx tsc --noEmit -p tsconfig.typecheck.json`, `npm run lint:docs`.
