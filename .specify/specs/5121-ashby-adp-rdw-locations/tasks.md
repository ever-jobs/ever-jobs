# Tasks: 5121 — Structured per-site locations for Ashby, ADP, RDW; canonical-schema mirror

| Field | Value |
|---|---|
| Spec | 5121 |
| Slug | `ashby-adp-rdw-locations` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-15 |
| Last updated | 2026-09-15 |
| Related specs | 5119 (`rippling-structured-locations`), 5120 (`location-text-and-per-site-locations`) |

- [x] T01 — `LocationDto.postalCode`/`streetAddress`; `RawJobSchema.location` extended (`name`/`text`/`postalCode`/`streetAddress`) + optional `locations` array.
- [x] T02 — `source-ats-ashby`: `siteLocation` structural mapping (postal geography, digit-locality → `streetAddress`, name keyword → `name`, `text` verbatim, parser fallback when no address); `secondaryLocations` → `locations[]`; merged `location`/remote signals unchanged.
- [x] T03 — `source-ats-adp`: structural `requisitionLocations` mapping (`cityName`/`codeValue`/`countryCode` + `text` from `shortName`), parser fallback for address-less entries, emit `locations`.
- [x] T04 — `source-company-rdw`: all `ld.locations[]` entries → `locations[]`; `card.locationText` path emits `parsed.locations`.
- [x] T05 — Unit tests per spec contracts; existing suites green.
- [x] T06 — `tsc --noEmit` on touched packages; `npm run lint:docs`; `docs/index.md` + `docs/log.md`; PR to `develop`.
