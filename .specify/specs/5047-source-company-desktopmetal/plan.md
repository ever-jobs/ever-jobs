# Plan: 5047 — source-company-desktopmetal

| Field | Value |
| --- | --- |
| Spec ID | 5047 |
| Slug | source-company-desktopmetal |
| Status | implemented |

## Phases

### Phase 1 — Listing (stealth browser)
- `fetchListingHtml(input)` — `BrowserPool.getPage({ stealth: true, proxy })`,
  navigate to `/careers`, wait for the `/uploads/*.pdf` anchors, return
  `page.content()`. Isolated so tests substitute captured HTML.
- `parseListing(html)` — Cheerio: select role anchors (`/uploads/*.pdf` with
  `Title - Location` text), split title/location on the last ` - `, take the
  department from the nearest preceding non-empty `<h3>`, and read the global
  `mailto:` apply email. Dedupe by PDF URL.

### Phase 2 — PDFs (plain HTTP + text extraction)
- `fetchPdfText(client, url)` — shared HTTP client, `responseType:'arraybuffer'`;
  hand the bytes to the PDF extractor. Isolated so tests substitute text.
- `desktopmetal.pdf.ts` — unpdf: per-page `getTextContent`, rebuild lines from
  `hasEOL` flags, collapse whitespace. Falls back to unpdf's merged text.

### Phase 3 — Mapping
- `toJobPost(opening, pdfText, applyEmail)` — build `JobPostDto`; description from
  the PDF text; compensation via the shared salary parser with the per-role
  interval hint; location via `parseLocationList`; employmentType/jobType from
  prose; global apply email → `mailto:`.
- `payFromText` / `detectInterval` — read the pay range and its authoritative
  interval from the PDF's "Salary Range" / "Hourly Range" label (per-unit token
  fallback); normalize the numeric range before parsing.

### Phase 4 — Registration, tests, docs
- Register in the four standard places.
- Fixture-based unit tests (captured HTML + real extracted PDF text).
- Spec Kit docs + `docs/index.md` / `docs/log.md`.

## Packages touched
- `packages/plugins/source-company-desktopmetal` (new)
- `packages/models` (Site enum entry)
- `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js` (registration)
- root `package.json` (unpdf dependency)

## Reused building blocks
- `@ever-jobs/common`: `BrowserPool` (stealth), `createHttpClient`,
  `salaryToCompensation` (+ `interval` hint, Spec 5045), `parseLocationList`,
  `extractEmails`.
- `@ever-jobs/models`: `JobPostDto`, `Site`, `CompensationInterval`,
  `getJobTypeFromString`.
- `unpdf` for PDF text extraction.

## Risks
- **Cloudflare on the listing** — mitigated by the stealth browser; a
  caller-supplied proxy is used when datacenter egress is challenged. The plugin
  ships no proxy.
- **PDF layout drift** — pay parsing is anchored on the "Range" label + `$`
  amounts, not fixed positions; description degrades gracefully (null) if a PDF
  cannot be fetched or parsed.
- **`Promise.allSettled`** for the per-role PDF fan-out so one failure does not
  drop the batch.
