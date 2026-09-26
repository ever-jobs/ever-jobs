# Spec: 5150

| Field | Value |
| ----- | ----- |
| Spec ID | 5150 |
| Slug | source-company-thermwood |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Problem statement

Thermwood (`thermwood.com` — CNC machining-center manufacturer; Dale,
IN) lists open roles on
`https://www.thermwood.com/employment-opportunities.htm`. The page is
fully server-rendered HTML; no recognized ATS serves the board, so it
needs a dedicated company plugin.

## Scope

- New plugin `source-company-thermwood`, `Site.THERMWOOD = 'thermwood'`
  (the Spec 5069 domain derivation — `thermwood.com` → `thermwood`).
  `companyDomains: ['thermwood.com']` declared to pre-claim the host.
- One plain-HTTP GET via `createHttpClient`, no headless; Cheerio
  parses `div.job-card` cards. Retired cards are kept in the markup
  inside `<!-- -->` comments — the parser never matches them, so only
  live cards emit (verified live: 2 cards — "Manufacturing Technician"
  and "General Application - Production").
- Per card:
  - `h3.job-card-title` → `title`.
  - `.job-card-date` → `datePosted`: `Posted: MM-DD-YYYY` parses to a
    `Date`; `Ongoing` (or anything non-dated) → null.
  - `.job-card-location` ("Dale, IN • Full-time") splits on the `•`
    separator: the left part → `parseLocationText`, the right part →
    `extractJobType` (hyphen-normalized) for `jobType` plus raw
    `employmentType`.
  - `.job-card-details` → `description`: `h4` headings and `ul/li`
    bullets composed to plain text.
  - `a.apply-btn` (`#application-form`) → `applyUrl` =
    `{page}#application-form` — all cards share one HubSpot form embed
    at the bottom of the page.
  - `emails` via `extractEmails` on the card text (the Manufacturing
    card carries a resume mailto).
- `id`/`atsId` = `thermwood-{slug-from-title}`.
- `jobUrl`/`jobUrlDirect` = the careers page URL — cards expand inline;
  no per-role pages exist.
- `empty` diagnostics on zero cards; `classifyScrapeError` on fetch
  failure; `resultsWanted`/`searchTerm`/`location`/`offset` honored.

## Non-goals

- No headless rendering — the card content is in the static HTML.
- No `compensation` or `department` — not published.
- No apply deep-link — applications share a single HubSpot form;
  `applyUrl` anchors to it.
- Commented-out (retired) cards are never emitted.

## Contracts

- Input: `companyUrl` (defaults to
  `https://www.thermwood.com/employment-opportunities.htm`), optional
  `searchTerm`, `location`, `resultsWanted`, `offset`,
  `requestTimeout`, `proxies`, `caCert`.
- Output: `JobResponseDto` of `JobPostDto` rows as above, or a
  `ScrapeDiagnostics` (`empty` / classified error).

## Test plan

- Unit tests against a checked-in page fixture (with commented-out
  cards present):
  - parses only the live cards, never the commented-out ones;
  - title/location/type/datePosted mapped per card;
  - `description` contains section headings and bullets;
  - ids derive `thermwood-{slug}`;
  - `applyUrl` anchors to `#application-form`;
  - resume mailto surfaces in `emails`;
  - zero cards → `empty` diagnostics; fetch failure →
    `classifyScrapeError`;
  - `searchTerm`/`location`/`resultsWanted`/`offset` honored.
