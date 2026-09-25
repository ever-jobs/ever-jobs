# Spec: 5140 — `source-company-tau-robotics`: Tau Robotics careers page

| Field | Value |
| --- | --- |
| Spec ID | 5140 |
| Slug | source-company-tau-robotics |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

## Problem

`tau-robotics.com` hosts its own careers page — 8 company-hosted job
blocks, no recognized ATS. A company plugin is needed to harvest the
board.

## Contract

A new plugin `packages/plugins/source-company-tau-robotics/`
(`Site.TAU_ROBOTICS = 'tau-robotics'`, `category: 'company'`,
`companyDomains: ['tau-robotics.com']`).

Site token is the Spec 5069 domain derivation: `tau-robotics.com` →
strip `.com` → `tau-robotics` (hyphens pass through `deriveSiteToken`
unchanged — only dots become underscores). The `companyDomains`
declaration is redundant for routing but pre-claims the host.

### Site shape (verified live)

- `careers.html` → 301 → `/careers`: static HTML, ~9 KB, no JS, no
  Cloudflare. Plain `createHttpClient` fetch is sufficient.
- Each role is one anchor:
  `<a href="apply.html?role={slug}"><span class="role__title">{Title}</span><span class="role__meta">{Dept} · {Location} · {Type}</span></a>`.
- The apply page is a static shell; `apply.js` fills
  `#roleTitle`/`#roleMeta`/`#roleBody` from `?role=`. `apply.js` holds a
  `ROLES` map keyed by slug: `{title, meta, responsibilities[],
  requirements[]}` — real per-role descriptions, plus a shared
  preamble string before the map.
- `apply?role=` and `apply.html?role=` both resolve; use the
  careers-page href verbatim (made absolute) as `jobUrl`.

### Fetch

Two static fetches per scrape: `careers.html` (authoritative role list
and order) + `apply.js` (description map). No headless browser, no
per-role fetch.

### Mapping

- `id`/`atsId`: `tau-robotics-{slug}` (slug from the `?role=` param).
- `jobUrl`: absolute apply URL from the anchor `href`.
- `title`: `.role__title` text; cross-check against `ROLES[slug].title`
  when the map has the slug.
- `.role__meta` split on `·` → `department` (e.g. `Research`,
  `Software`, `Hardware`), `location` (`parseLocationText`), `jobType`
  (`getJobTypeFromString`).
- `description`: `ROLES[slug]` → `Responsibilities:` list +
  `Requirements:` list, joined as markdown text. Missing slug in the
  map → description absent (not an error).
- `companyName`: `Tau Robotics`.
- Not published by the site (absent by design, not parse failure):
  `datePosted`, `compensation`.

### Parsing note

`ROLES` is a JS object literal (single-quoted strings, trailing
commas). Extract via balanced-brace slice starting at `const ROLES =`
then parse each key's `{title, meta, responsibilities, requirements}`
with a small literal parser — never `eval`/`new Function`.

### Diagnostics

- Zero `a[href*="apply.html?role="]` anchors on the careers page →
  `ScrapeDiagnostics('empty')`.
- Unreachable/failed fetch → `classifyScrapeError`.
- `apply.js` missing or `ROLES` unparseable → careers rows still
  emitted, descriptions absent; log a warning.

### Edge cases

- `open-application` (generic "don't see a role" link) is skipped — it
  is not a real role.
- Anchor with missing/empty `.role__meta` → title-only row.
- `resultsWanted` caps the emitted list.

## Test Plan

Fixture HTML for careers page (8 roles + open-application) and a
fixture `apply.js` with a `ROLES` map:

- 8 roles mapped with title/department/location/jobType/jobUrl.
- Descriptions populated from `ROLES` (responsibilities + requirements).
- `open-application` skipped.
- Meta variants: missing meta, meta with fewer segments.
- Zero anchors → `empty` diagnostic.
- Slug absent from `ROLES` → row emitted, no description.
