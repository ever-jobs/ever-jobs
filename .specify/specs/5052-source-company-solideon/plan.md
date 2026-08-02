# Plan: 5052 — source-company-solideon

| Field | Value |
| --- | --- |
| Spec ID | 5052 |
| Slug | source-company-solideon |
| Status | implemented |

## Phases

### Phase 1 — Fetch (plain HTTP)
- `fetchHtml(client, url)` — GET a page as text (server-rendered, no headless browser). One seam for both the listing and the detail pages so tests substitute captured HTML per URL.

### Phase 2 — Enumerate
- `parseListingLinks(html)` — Cheerio: collect anchors whose href matches `/solideon-<slug>/`; each opening is both a titled link and an "Apply" link, so keep the titled text and de-dupe by slug. The "General Career Interest" form is not a role link, so it is excluded by the pattern.

### Phase 3 — Detail parse + map
- Fan out over the role links with `Promise.allSettled` (a single detail failure must not drop the batch).
- Per detail page:
    - `description($)` — `<main>` → markdown; cut the "TO APPLY FILL OUT THE FORM BELOW" apply section (Paperform), then strip leading chrome (the "2025 <role>" title + Elementor divider rules).
    - `location(text)` — the "Location:" line, parenthetical dropped, via `parseLocationList`.
    - `compensation(text)` — the "Salary Recommendation" range via `salaryToCompensation`, interval stated yearly (annual salary figures); null when the page states none.
    - `datePosted(html)` — JSON-LD `datePublished` via `toDateOnly`.
    - `isRemote` — false (stated On-Site).

### Phase 4 — Registration, tests, docs
- Register in the four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest moduleNameMapper).
- Fixture-based unit tests (captured careers + detail HTML).
- Spec Kit docs; update `docs/index.md` and `docs/log.md`.

## Packages touched
- `packages/plugins/source-company-solideon` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js` (registration)

## Risks
- Detail-page markup is Elementor soup; `<main>` scoping + apply-marker cut + leading-chrome strip keep the description clean without hardcoding widget ids.
- Salary/location are parsed from labelled text lines; a wording change would drop the field (returns null) rather than emit garbage.
