# Spec: 5151

| Field | Value |
| ----- | ----- |
| Spec ID | 5151 |
| Slug | source-company-labs_actor |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Problem statement

Actor (`labs.actor` — robotics/autonomy for heavy equipment; Mountain
View, CA) lists open roles on `https://labs.actor/hiring`. The page is
a ~1 KB React SPA shell; the postings are not rendered into the served
HTML and no recognized ATS serves the board, so it needs a dedicated
company plugin.

## Scope

- New plugin `source-company-labs_actor`,
  `Site.LABS_ACTOR = 'labs_actor'` (the Spec 5069 domain derivation —
  `labs.actor` → `labs_actor`). `companyDomains: ['labs.actor']`
  declared to pre-claim the host.
- The hiring view is a webpack lazy chunk, so job data is reached by
  static fetches only — no headless render:
  1. GET the careers URL → extract `/static/js/main.{hash}.js` from the
     shell.
  2. GET the main bundle → extract the webpack chunk map
     (`{115:"bae9c619",…}[e]+".chunk.js"`) → candidate chunk URLs.
  3. GET chunks until one contains the jobs-array anchor
     (`=[{id:"…",title:"` — other chunks ship their own `[{id:…}]`
     literals such as the machine-spec array `{id:"excavator",name:…}`,
     so the anchor matches the job-entry shape), then parse entries by
     balanced-bracket slicing — the array literal is never evaluated.
- Entries carry `{id, title, team, location, type, summary,
  responsibilities[], requirements[]}` — verified live: 4 roles (GTM &
  Data Partnerships / Growth, Hardware Engineer / Hardware, Machine
  Learning Engineer - Policies / Autonomy, Deployed Software Engineer /
  Field).
- Per entry:
  - `id`/`atsId` = `labs_actor-{entry.id}` (native slugs: `gtm`,
    `hardware`, `ml`, `deployed`).
  - `team` → `department`.
  - `location` ("Mountain View, CA", or "Mountain View, CA · Travel")
    → the `·` tail is a qualifier, stripped before `parseLocationText`.
  - `type` ("Full-time · On-site", "Full-time · Field") →
    `extractJobType` for `jobType`, plus raw `employmentType`.
  - `description` composed from `summary` + `responsibilities` (site
    heading "What you will do") + `requirements` ("What we are looking
    for").
  - `jobUrl`/`jobUrlDirect` = the careers page — roles expand inline,
    no per-role pages exist.
  - `applyUrl` = the site's own per-role mailto:
    `lane@labs.actor` for teams Hardware/Growth,
    `shashi@labs.actor` otherwise, subject `"{title} — application"`.

## Non-goals

- No headless/browser rendering; the bundle data is complete.
- No `datePosted`, `compensation`, or per-role detail URLs — the site
  publishes none.
- No follow-through to the mailto target.

## Contracts

- `IScraper.scrape(ScraperInputDto) → JobResponseDto`.
- No chunk containing a jobs array → `JobResponseDto([])` with an
  `empty` diagnostic.

## Test plan

- Unit spec over a fixture slice of the real `848` chunk: entry count,
  field mapping, id shape, department/location/type mapping,
  description composition, per-team apply mailto routing, empty/
  invalid payload diagnostics, `searchTerm`/`location`/`resultsWanted`
  filters.
