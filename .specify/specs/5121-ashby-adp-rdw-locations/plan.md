# Plan: 5121 — Structured per-site locations for Ashby, ADP, RDW; canonical-schema mirror

| Field | Value |
|---|---|
| Spec | 5121 |
| Slug | `ashby-adp-rdw-locations` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-15 |
| Last updated | 2026-09-15 |
| Related specs | 5119 (`rippling-structured-locations`), 5120 (`location-text-and-per-site-locations`) |

## Phases

1. **Models + schema.** `LocationDto.postalCode`/`streetAddress`; extend
   `RawJobSchema.location` and add optional `locations` array.
2. **Ashby.** `AshbyAddress.postalAddress` gains `streetAddress`/`postalCode`.
   Replace `postalAddressLabel`/`locationLabels` join-then-reparse with
   `siteLocation(label, address)`: postal geography → fields (digit-locality
   guard → `streetAddress`), site-name keyword → `name`, `text` = label
   verbatim; no-address labels still go through `parseLocationList`. Keep the
   merged `location` + remote signals computed from `parseLocationList` over
   the same labels so existing output is unchanged; emit `locations` when
   non-empty.
3. **ADP.** `locationLabels` becomes `siteLocations`: entries with an address
   map directly (`cityName`/`codeValue`/`countryCode` + `text` from
   `shortName`); address-less entries still feed `parseLocationList` for both
   the entry and the merged view.
4. **RDW.** Iterate `ld.locations` (all entries) into `locations[]`; card
   `locationText` path emits `parsed.locations`.
5. **Tests + docs.** Per-plugin cases from the spec's contracts; index/log.

## Packages touched

- `packages/models` — `LocationDto.postalCode`/`streetAddress`,
  `canonical-job.schema.ts`.
- `packages/plugins/source-ats-ashby`, `source-ats-adp`,
  `source-company-rdw` — services, (ashby) types, specs.

## Risks

- Ashby `location` (merged) is intentionally unchanged — built from the same
  labels through `parseLocationList`. `locations[]` is where the improved
  structure lives.
- The name-keyword list is a heuristic; it only sets `name` (an additive
  label) and never removes geography, so a false positive costs nothing
  semantically.
- `country` from `addressCountry` is kept verbatim (`"USA"` stays `"USA"`) —
  consistent with Spec 5120's "record what the wire said" stance; only
  `state` is normalized via the existing `normalizeUsState`.
