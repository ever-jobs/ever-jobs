# Spec: 5038 — icims-board-rework (server-rendered board parse)

| Field | Value |
| --- | --- |
| Spec ID | 5038 |
| Slug | icims-board-rework |
| Status | implemented |
| Owner | agent |
| Created | 2026-07-07 |
| Last updated | 2026-07-07 |
| Related specs | — |

## Problem

`source-ats-icims` returned **0 jobs** for both tenants tested
(jobyaviation, stellarsolutions). Two dead paths:

1. **JSON "gateway" that isn't JSON.** The plugin GET-ed
   `…/jobs/search?pr={offset}&schemaId=&mode=job&iis=Internet` expecting a JSON
   body and treated `pr` as a **record offset** stepped by the page size (0, 20,
   40 …). iCIMS `jobs/search` returns **HTML**, and `pr` is a **0-based page
   index** (0, 1, 2 …), not an offset — so the JSON parse found nothing and the
   loop broke on the first page.

2. **Playwright fallback on unverified selectors.** When the gateway yielded
   zero, the plugin spun up a headless browser and tried a grab-bag of guessed
   selectors (`.iCIMS_JobsTable .row`, `[class*="location"]`, …) that don't
   match the live DOM (a `// TODO: validate selectors` was left in place). Net
   result: a heavyweight browser launch that still extracted 0 jobs.

iCIMS candidate-experience boards are **server-rendered HTML** and are fully
reachable over plain HTTP in their embeddable form — no browser required.

## Scope

- Rewrite the plugin onto HTTP + Cheerio against the server-rendered board.
- Request the embeddable board form `…/jobs/search?ss=1&in_iframe=1&pr={page}`
  (`in_iframe=1` returns the inner board even behind a custom career site).
- Treat `pr` as a **0-based page index**; walk pages using the board's
  "Page X of N" pager, stopping on a short/empty page or `resultsWanted`.
- Parse `.iCIMS_JobCardItem` cards: title, canonical job URL + numeric id,
  location (`{country}-{state}-{city}`), department (Category), a listing
  description snippet, and `isRemote`.
- Resolve a tenant from `companySlug` (a bare subdomain) or `companyUrl` (any
  `*.icims.com` URL); degrade to empty/partial results, never throw.
- Drop the Playwright dependency and the JSON-gateway code.

## Non-goals

- Per-job detail fetches (full body, posted date, structured pay). The listing
  snippet is used as `description`; enrichment is a later spec.
- Keyword/location server-side filtering.
- Tenants that expose only a modern JSON API surface (not observed for the
  boards validated here).

## Contracts

### Accepted addressing

| Input | Example | Subdomain resolution |
| --- | --- | --- |
| `companySlug` (bare) | `careers-acme` | used verbatim |
| `companySlug` (URL) | `https://careers-acme.icims.com/jobs/search` | host label before `.icims.com` |
| `companyUrl` | `https://careers-acme.icims.com/…` | host label before `.icims.com` |

### Board request

- URL: `https://{subdomain}.icims.com/jobs/search?ss=1&in_iframe=1` and
  `&pr={page}` for pages after the first (`pr` omitted for page 0).
- `pr` is a 0-based page index; each page holds up to `ICIMS_PAGE_SIZE` (20)
  cards.

### Pagination termination

- Stop when `collected >= resultsWanted`.
- Stop on a page with fewer than `ICIMS_PAGE_SIZE` cards.
- Stop when `page + 1 >= totalPages` parsed from the "Page X of N" pager.
- Hard ceiling `ICIMS_MAX_PAGES` (500) as a safety net.
- De-dupe by numeric job id across pages.

### Field mapping (`JobPostDto`)

| Field | Source |
| --- | --- |
| `id` | `icims-{subdomain}-{jobId}` |
| `atsId` | numeric id from `/jobs/{id}/…/job` |
| `title` | card `h3` (falls back to the anchor `title`, id prefix stripped) |
| `jobUrl` / `applyUrl` | canonical card URL, query stripped |
| `companyName` | `Job Listings at {Company}` `<title>` (falls back to title-cased subdomain) |
| `location` | `{country}-{state}-{city}` split; hyphenated cities preserved |
| `department` | Category header field |
| `description` | listing snippet (plain text) or null |
| `isRemote` | `remote` (whole word) in the location cell or the title |

## Test plan

- Unit tests (mocked HTTP) over generated board fixtures:
  - single-card parse → every mapped field.
  - multi-page walk to a short page + de-dupe of a repeated id.
  - stop at the pager total even when every page is full (no extra request).
  - `resultsWanted` hard cap.
  - remote detection + hyphenated-city location split.
  - subdomain resolution from a full `companyUrl`.
  - empty input → `[]` (no request); unknown tenant (HTTP 404) → `[]`.
  - company-name fallback to the subdomain when the board has no title.
- Live validation against 2 tenants (job counts): 242 and 37, parsed fields
  clean (title, company, location, department, id, isRemote).
