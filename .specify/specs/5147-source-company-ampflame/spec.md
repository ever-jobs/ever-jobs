# Spec: 5147

| Field | Value |
| ----- | ----- |
| Spec ID | 5147 |
| Slug | source-company-ampflame |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Problem statement

Accurate Metals (`ampflame.com` — steel processing, flame/laser/plasma
cutting, grinding; Wisconsin, USA) lists open roles in a "Join Our Team"
table on `https://ampflame.com/about/`. The table is fully present in the
server-rendered Next.js HTML; no recognized ATS serves the board, so it
needs a dedicated company plugin.

## Scope

- New plugin `source-company-ampflame`, `Site.AMPFLAME = 'ampflame'` (the
  Spec 5069 domain derivation). `companyDomains: ['ampflame.com']`
  declared to pre-claim the host.
- One plain-HTTP GET of the careers URL via `createHttpClient` — the
  listings table is in the static HTML (no pagination, no client-side
  job loading).
- The table is `div[role="table"][aria-label="Open positions"]`; data rows
  are `div[role="row"]` blocks containing `span[role="cell"][data-label]`
  cells keyed `Department` | `Location` | `Position` | `Apply`. The
  header row (only `span[role="columnheader"]` cells) is skipped.
  Selectors target the `role`/`data-label`/`aria-label` attributes —
  the `CareersSection_*` class names are hashed CSS modules and change
  per build.
- `title` = Position cell, `department` = Department cell, `location` =
  Location cell through `parseLocationText`.
- `jobUrl`/`jobUrlDirect` = the careers page URL (the site publishes no
  per-role page); `applyUrl` = the Apply anchor href resolved absolute
  against `ampflame.com` (all roles share the generic contact form
  `/accurate-metals-contact-us/`).
- `id` = `ampflame-{position-slug}-{location-slug}` ( `atsId` the bare
  composite) — required because two roles can share title + department
  (e.g. Blanchard Grinder Operator in two cities). The Apply anchor's
  `aria-label` ("Apply for {position} in {location}") serves as a
  cross-check for the pair.
- `empty` diagnostics on zero rows; `classifyScrapeError` on fetch
  failure; `resultsWanted`/`searchTerm`/`location`/`offset` honored.

## Non-goals

- No headless rendering — everything needed is in the SSR HTML.
- No descriptions, `datePosted`, or `compensation` — the site publishes
  none.
- The apply form is generic (a single contact page with a "Careers"
  dropdown option); no per-role apply target exists.

## Contracts

- Input: `companyUrl` (defaults to `https://ampflame.com/about/`),
  optional `searchTerm`, `location`, `resultsWanted`, `offset`,
  `requestTimeout`, `proxies`, `caCert`.
- Output: `JobResponseDto` of `JobPostDto` rows as above, or a
  `ScrapeDiagnostics` (`empty` / classified error).

## Test plan

- Unit tests against a checked-in fixture of the about page:
  - parses the 3 live rows with title/department/location;
  - deduplicates identical titles via the location slug in `id`/`atsId`;
  - resolves the apply href to an absolute `applyUrl`;
  - `jobUrl` points at the careers page;
  - zero rows → `empty` diagnostics;
  - HTTP error → `classifyScrapeError` diagnostics;
  - `searchTerm`/`location`/`resultsWanted` filtering honored.
