# Tasks: 5051 — source-company-velontra

- [x] T1 — Scaffold the plugin package (package.json, tsconfig, index barrel, module).
- [x] T2 — Constants + types (company/URLs; VelontraRole shape).
- [x] T3 — `fetchListingHtml` via the shared HTTP client (isolated seam).
- [x] T4 — `parseListing`: `.fl-accordion-item` → title + panel, de-duped by slug.
- [x] T5 — `description`: drop the "Job Title:" heading, render panel to markdown.
- [x] T6 — `toJobPost` mapping; `jobUrl` = careers page; `applyUrl` = `/apply/`; `location`/`datePosted` null; `emails` = []; compensation omitted.
- [x] T7 — `scrape` orchestration + input filters; empty page returns no roles (no throw).
- [x] T8 — Register in the four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest mapper).
- [x] T9 — Fixture-based unit tests (captured careers HTML).
- [x] T10 — Spec Kit docs; update `docs/index.md` and `docs/log.md`.
- [x] T11 — `api` build + plugin tests green; commit + PR off `develop`.

## Acceptance criteria
- Four current roles produced with title, description, `/apply/` apply URL, and null location.
- Empty page returns no roles (no throw).
- `api` build passes; plugin unit tests pass.
