# Plan: 5122 — Greenhouse per-site `locations[]` + `offices[]` (`OfficeDto`)

| Field | Value |
|---|---|
| Spec | 5122 |
| Slug | `greenhouse-locations-offices` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-15 |
| Last updated | 2026-09-15 |
| Related specs | 5119, 5120, 5121, 5027 |

## Phases

1. **Models + schema.** `OfficeDto extends LocationDto` with `id`;
   `JobPostDto.offices?: OfficeDto[]`; `RawJobSchema.offices` mirror (same
   shape as `locations[]` plus `id`).
2. **Greenhouse service.** Emit `locations: parsedLocations.locations` on
   both public and Harvest paths. Add `officeDtos`/`officeDto`/
   `officeParenAddress`/`officeGeoFromName`: `name` verbatim,
   `text` = `office.location` verbatim, geo from `office.location` else the
   `" - "`-tail of the name (geo-guards: no remote tokens, pseudo-sites, or
   keyword/digit segments as cities), parenthesized-digit groups unpacked
   into `streetAddress`/`postalCode` (and `city`/`state` on the full
   `street, city, ST zip` shape). Dedupe on `id ?? name|text`.
   `officeLabels`/`workLocationLabels` remote-sensing untouched.
3. **Tests.** Six new cases per the spec contracts; existing suite green.
4. **Docs + PR.** `docs/index.md` row, `docs/log.md` entry, `tsc --noEmit`,
   `lint:docs`, conventional-commit, PR to `develop`.

## Risks

- `OfficeDto` subclasses `LocationDto`: `displayLocation()` already prefers
  `name` when no city — desired for offices.
- Office geo derived from names is best-effort; `name`/`text` keep the raw
  strings so consumers can re-parse.
