# Tasks: 5047 — source-company-desktopmetal

- [x] T1 — Scaffold the plugin package (package.json, tsconfig, index barrel, module).
- [x] T2 — Constants + types (company/URLs, pay-interval tokens; opening/pay shapes).
- [x] T3 — `desktopmetal.pdf.ts`: unpdf text extraction with `hasEOL` line reconstruction.
- [x] T4 — `fetchListingHtml` via stealth `BrowserPool` (proxy-aware); `fetchPdfText` via HTTP client (arraybuffer).
- [x] T5 — `parseListing`: role anchors → title/location/department; global apply email; dedupe.
- [x] T6 — `toJobPost` mapping; `payFromText`/`detectInterval` with per-role interval hint + range normalization; employmentType/jobType detection.
- [x] T7 — `scrape` orchestration: `Promise.allSettled` PDF fan-out, graceful per-role degradation, input filters.
- [x] T8 — Register in the four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest mapper).
- [x] T9 — Fixture-based unit tests (captured HTML + real extracted PDF text).
- [x] T10 — Spec Kit docs; update `docs/index.md` and `docs/log.md`.
- [x] T11 — `api` build + plugin tests green; commit + PR off `develop`.

## Acceptance criteria
- Three current roles produced with title, department, location, full
  description, per-role compensation interval (two yearly, one hourly), and the
  global apply email.
- Non-role `/uploads` PDFs ignored; missing PDF degrades to listing-only fields.
- `api` build passes; plugin unit tests pass.
