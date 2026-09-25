# Spec: 5149

| Field | Value |
| ----- | ----- |
| Spec ID | 5149 |
| Slug | source-company-zennoastronautics |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Problem statement

Zenno Astronautics (`zennoastronautics.com` — superconducting magnetic
attitude-control hardware for spacecraft; Los Angeles, CA / Auckland,
NZ) lists open roles on
`https://www.zennoastronautics.com/careers`. The page is a ~650-byte SPA
shell whose bundle renders everything client-side from a Sanity CMS
dataset. No recognized ATS serves the board, so it needs a dedicated
company plugin.

## Scope

- New plugin `source-company-zennoastronautics`, `Site.ZENNOASTRONAUTICS
  = 'zennoastronautics'` (the Spec 5069 domain derivation —
  `zennoastronautics.com` → `zennoastronautics`).
  `companyDomains: ['zennoastronautics.com']` declared to pre-claim the
  host.
- One plain-HTTP GET via `createHttpClient`, no headless: the site's own
  public Sanity query endpoint —
  `GET https://zsx1k6t6.api.sanity.io/v2021-10-21/data/query/production?query=`
  + the URL-encoded GROQ
  `*[_type == "job" && isActive == true]{title, slug, location, type, compensation, "text": description[]{style, listItem, children, markDefs}}`.
  A single batched query returns every active job with its full
  portable-text description.
- Sanity response: `{result: [{title, slug{current}, location, type,
  compensation, text[]}]}`. `text` blocks are portable text —
  `{style, listItem, children[{text, marks[]}], markDefs[{_key, href}]}`.
- `description` is composed from `text`: each block's `children` spans
  are concatenated; spans marked with a `markDefs` link entry render as
  `text (href)` so apply/contact links survive; `listItem` blocks get a
  `- ` bullet prefix; empty blocks are skipped; blocks join on `\n\n`.
- `id`/`atsId` = `zennoastronautics-{slug.current}` (native slugs, e.g.
  `capture-lead-defense`); title-slug fallback when `slug.current` is
  absent.
- `location` → `parseLocationText`; `type` ("Full-time") →
  `extractJobType` on the hyphen-normalized value for `jobType`, plus
  the raw value in `employmentType` (e.g. `OPEN APPLICATION` emits no
  `jobType` but keeps `employmentType`).
- `compensation` → `compensation` when populated.
- `jobUrl`/`jobUrlDirect`/`applyUrl` = `{origin}/careers/{slug.current}`
  — per-role pages exist (the SPA renders the detail route for each
  slug). The role page is also the apply destination: the site has no
  apply form or external posting link — apply/contact is a mailto/site
  CTA on the role page itself.
- `empty` diagnostics on a missing/empty `result` array;
  `classifyScrapeError` on fetch or parse failure.

## Non-goals

- No headless rendering — the board is a plain JSON API call.
- No `datePosted` or `department` — the schema does not publish them.
- No apply deep-link — applications run through the role page's
  contact/mailto CTA, so `applyUrl` is the role page.
- No pagination — Sanity returns every active job in one response.

## Contracts

- Input: `companyUrl` (unused for routing; the Sanity endpoint is
  fixed), optional `searchTerm`, `location`, `resultsWanted`, `offset`,
  `requestTimeout`, `proxies`, `caCert`.
- Output: `JobResponseDto` of `JobPostDto` rows as above, or a
  `ScrapeDiagnostics` (`empty` / classified error).

## Test plan

- Unit tests against a checked-in Sanity response fixture:
  - parses all jobs with title/location/type;
  - composes `description` from portable-text blocks (paragraphs,
    `- ` bullets, linked spans as `text (href)`);
  - ids derive `zennoastronautics-{slug.current}`;
  - `jobUrl`/`applyUrl` point at the per-role page;
  - `compensation` emitted when present, omitted when null;
  - empty `result` → `empty` diagnostics;
  - fetch failure → `classifyScrapeError` diagnostics;
  - `searchTerm`/`location`/`resultsWanted`/`offset` filtering honored.
