# Plan: 5051 — source-company-velontra

| Field | Value |
| --- | --- |
| Spec ID | 5051 |
| Slug | source-company-velontra |
| Status | implemented |

## Phases

### Phase 1 — Fetch (plain HTTP)
- `fetchListingHtml(client)` — GET `/careers/` as text (server-rendered, no headless browser). Isolated so tests substitute captured HTML.

### Phase 2 — Parse + map
- `parseListing(html)` — Cheerio: for each `.fl-accordion-item`, take the title from `.fl-accordion-button-label` and the body from `.fl-accordion-content`; de-dupe by title slug.
- `description(panelHtml)` — drop the leading "Job Title: …" heading (redundant with the title), render the rest to markdown via the shared `markdownConverter`.
- `toJobPost(role)` — build `JobPostDto`; `jobUrl` = careers page; `applyUrl` = `/apply/`; `location` = null; `emails` = []; `datePosted` = null; compensation omitted.

### Phase 3 — Registration, tests, docs
- Register in the four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest moduleNameMapper).
- Fixture-based unit tests (captured careers HTML).
- Spec Kit docs; update `docs/index.md` and `docs/log.md`.

## Packages touched
- `packages/plugins/source-company-velontra` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js` (registration)

## Risks
- Accordion class names (`fl-accordion-*`) are Beaver Builder's; a builder change would need a selector update — mitigated by returning no roles (no throw) rather than emitting garbage.
- All roles share one `jobUrl` (the careers page); identity stays unique via the title slug.
