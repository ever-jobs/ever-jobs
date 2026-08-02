# Tasks: 5044 — source-notion

| Field | Value |
| --- | --- |
| Spec ID | 5044 |
| Slug | source-notion |
| Status | implemented |

- [x] T1 — Scaffold `source-notion` package (package.json, tsconfig.json, index.ts, module, constants, types).
      AC: package resolves via tsconfig path; module exports service.
- [x] T2 — `loadPageChunk` POST helper + tolerant block resolver (both envelopes, dashed/dashless keys).
      AC: resolver returns the block value for a dashed or dashless id and unwraps nested envelopes.
- [x] T3 — Child-page enumeration from root `content` (keep `type:"page"`, title from inlined chunk, de-dupe).
      AC: root chunk with 2 page children + non-page children → exactly 2 roles.
- [x] T4 — Bounded detail fetch (`Promise.allSettled`, concurrency 5); per-role block walk → description + Location line + created_time.
      AC: title-duplicating header dropped; sections/bullets rendered; `Location:` captured.
- [x] T5 — DTO mapping: title, companyName (`Careers at X`→`X`), jobUrl, location (on-site stripped), isRemote, compensation, datePosted, emails→mailto.
      AC: Stone Power role → `Los Angeles, CA` (no On-Site), `careers@stonepower.us`, datePosted set.
- [x] T6 — Input handling: page-id from slug/URL; searchTerm/location/isRemote/jobType filters; offset/resultsWanted slice.
      AC: searchTerm narrows to matching roles; resultsWanted caps count; bad id → empty, no HTTP.
- [x] T7 — Register in four places (Site enum, ALL_SOURCE_MODULES, tsconfig paths, jest mapper).
      AC: `api` build compiles with NotionModule; module import resolves.
- [x] T8 — Unit tests (mocked loadPageChunk): enumeration, field parsing, both envelopes, id extraction, empty path, filters.
      AC: all tests green.
- [x] T9 — Live smoke on Stone Power (`361cc3fe052a81098df8d9d81147636d`).
      AC: 6 roles with title/location/description/apply/datePosted.
- [x] T10 — Docs: spec/plan/tasks; update `docs/index.md` + `docs/log.md`.
      AC: index lists 5044; log has newest-at-top entry.

## Future (not in this spec)

- [ ] Collection/database-view mode (roles as rows with Location/Type properties) — add when a real tenant needs it.
