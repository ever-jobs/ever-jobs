# Spec: 5143

| Field | Value |
| ----- | ----- |
| Spec ID | 5143 |
| Slug | source-company-getmaxspace |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Problem statement

Max Space (`getmaxspace.com`, expandable space-habitat structures — Rockledge,
FL) lists open roles on `https://www.getmaxspace.com/careers`, a Webflow CMS
collection rendered server-side. Five roles today, each linking to an Indeed
posting (`indeed.com/job/{slug}-{hex}` or `indeed.com/viewjob?jk={hex}`). No
recognized ATS serves the board, so it needs a dedicated company plugin.

## Scope

- New plugin `source-company-getmaxspace`, `Site.GETMAXSPACE =
  'getmaxspace'` (the Spec 5069 domain derivation). `companyDomains:
  ['getmaxspace.com']` declared to pre-claim the host.
- One plain-HTTP GET of the careers URL via `createHttpClient` — the
  collection items are in the static HTML (no pagination, no client-side
  job loading).
- Each `a.career-jobs_cms-link` block carries 5
  `career-jobs_list-title is-N` columns: `is-1` title, `is-2` department,
  `is-3` employment type ("Permanent"), `is-4` location. `is-5` is a
  decorative arrow icon — ignored.
- `jobUrl`/`jobUrlDirect` = the Indeed href, `&amp;` entity decoded.
- `id`/`atsId` = `getmaxspace-{hex}` where hex is the trailing id of the
  `/job/{slug}-{hex}` path or the `jk` param of `viewjob`; slug-from-title
  fallback.
- `empty` diagnostics on zero items; `classifyScrapeError` on fetch
  failure; `resultsWanted`/`searchTerm`/`location`/`offset` honored.

## Non-goals

- No Indeed fetches (also fetch-hostile) — postings ship without
  descriptions, `datePosted`, or `compensation`.
- No fetching of `viewjob` or `/job/` pages for detail.

## Contracts

- Input: `siteType: ['getmaxspace']` or `companyDomain: 'getmaxspace.com'`;
  `companyUrl` may override the careers URL.
- Output: `JobPostDto[]` — title, `companyName='Max Space'`,
  `department` (Engineering, Business Development), `employmentType`
  ("Permanent"), `location` via `parseLocationText`, `jobType` null
  (the site does not publish standard type labels), `jobUrl`/`jobUrlDirect`
  = Indeed link.

## Test plan

- Unit (static HTML fixture from the live page): 5-job mapping, `/job/`
  hex-id + `jk=` + slug fallbacks, `&amp;` decoding, `empty`, fetch
  failure, `resultsWanted`/`searchTerm`/`location`.
- `npx jest source-company-getmaxspace`, `npx tsc --project
  tsconfig.typecheck.json --noEmit`, `npm run lint:docs`.
