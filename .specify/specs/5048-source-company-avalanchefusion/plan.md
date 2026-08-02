# Plan: 5048 — source-company-avalanchefusion

| Field | Value |
| --- | --- |
| Spec ID | 5048 |
| Slug | source-company-avalanchefusion |
| Status | implemented |

## Phases

### Phase 1 — Board (plain HTTP)
- `fetchListingHtml(client)` — shared HTTP client GET `/careers/open-positions`. Isolated so tests substitute captured HTML.
- `parseListing(html)` — Cheerio: select every `/careers/open-position/{slug}` anchor, dedupe by slug, take the anchor text as the role title.

### Phase 2 — Detail (plain HTTP + Cheerio)
- `fetchDetailHtml(client, url)` — shared HTTP client GET the role page. Isolated so tests substitute captured HTML.
- `parseDetail(html)` — title (`h2.blue.center-text`), description (`.w-richtext` → markdown), salary (`.salary-range`), apply URL (the `Apply` anchor's LinkedIn `href`).
- Fan out the detail fetches with `Promise.allSettled` so one failure does not drop the batch; a failed role degrades to board-only fields.

### Phase 3 — Mapping
- `toJobPost(opening, detail)` — build `JobPostDto`; description from the rich-text markdown; compensation via the shared salary parser with the per-role interval hint; location via `parseLocationList` on the company-metro default; `applyUrl` = the LinkedIn URL; `datePosted` = null; `emails` = [].
- `payFromText` / `detectInterval` — read the pay range and its authoritative interval from the `Salary Range` token; strip the token from the numeric input and normalize `K`/`M` suffixes + unicode dashes before parsing.

### Phase 4 — Registration, tests, docs
- Register in the four standard places.
- Fixture-based unit tests (captured board HTML + three real detail pages).
- Spec Kit docs + `docs/index.md` / `docs/log.md`.

## Packages touched
- `packages/plugins/source-company-avalanchefusion` (new)
- `packages/models` (Site enum entry)
- `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js` (registration)

## Reused building blocks
- `@ever-jobs/common`: `createHttpClient`, `salaryToCompensation` (+ `interval` hint, Spec 5045), `parseLocationList`, `markdownConverter`.
- `@ever-jobs/models`: `JobPostDto`, `Site`, `CompensationInterval`.
- `cheerio` for HTML parsing. No new dependency; no headless browser.

## Risks
- **Webflow template drift** — title/salary/apply parsing is anchored on stable class names (`salary-range`, `w-richtext`, `button-primary`) and the `open-position` path, not fixed positions; a role degrades gracefully (board-only) if its detail page cannot be fetched.
- **`Promise.allSettled`** for the per-role detail fan-out so one failure does not drop the batch.
- **Location not structured** — defaulted to the company metro rather than guessed from noisy body prose.
