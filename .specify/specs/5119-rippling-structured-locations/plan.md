# Plan: 5119 — Rippling: structured per-site locations (`JobPostDto.locations`, `LocationDto.name`)

| Field | Value |
|---|---|
| Spec | 5119 |
| Slug | `rippling-structured-locations` |
| Status | implemented |
| Owner | devin |
| Created | 2026-09-14 |
| Last updated | 2026-09-14 |
| Related specs | 5118 (`ats-posting-country-code`) |

## Phases

1. **Models.** `LocationDto.name` + `JobPostDto.locations` — both optional and
   additive; `displayLocation()` shows `name` only when `city` is absent.
2. **Common.** Export `normalizeUsState` from `location-parser` (was private).
3. **Rippling service.** Replace `locationLabels` with `locationsFromWire`
   (structural mapping), `mergeSites` (compat merge built from structured
   fields, country omitted on disagreement), and `fallbackLocationLabels`
   (`workLocations` + state-bearing `payRangeDetails[].location`); wire
   `payRangeDetails[].isRemote` into `hasRemoteWorkplaceType`; emit
   `locations`; type `department`.
4. **Tests.** New `Spec 5119` describe block covering per-site country,
   remote markers, entity names, fallback behavior; update the existing
   name→city expectation.

## Packages touched

- `packages/models` — `LocationDto.name`, `JobPostDto.locations`.
- `packages/common` — `normalizeUsState` export.
- `packages/plugins/source-ats-rippling` — service + types + tests.

## Risks

- `location` for a single site now returns separate `city`/`state`/`country`
  instead of inheriting a display label — strictly more structured; the
  merged multi-site `city` string keeps the same `A; B` shape.
- `mergeSites` labels use `City, Country` when no state exists (e.g.
  "Berlin, Germany") — a deliberate disambiguator in the compat view.
- Name-only `locations` entries are names, not geography — documented in the
  DTO comment and surfaced in `displayLocation()` only when `city` is absent.
