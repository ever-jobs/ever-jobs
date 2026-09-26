# Spec 5118 — Posting-level `countryCode` on `JobPostDto`; remove per-posting country overlays in Lever and Workday

| Field | Value |
|---|---|
| Spec | 5118 |
| Slug | `ats-posting-country-code` |
| Status | implemented |
| Owner | devin |
| Created | 2026-09-14 |
| Last updated | 2026-09-14 |
| Related specs | 5010 (`lever-field-mappings`), 5013 (`workday-field-mappings`) |

## Problem

Specs 5010/5013 added an identical `applyCountry` helper to the Lever and
Workday plugins: fold the ATS's ISO-3166 alpha-2 country code into
`LocationDto.country` when the parser left it bare. The fold-in asserts a
geographic claim the location data never made:

- The overlay stamps a **posting-level** field onto `parsedLocations.location`,
  which is the *merged* DTO for all advertised sites — `city` becomes
  `"A; B"` when `allLocations`/`additionalLocations` carry several sites. A
  single posting-level code cannot describe every site; e.g. Lever
  `allLocations: ["Amsterdam", "Berlin"]` + `country: "NL"` produced
  `{city: "Amsterdam; Berlin", country: "Netherlands"}`.
- Lever's `country` is a flat posting field not bound to any specific
  `categories.location`/`allLocations` entry, so it is unverifiable against
  the advertised sites. Workday's `jobRequisitionLocation.country.alpha2Code`
  is the *requisition* location's country — a bookkeeping attribute that can
  legitimately diverge from the advertised `jobPostingInfo.location` (a role
  requisitioned to HQ but posted in a regional office).
- When no labels parsed at all, the helper fabricated a country-only
  `LocationDto` — a location claim built purely from a posting-level field.

The codes themselves are real signal (~15 distinct codes across harvested
Lever boards; `alpha2Code` + `descriptor` + `id` on Workday), so rather than
dropping them they are surfaced at the level they actually describe: the
posting.

## Scope

- Add `countryCode?: string | null` to `JobPostDto`: the ISO-3166 alpha-2
  country the ATS declared for the posting, emitted verbatim (raw code, no
  `Intl.DisplayNames` name resolution). Distinct semantics from
  `location.country` (label-derived, English display names).
- `source-ats-lever`: delete `applyCountry`; emit `parsedLocations.location`
  verbatim for `location`; populate `countryCode: job.country ?? null`.
- `source-ats-workday`: delete `applyCountry`; populate
  `countryCode: jobPostingInfo.jobRequisitionLocation.country.alpha2Code ?? null`.

## Non-goals

- No per-location country on multi-site postings — the singular
  `JobPostDto.location` cannot express it (would need a `locations` array).
- Other ATS plugins unchanged. Structured, location-scoped country fields
  (e.g. per-entry `countryCode` inside a locations array, postal-address
  `addressCountry`) remain a separate, honest data source handled per plugin.
- No normalization of `countryCode` — unassigned codes pass through verbatim;
  correctness of the declaration is the ATS's responsibility.

## Contracts

| Input | `location.country` | `countryCode` |
|---|---|---|
| Lever `location: "Amsterdam"`, `country: "NL"` | unset | `"NL"` |
| Lever `allLocations: ["Amsterdam","Berlin"]`, `country: "NL"` | unset | `"NL"` |
| Lever `country: "QZ"` (unassigned) | unset | `"QZ"` |
| Workday `alpha2Code: "US"`, `location: "Rockville, MD"` | unset | `"US"` |
| Workday no `jobRequisitionLocation` | — | `null` |

## Test plan

- Lever: `countryCode` populated verbatim for resolvable (`NL`) and
  unresolvable (`QZ`) codes; `location.country` never set from the ATS field.
- Workday: `countryCode` from `alpha2Code`; `null` when absent; existing
  multi-location split and country-absent behavior unchanged.
