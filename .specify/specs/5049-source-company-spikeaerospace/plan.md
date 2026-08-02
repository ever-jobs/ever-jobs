# Plan: 5049 — source-company-spikeaerospace

| Field | Value |
| --- | --- |
| Spec ID | 5049 |
| Slug | source-company-spikeaerospace |
| Status | implemented |

## Phases

### Phase 1 — Enumerate via WordPress REST (plain HTTP)
- `resolveCategoryId(client)` — GET `/wp-json/wp/v2/categories?slug=current-openings`; take the first id, falling back to the known id on empty/failed lookup.
- `fetchRolePosts(client)` — GET `/wp-json/wp/v2/posts?categories=<id>&per_page=100`. Isolated so tests substitute captured JSON.

### Phase 2 — Parse + map
- `parseRoles(posts)` — per post: decode `title.rendered` and drop a leading `Seeking ` verb; body from `content.rendered`; `jobUrl` from `link`; `datePosted` from `date` via `toDateOnly`.
- `description(rendered)` — Cheerio: remove `wpcf7` nodes and the dangling "Submit Your Resume:" / empty paragraphs, then render to markdown via the shared `markdownConverter`.
- `toJobPost(role)` — build `JobPostDto`; `location` = `null` (the site lists none); `emails` = []; compensation omitted.

### Phase 3 — Registration, tests, docs
- Register in the four standard places.
- Fixture-based unit tests (captured category posts JSON).
- Spec Kit docs + `docs/index.md` / `docs/log.md`.

## Packages touched
- `packages/plugins/source-company-spikeaerospace` (new)
- `packages/models` (Site enum entry)
- `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js` (registration)

## Reused building blocks
- `@ever-jobs/common`: `createHttpClient`, `markdownConverter`, `toDateOnly` (Spec 5024).
- `@ever-jobs/models`: `JobPostDto`, `Site`.
- `cheerio` for HTML parsing. No new dependency; no headless browser.

## Risks
- **Category id drift** — resolved by slug at runtime, with the known id as a fallback.
- **Loop-Grid under-count** — avoided by enumerating the category directly rather than the paginated listing page.
- **Form artifacts in the body** — the `wpcf7` placeholder and dangling label are stripped so they do not leak into the description.
