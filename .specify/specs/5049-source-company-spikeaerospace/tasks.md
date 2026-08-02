# Tasks: 5049 — source-company-spikeaerospace

- [x] T1 — Scaffold the plugin package (package.json, tsconfig, index barrel, module).
- [x] T2 — Constants + types (company/URLs, category slug + fallback id, REST URL builders; WpCategory/WpPost/SpikeRole shapes).
- [x] T3 — `resolveCategoryId` + `fetchRolePosts` via the shared HTTP client (isolated seam).
- [x] T4 — `parseRoles`: decode title + drop leading `Seeking `; body from `content.rendered`; `jobUrl` from `link`; `datePosted` from `date` via `toDateOnly`.
- [x] T5 — `description`: strip `wpcf7` placeholder + dangling label/empty paragraphs, render to markdown.
- [x] T6 — `toJobPost` mapping; company-location default via `parseLocationList`; `emails` = []; compensation omitted.
- [x] T7 — `scrape` orchestration + input filters; empty-category returns no roles (no throw).
- [x] T8 — Register in the four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest mapper).
- [x] T9 — Fixture-based unit tests (captured category posts JSON).
- [x] T10 — Spec Kit docs; update `docs/index.md` and `docs/log.md`.
- [x] T11 — `api` build + plugin tests green; commit + PR off `develop`.

## Acceptance criteria
- Nine current roles produced with title, jobUrl, description, and a truthful `datePosted`.
- Empty category returns no roles (no throw).
- `api` build passes; plugin unit tests pass.
