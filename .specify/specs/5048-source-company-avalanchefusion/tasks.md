# Tasks: 5048 — source-company-avalanchefusion

- [x] T1 — Scaffold the plugin package (package.json, tsconfig, index barrel, module).
- [x] T2 — Constants + types (company/URLs, pay-interval tokens; opening/detail/pay shapes).
- [x] T3 — `fetchListingHtml` / `fetchDetailHtml` via the shared HTTP client (isolated seams).
- [x] T4 — `parseListing`: `open-position` anchors → slug/jobUrl/title; dedupe by slug.
- [x] T5 — `parseDetail`: title, `.w-richtext` → markdown, `.salary-range`, LinkedIn apply URL.
- [x] T6 — `toJobPost` mapping; `payFromText`/`detectInterval` with per-role interval hint + range normalization; company-location default.
- [x] T7 — `scrape` orchestration: `Promise.allSettled` detail fan-out, graceful per-role degradation, input filters.
- [x] T8 — Register in the four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest mapper).
- [x] T9 — Fixture-based unit tests (captured board HTML + three real detail pages).
- [x] T10 — Spec Kit docs; update `docs/index.md` and `docs/log.md`.
- [x] T11 — `api` build + plugin tests green; commit + PR off `develop`.

## Acceptance criteria
- Nine current roles produced with title, jobUrl, description, yearly compensation, and a LinkedIn apply URL.
- Missing detail page degrades to board-only fields; empty board returns no roles (no throw).
- `api` build passes; plugin unit tests pass.
