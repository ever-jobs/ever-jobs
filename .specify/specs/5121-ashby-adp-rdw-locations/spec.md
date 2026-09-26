# Spec 5121 — Structured per-site locations for Ashby, ADP, RDW; `postalCode`/`streetAddress`; canonical-schema mirror

| Field | Value |
|---|---|
| Spec | 5121 |
| Slug | `ashby-adp-rdw-locations` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-15 |
| Last updated | 2026-09-15 |
| Related specs | 5119 (`rippling-structured-locations`), 5120 (`location-text-and-per-site-locations`) |

## Problem

Three plugins still lose per-site location structure, each differently:

- `source-ats-ashby`: `postalAddressLabel` joins `address.postalAddress`
  (`locality, region, country`) into a text label and hands it to
  `parseLocationList`, which must re-split its own composition; and a
  free-text `location` field plus structured `address` are treated as
  alternatives rather than complementary evidence. A corpus pass over cached
  public board payloads (39 boards, 1789 postings, 2035 location entries)
  showed both are normally present (2008 entries carry both), postal fields
  disagree with the text in ~4% (same-metro synonyms like
  `Bellevue, WA`/`Seattle`, encoding variants, `addressLocality` holding a
  street address like `"2889 W. 5th ST"`), and remote-tagged postings carry
  the office address in `postalAddress` — real data worth keeping, not a
  conflict to resolve by precedence.
- `source-ats-adp`: `requisitionLocations[]` entries carry
  `address.cityName`/`countrySubdivisionLevel1.codeValue`/`countryCode`, but
  the plugin joins them into `City, ST` text and re-parses it.
- `source-company-rdw`: JSON-LD `jobLocation` is an array, but only
  `ld.locations[0]` is read; the card `locationText` path passes a single
  label and never emits `locations`.
- `canonical-job.schema.ts` `RawJobSchema.location` predates Specs
  5119–5120: it knows only `city`/`state`/`country`, so `locations[]`,
  `text` and `name` are dropped at that boundary.

## Scope

- `packages/models`: add `LocationDto.postalCode` and
  `LocationDto.streetAddress` (optional, additive — postal fields several
  sources already carry; e.g. Ashby `postalAddress.postalCode`,
  JSON-LD `postalCode`). `displayLocation()` unchanged.
- `canonical-job.schema.ts`: extend `RawJobSchema.location` with
  `name`/`text`/`postalCode`/`streetAddress` and add optional
  `locations: LocationObject[]` mirroring `JobPostDto.locations`.
- `source-ats-ashby`: map each site structurally —
  - geography (`city`, `state`, `country`) from `postalAddress`
    (`addressRegion` via `normalizeUsState`, non-US regions kept verbatim;
    `addressCountry` trimmed verbatim);
  - `postalCode`, `streetAddress` mapped through;
  - guard: an `addressLocality` containing digits is a street, not a city —
    it lands in `streetAddress` and `city` comes from parsing `location`;
  - `text` = the `location` string verbatim;
  - `name` = `text` when the label carries a site-name keyword
    (hq/headquarters/office/campus/ranch/lab/studio/facility/site/plant/
    warehouse/factory) — e.g. `Robot Ranch (Austin,TX)`,
    `San Francisco Office`, `Swarm Aero HQ`;
  - when no `postalAddress` exists, the label still goes through
    `parseLocationList` as today (so `city` is filled from text and `text`
    is verbatim);
  - `secondaryLocations[]` entries become `locations[]` entries;
  - the merged `location`, `isRemote` and `workFromHomeType` are computed
    exactly as today (via `parseLocationList` over per-site labels), so
    existing output is unchanged; nothing is suppressed for remote postings —
    the office geography stays on the entry.
- `source-ats-adp`: `requisitionLocations[]` entries map directly to
  `LocationDto`s (`cityName` → `city`, `countrySubdivisionLevel1.codeValue` →
  `state`, `countryCode` → `country`, `nameCode.shortName` → `text`); entries
  without an address still go through the parser. Merged `location` unchanged.
- `source-company-rdw`: map every `ld.locations[]` entry (not just `[0]`) to
  `locations[]`; the `card.locationText` path emits `parsed.locations`.

## Non-goals

- `parseLocationList`'s US-only `commonCountry` derivation is unchanged.
- No entity-vs-city heuristics on free text (a subsidiary name like
  `"Acme, Inc."` is indistinguishable from a place label in Ashby's free-text
  `location`; `text` preserves it verbatim either way).
- `source-ats-greenhouse`'s packed-entry split and `offices` channel remain a
  separate spec.
- Serial markers (`"Tulsa, OK - US (1)"`) are kept verbatim in `text`; the
  `(N)` suffix is not treated as geography.

## Contracts

Ashby examples (from the cached corpus):

| wire `location` | `postalAddress` | output `locations[]` entry |
|---|---|---|
| `Bellevue, WA - US` | `Seattle/WA/United States` | `{city:"Seattle",state:"WA",country:"United States",text:"Bellevue, WA - US"}` |
| `remote` | `San Francisco/California/United States` | `{city:"San Francisco",state:"CA",country:"United States",text:"remote"}` (+ `isRemote`/`Remote`) |
| `Oxnard` | `locality:"2889 W. 5th ST", postalCode:93030, California, United States` | `{city:"Oxnard",state:"CA",country:"United States",streetAddress:"2889 W. 5th ST",postalCode:"93030",text:"Oxnard"}` |
| `Swarm Aero HQ` | `Oxnard/California/United States` | `{name:"Swarm Aero HQ",city:"Oxnard",state:"CA",country:"United States",text:"Swarm Aero HQ"}` |
| `Austin, TX` | *(none)* | `{city:"Austin",state:"TX",text:"Austin, TX"}` |

## Test plan

- Ashby: per-site postal mapping incl. secondary entries; remote+postal keeps
  geography; digit-locality → `streetAddress` + text-parsed `city`; name
  keyword cases; no-postal fallback path; `locations[]` emitted.
- ADP: structured entries + `text` from `shortName`; no-address entry falls
  back through the parser.
- RDW: multi-entry `ld.locations[]` → `locations[]`; card-text path unchanged.
- Schema: `RawJobSchema` accepts `locations`/`text`/`name`/`postalCode`/
  `streetAddress`.
- Existing suites unchanged (merged `location` output preserved).
