# Tasks: 5119 — Rippling: structured per-site locations (`JobPostDto.locations`, `LocationDto.name`)

| Field | Value |
|---|---|
| Spec | 5119 |
| Slug | `rippling-structured-locations` |
| Status | implemented |
| Owner | devin |
| Created | 2026-09-14 |
| Last updated | 2026-09-14 |
| Related specs | 5118 (`ats-posting-country-code`) |

- [x] T01 — `LocationDto.name` and `JobPostDto.locations` in `packages/models`; `displayLocation()` shows `name` when `city` is absent.
- [x] T02 — Export `normalizeUsState` from `location-parser`.
- [x] T03 — `source-ats-rippling`: structural `locationsFromWire` + `mergeSites` + `fallbackLocationLabels`; emit `locations`; `payRangeDetails[].isRemote` into `hasRemoteWorkplaceType`; typed `department`.
- [x] T04 — Unit tests for the new semantics (per-site country, remote markers, entity names, fallback-only behavior).
- [x] T05 — Focused jest + `tsc --noEmit` on touched packages; `lint:docs`; Q-091 parked in `docs/questions.md` for the input-filter gap.
