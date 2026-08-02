# Plan: 5053 — source-company-galadyne

| Field | Value |
| --- | --- |
| Spec ID | 5053 |
| Slug | source-company-galadyne |
| Status | implemented |

## Phases

### Phase 1 — Fetch (plain HTTP)
- `fetchText(client, url)` — GET a page/chunk as text (no headless browser). One seam for both the listing and the chunk so tests substitute captured content per URL.

### Phase 2 — Enumerate (server HTML)
- `parseCards(html)` — Cheerio: each opening is an `<h2>` title with a location `<span>` (the geo-pin label) beside it. Returns `{title, location}`; de-duped by title.

### Phase 3 — Descriptions (client chunk)
- `fetchContent(client, listingHtml)` — read the current `.../app/careers/page-<hash>.js` URL from the listing (self-heals the hash), GET it, and parse it. Never throws — returns an empty map on miss so roles still emit.
- `parseContent(chunk)` — anchor on `"<title>":{intro:"`; brace-slice each value object; read `intro`/`closing` as strings and `responsibilities`/`qualifications` as string arrays via a small string-aware scanner (`sliceBraces`, `scanString`, `readString`, `readStringArray`).

### Phase 4 — Map + filter
- `toJobPost(card, content)` — `id` = `galadyne-<slug>`; `jobUrl`=`applyUrl`=`companyUrl`=`/careers`; `location` from the card; `description` composed from the chunk content (intro, **Responsibilities**, **Qualifications**, closing); `isRemote` false; `datePosted` null; `emails` [].
- `applyInput` — searchTerm, location, isRemote, jobType filters; offset/resultsWanted slice.

### Phase 5 — Registration, tests, docs
- Register in the four places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest moduleNameMapper).
- Fixture-based unit tests (captured careers HTML + chunk).
- Spec Kit docs; update `docs/index.md` and `docs/log.md`.

## Packages touched
- `packages/plugins/source-company-galadyne` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js` (registration)

## Risks
- The description lives in a client chunk. The parse anchors on the stable content keys (role titles + unmangled `intro`/`responsibilities`/`qualifications`/`closing`) and reads the chunk URL from the page each run, so build-hash / minified-name / CSS-class churn does not affect it. If the site later mangles property names or moves the data behind a runtime API, the parse yields empty and roles degrade to listing-only (title + location) rather than emitting garbage.
