# Spec 5119 — Rippling: structured per-site locations (`JobPostDto.locations`, `LocationDto.name`)

| Field | Value |
|---|---|
| Spec | 5119 |
| Slug | `rippling-structured-locations` |
| Status | implemented |
| Owner | devin |
| Created | 2026-09-14 |
| Last updated | 2026-09-14 |
| Related specs | 5118 (`ats-posting-country-code`) |

## Problem

`source-ats-rippling` flattened each structured `locations[]` entry — which
carries its own `name`, `city`, `state`/`stateCode`, `country`/`countryCode`,
and `workplaceType` — into a comma-joined label, then re-parsed that text
through `parseLocationList`. The comma-join-then-reparse round trip is lossy
in both directions:

- `loc.city ?? loc.name` substitutes the site/entity *name* for a missing city,
  so entries like a legal hiring-entity name ("X, Inc.") or an office label
  ("Downtown Office") were emitted as `city`.
- `state ?? stateCode` / `country ?? countryCode` prefer the long name, feeding
  text the parser must re-normalize.
- Non-US pairs like "Berlin, Germany" are never split into
  `city`/`country` — the parser's canonical location and country rules are
  US-only, so the entry survives as one undivided `city` string.
- Because `normalizeCountryOnly` recognizes only US tokens, a posting with a
  US site *and* a Berlin site ended with `country: "United States"` on the
  merged blob — the German site silently mislabeled.
- A `workLocations` free-text string duplicating a structured entry survives
  as a second pseudo-site (label keys differ), double-counting locations.
- `payRangeDetails[].location` (a per-band location label already paired with
  a pay range) and `payRangeDetails[].isRemote` were never used as evidence.

Separately, `JobPostDto.location` is a single `LocationDto`; the per-site
array that `parseLocationList` already produces (`ParsedLocationList.locations`)
was discarded at the DTO boundary, so multi-site data was unrepresentable.

## Scope

- `packages/models`: add `JobPostDto.locations?: LocationDto[]` (per-site
  entries; `location` stays the merged compat view) and
  `LocationDto.name?: string | null` (the source's own site/entity label —
  surfaced in `displayLocation()` only when `city` is absent).
- `packages/common`: export `normalizeUsState` from `location-parser` so
  plugins can normalize wire state names without a text round-trip.
- `source-ats-rippling` (`rippling.service.ts`):
  - `locationsFromWire(job)` maps each wire entry to a `LocationDto` from its
    own fields — `city`, `stateCode` (then `state` normalized), and
    `country` resolved from `countryCode` via `regionNameFromCode` (falling
    back to the literal `country` string). Entries with no geography and a
    `name` are kept as `{name}` entries in `locations`, unless the name is a
    remote marker (consumed as a remote signal) or equals `companyName`
    (a self-referential hiring entity — dropped).
  - `mergeSites(sites)` produces the compat `location`: `city` joins
    per-site labels (`City, ST`, or `City, Country` when no state) with
    `; `; `country` is set only when all sites share one, otherwise omitted.
    Name-only entries never enter the merged view.
  - Fallback: when no structured entry carries geography, run
    `parseLocationList` over `workLocations` plus `payRangeDetails[].location`
    labels that actually parse as a place (state-bearing); band labels like
    "Manager" are rejected.
  - `isRemote` now also treats `payRangeDetails[].isRemote === true` as a
    signal; `workFromHomeType` still prefers structured `workplaceType` with
    the parser fallback next.
  - Emit `locations` on `JobPostDto` when non-empty.
  - `department` read via the typed `{ name?: string }` field (cast removed).

## Non-goals

- Input filters (`searchTerm`, `location`, `isRemote`, `jobType`, `offset`)
  remain unimplemented — parked as Q-091 in `docs/questions.md`.
- No `countryCode` on `JobPostDto` — Rippling declares per-location codes,
  not a posting-level one.
- Other plugins unchanged; `locations[]` is available for them to populate
  in follow-up specs.

## Contracts

| Input (`locations[]`) | `location` | `locations` |
|---|---|---|
| `{city:"Brisbane",stateCode:"CA",countryCode:"US"}` | `{city:"Brisbane",state:"CA",country:"United States"}` | same entry |
| `...+{city:"Berlin",countryCode:"DE"}` | `{city:"Brisbane, CA; Berlin, Germany",country:null}` | both, own countries |
| `{name:"Remote (US)",workplaceType:"REMOTE"}` + `{city:"Denver",stateCode:"CO"}` | `{city:"Denver",state:"CO"}` + `isRemote:true` | only Denver entry |
| `{name:"<companyName>"}` (no geo) | unchanged | dropped |
| `{name:"Subsidiary, Inc."}` (no geo) | unchanged | `{name:"Subsidiary, Inc."}` |
| `locations:[]` + `workLocations:["Austin, TX"]` | `{city:"Austin",state:"TX"}` | `[{city:"Austin",state:"TX"}]` |
| `locations:[]` + band `{location:"Manager"}` | unchanged | none — label not a place |

## Test plan

- Per-site `countryCode`/`country` resolve per entry (incl. non-US); merged
  `country` omitted on disagreement.
- Remote-marker names become signals, not sites; differing entity names kept;
  `companyName` duplicates dropped.
- `workLocations` + parseable pay-band labels used only when structured
  entries are absent; non-place band labels rejected.
- Existing pagination/enrichment/compensation suites unchanged.
