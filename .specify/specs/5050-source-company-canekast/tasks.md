# Tasks: 5050 — source-company-canekast

- [x] T1 — Scaffold the plugin package (package.json, tsconfig, index barrel, module).
- [x] T2 — Constants + types (company/URLs, PDF href matcher, letterhead matcher; CanekastOpening shape).
- [x] T3 — `fetchListingHtml` + `fetchPdfText` via the shared HTTP client (isolated seams); `unpdf` text extraction.
- [x] T4 — `parseListing`: collect `/wp-content/uploads/*.pdf` anchors, de-dupe by URL, title from anchor text (drop trailing `.pdf`).
- [x] T5 — `locationFromText`: parse city/state from the PDF letterhead via `parseLocationList`.
- [x] T6 — `toJobPost` mapping; strip letterhead from description; `applyUrl` = careers page; `emails` = []; `datePosted` = null; compensation omitted.
- [x] T7 — `scrape` orchestration + input filters; empty listing returns no roles (no throw).
- [x] T8 — Register in the four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest mapper).
- [x] T9 — Fixture-based unit tests (captured HTML + real extracted PDF text).
- [x] T10 — Spec Kit docs; update `docs/index.md` and `docs/log.md`.
- [x] T11 — `api` build + plugin tests green; commit + PR off `develop`.

## Acceptance criteria
- Three current roles produced with title, jobUrl, description, and a `Chaska, MN` location.
- A PDF fetch failure keeps the listing fields (description + location null).
- Empty listing returns no roles (no throw).
- `api` build passes; plugin unit tests pass.
