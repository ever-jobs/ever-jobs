# Tasks: 5053 — source-company-galadyne

- [x] T1 — Scaffold the plugin package (package.json, tsconfig, index barrel, module).
- [x] T2 — Constants + types (company/URLs; chunk-href regex; GaladyneCard / GaladyneContent shapes).
- [x] T3 — `fetchText(client, url)` via the shared HTTP client (single seam for listing + chunk).
- [x] T4 — `parseCards`: `<h2>` title + location `<span>` from the server-rendered listing.
- [x] T5 — `fetchContent`: read the current chunk URL from the listing (self-heal hash), fetch, parse; never throws.
- [x] T6 — `parseContent`: anchor on `"<title>":{intro:"`, brace-slice, read fields by unmangled key.
- [x] T7 — `description`: compose markdown (intro, **Responsibilities**, **Qualifications**, closing).
- [x] T8 — `toJobPost`: id/company/urls; per-card location; `isRemote` false; `datePosted` null; `emails` [].
- [x] T9 — `scrape` orchestration + input filters; empty listing returns nothing (no throw); chunk miss degrades to listing-only.
- [x] T10 — Register in the four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest mapper).
- [x] T11 — Fixture-based unit tests (captured careers HTML + chunk).
- [x] T12 — Spec Kit docs; update `docs/index.md` and `docs/log.md`.
- [x] T13 — `api` build + plugin tests green; commit + PR off `develop`.

## Acceptance criteria
- All five postings produced (incl. the general internship) with title, JD description, stated location, and the `/careers` page as apply URL.
- Salary/date omitted (none stated); location is each card's own stated value.
- Chunk unavailable → roles still emit from the listing with null description.
- Empty listing returns no roles (no throw).
- `api` build passes; plugin unit tests pass.
