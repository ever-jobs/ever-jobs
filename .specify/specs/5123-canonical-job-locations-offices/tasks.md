# Tasks: 5123 — `CanonicalJob` `locations[]`/`offices[]`; site-set identity key

| Field | Value |
|---|---|
| Spec | 5123 |
| Slug | `canonical-job-locations-offices` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-15 |
| Last updated | 2026-09-15 |
| Related specs | 003, 5119, 5120, 5121, 5122 |

- [x] T01 — `CanonicalJob.locations`/`offices`; `CanonicalJobSchema` mirror.
- [x] T02 — `canonical-key`: `locations` input → sorted normalised triples
      with `location`-string fallback.
- [x] T03 — `dedup-hybrid`: pass `raw.locations` to the key; `unionLocations`
      + `unionOffices` in pass-3; emit when non-empty.
- [x] T04 — Unit tests (key triples/fallback; singleton copy; offices union;
      MinHash-weld locations union); suites green.
- [ ] T05 — `tsc --noEmit` on touched packages; `npm run lint:docs`;
      `docs/index.md` + `docs/log.md`; PR to `develop`.
