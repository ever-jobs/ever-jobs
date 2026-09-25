# Spec: 5142

| Field | Value |
| ----- | ----- |
| Spec ID | 5142 |
| Slug | source-company-mundane_co |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Problem statement

Mundane Systems (`mundane.co`, humanoid robotics — Palo Alto) hosts its careers
list at `https://mundane.co/join-us`, a ~3 KB React SPA shell with no job HTML.
The job list is embedded as a literal array in the site's JS bundle
(`/assets/index-{hash}.js`, ~1 MB): entries of shape
`{title, category, location, url}` — 10 today. Apply URLs split between Airtable
shared forms (`airtable.com/app{id}/pag{id}/form`) and LinkedIn job posts. No
recognized ATS serves the board, so it needs a dedicated company plugin.

## Scope

- New plugin `source-company-mundane_co`, `Site.MUNDANE_CO = 'mundane_co'`
  (the Spec 5069 domain derivation — `.co` is not stripped, dots →
  underscores). `companyDomains: ['mundane.co']` declared to pre-claim the
  host.
- Two plain-HTTP fetches via `createHttpClient`: the `/join-us` shell, then
  the `/assets/index-*.js` bundle it references.
- Job extraction by **entry shape** — the minified array identifier changes
  each deploy, so entries are matched as
  `{title:"…",category:"…",location:"…",url:"…"}` literals whose `url` points
  at `airtable.com` or `linkedin.com/jobs`.
- Descriptions from the **Airtable shared forms** (verified: forms are
  client-rendered via Airtable's hyperbase SPA; no data in the shell HTML):
  each Airtable apply URL is rendered via `BrowserPool` and the form
  description block extracted. LinkedIn URLs are never fetched.
- Idempotence / ordering identical to `source-company-power_us`: no fetch of
  detail pages beyond the apply form itself; `empty` diagnostics on zero
  jobs; `resultsWanted`/`searchTerm`/`location`/`offset` honored.

## Non-goals

- No LinkedIn scraping (auth-gated) — LinkedIn-linked jobs ship without
  descriptions.
- No guessing at Airtable's internal hyperbase API — the shared-form page is
  rendered like a user would see it.
- No `datePosted` / `compensation` — the site publishes neither.

## Contracts

- Input: `ScraperInputDto` (`siteType: ['mundane_co']` or
  `companyDomain: 'mundane.co'`; `companyUrl` unused — the careers URL is
  fixed). `proxies` honored for both HTTP and browser fetches.
- Output: `JobPostDto[]` with
  - `id`/`atsId` = `mundane_co-{linkedinJobId | airtableFormId | slug-title}`
  - `title`, `companyName='Mundane'`, `department` from `category`,
    `location` via `parseLocationText`, `jobType` null (not published)
  - `jobUrl`/`jobUrlDirect`/`applyLink` = entry URL (LinkedIn tracking
    params stripped)
  - `description` = Airtable form description when the apply link is an
    Airtable form and the render succeeds; absent otherwise
- Errors: `ScrapeDiagnostics` — `empty` when the shell/bundle yields no
  entries, `blocked`/`timeout`/`http_error` via `classifyScrapeError`.

## Test plan

- Unit (fixture bundle slice + mocked `BrowserPool` page): 10-job mapping,
  LinkedIn id + Airtable pagId + slug fallbacks, description extraction for
  Airtable jobs and absence for LinkedIn jobs, render-failure fallback (job
  still emitted), `empty` diagnostics, `resultsWanted`/`searchTerm`/
  `location` filtering, LinkedIn query-stripping.
- `npx jest source-company-mundane_co`, `npx tsc --project
  tsconfig.typecheck.json --noEmit`, `npm run lint:docs`.
