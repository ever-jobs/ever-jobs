# Spec: 5148

| Field | Value |
| ----- | ----- |
| Spec ID | 5148 |
| Slug | source-company-4earth_tech |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Problem statement

4Earth (`4earth.tech` — cleantech / resource-recovery hardware; Marietta,
GA) lists open roles on `https://www.4earth.tech/careers`, a React/Vercel
site. The SSR HTML carries truncated job cards; the full postings live in
a `const E=[…]` jobs array inside the `/assets/Careers-{hash}.js` chunk.
No recognized ATS serves the board, so it needs a dedicated company
plugin.

## Scope

- New plugin `source-company-4earth_tech`, `Site.FOUR_EARTH_TECH =
  '4earth_tech'` (the Spec 5069 domain derivation — `.tech` kept, dot →
  underscore; the enum member name cannot start with a digit).
  `companyDomains: ['4earth.tech']` declared to pre-claim the host.
- Two plain-HTTP GETs via `createHttpClient`, no headless:
  1. `GET /careers` → extract the `/assets/Careers-{hash}.js` chunk src.
  2. `GET {chunk}` → extract the embedded jobs array.
- The array is a minified JS literal; the binding name changes per
  deploy. Extraction locates `=[{id:"…"` and takes a balanced-bracket
  slice, then splits top-level `{…}` objects and reads fields by key —
  never `eval`/`Function`.
- Entry shape: `{id, title, location, type, mission, roleIntro,
  roleSummary, rolePoints[], sections[{heading, isList?, items[]}],
  whySection}`.
- `description` is composed as plain text: `mission`, `roleIntro`,
  `roleSummary`, `rolePoints` bullets, each section heading with its
  items (`{label, text}` pairs rendered `Label: text`, string items as
  bullets), then `whySection`.
- `id`/`atsId` = `4earth_tech-{entry.id}` (native slugs, e.g.
  `electrical-systems-engineer`).
- `location` → `parseLocationText`; `type` → `getJobTypeFromString` for
  `jobType` plus raw `employmentType`.
- `jobUrl`/`jobUrlDirect`/`applyUrl` = the careers page URL — the site
  has no per-role pages (details expand inline) and apply is an on-page
  modal form that posts to Supabase.
- `empty` diagnostics on zero entries (missing chunk link or empty
  array); `classifyScrapeError` on fetch failure;
  `resultsWanted`/`searchTerm`/`location`/`offset` honored.

## Non-goals

- No headless rendering — the full payload is in the static chunk.
- No `datePosted`, `compensation`, or `department` — not published.
- No apply deep-link — applications are a modal form on the careers
  page itself.

## Contracts

- Input: `companyUrl` (defaults to `https://www.4earth.tech/careers`),
  optional `searchTerm`, `location`, `resultsWanted`, `offset`,
  `requestTimeout`, `proxies`, `caCert`.
- Output: `JobResponseDto` of `JobPostDto` rows as above, or a
  `ScrapeDiagnostics` (`empty` / classified error).

## Test plan

- Unit tests against checked-in fixtures (careers shell + Careers chunk):
  - parses both roles with title/location/type;
  - composes a multi-part `description` containing mission, role
    sections, and the why-section;
  - ids derive `4earth_tech-{entry.id}`;
  - `jobUrl`/`applyUrl` point at the careers page;
  - missing chunk link or empty array → `empty` diagnostics;
  - fetch failure → `classifyScrapeError` diagnostics;
  - `searchTerm`/`location`/`resultsWanted` filtering honored.
