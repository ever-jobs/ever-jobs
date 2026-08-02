# Plan: 5050 — source-company-canekast

| Field | Value |
| --- | --- |
| Spec ID | 5050 |
| Slug | source-company-canekast |
| Status | implemented |

## Phases

### Phase 1 — Fetch (plain HTTP)
- `fetchListingHtml(client)` — GET `/careers/` as text (server-rendered, no headless browser). Isolated so tests substitute captured HTML.
- `fetchPdfText(client, url)` — GET the role PDF as `arraybuffer`; extract text with `unpdf` (bundled pdfjs, no native deps), reconstructing line/paragraph breaks from pdfjs `hasEOL` flags. Isolated so tests substitute text.

### Phase 2 — Parse + map
- `parseListing(html)` — Cheerio: collect anchors to `/wp-content/uploads/*.pdf`, de-dupe by URL (the page carries a duplicate file-name anchor per role), and take the title from the anchor text with a trailing `.pdf` dropped.
- `locationFromText(text)` — read the city/state from the PDF letterhead address; build a `LocationDto` via `parseLocationList`.
- `toJobPost(opening, text)` — build `JobPostDto`; strip the letterhead from the description; `applyUrl` = careers page; `emails` = []; `datePosted` = null; compensation omitted.

### Phase 3 — Registration, tests, docs
- Register in the four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest moduleNameMapper).
- Fixture-based unit tests (captured HTML + real extracted PDF text).
- Spec Kit docs; update `docs/index.md` and `docs/log.md`.

## Packages touched
- `packages/plugins/source-company-canekast` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js` (registration)

## Risks
- Letterhead format change would drop the location — mitigated by degrading to `location: null` rather than emitting a wrong value.
- A future non-role PDF under `/wp-content/uploads/` linked from the page would be picked up; acceptable given the page only links role PDFs there today.
