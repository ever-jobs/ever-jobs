# Tasks: 5052 — source-company-solideon

- [x] T1 — Scaffold the plugin package (package.json, tsconfig, index barrel, module).
- [x] T2 — Constants + types (company/URLs; role-href regex; SolideonRoleLink shape).
- [x] T3 — `fetchHtml(client, url)` via the shared HTTP client (single seam for listing + detail).
- [x] T4 — `parseListingLinks`: `/solideon-<slug>/` anchors, titled text, de-duped by slug.
- [x] T5 — `description`: `<main>` → markdown, cut the apply section, strip leading title/divider chrome.
- [x] T6 — `location`: parse the "Location:" line (parenthetical dropped) via `parseLocationList`.
- [x] T7 — `compensation`: parse the "Salary Recommendation" range via `salaryToCompensation` (yearly); null when absent.
- [x] T8 — `datePosted`: JSON-LD `datePublished` via `toDateOnly`; `isRemote` false; `emails` [].
- [x] T9 — `scrape` orchestration (`Promise.allSettled` fan-out) + input filters; empty listing returns nothing (no throw).
- [x] T10 — Register in the four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest mapper).
- [x] T11 — Fixture-based unit tests (captured careers + detail HTML).
- [x] T12 — Spec Kit docs; update `docs/index.md` and `docs/log.md`.
- [x] T13 — `api` build + plugin tests green; commit + PR off `develop`.

## Acceptance criteria
- Four current roles produced with title, description, per-role location, per-role compensation where stated, detail-page date, and the detail page as apply URL.
- Compensation omitted where the page states no salary; location is each role's own stated city.
- Empty listing returns no roles (no throw).
- `api` build passes; plugin unit tests pass.
