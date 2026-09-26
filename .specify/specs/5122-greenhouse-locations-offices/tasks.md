# Tasks: 5122 — Greenhouse per-site `locations[]` + `offices[]` (`OfficeDto`)

| Field | Value |
|---|---|
| Spec | 5122 |
| Slug | `greenhouse-locations-offices` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-15 |
| Last updated | 2026-09-15 |
| Related specs | 5119, 5120, 5121, 5027 |

- [x] T01 — `OfficeDto` (extends `LocationDto` + `id`); `JobPostDto.offices`;
      `RawJobSchema.offices` mirror.
- [x] T02 — `source-ats-greenhouse`: emit `locations[]` (public + Harvest
      paths) and `offices[]` via `officeDtos` (name verbatim, text =
      `office.location`, geo guards, paren-address unpacking, dedupe).
- [x] T03 — Unit tests per spec contracts; existing suites green.
- [x] T04 — `tsc --noEmit` on touched packages; `npm run lint:docs`;
      `docs/index.md` + `docs/log.md`; PR to `develop`.
