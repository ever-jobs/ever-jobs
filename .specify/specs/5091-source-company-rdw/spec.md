# Spec: 5091 — Source Company Plugin: RDW (Redwire Corporation)

| Field          | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Spec ID        | 5091                                                    |
| Slug           | source-company-rdw                                      |
| Status         | in progress                                             |
| Owner          | agent                                                   |
| Created        | 2026-08-30                                              |
| Last updated   | 2026-08-30                                              |

## Problem

Redwire Corporation (`rdw.com`, legacy `redwirespace.com`) hosts jobs on `careers.rdw.com` using Clinch Talent / Rails + Stimulus. The site is server-rendered with JSON-LD `JobPosting` detail pages and is protected by AWS WAF (raw HTTP rejected), so it needs a headless-browser company plugin. The board is not a recognized ATS and therefore falls through `find-company-ats` as `needs company plugin`.

## Goals

Add `source-company-rdw` to ingest Redwire jobs via `BrowserPool` and map them to `JobPostDto`.

## Non-goals

- Handle `careers.edgeautonomy.io` off-domain board (out of scope).
- Convert descriptions to anything other than markdown.
- Generic Clinch Talent support.

## Contract

- `ScraperInputDto` support:
  - `companyDomain: ['rdw.com']` or `['redwirespace.com']` resolves to `Site.RDW`.
  - `companyUrl` can override the start URL.
  - `resultsWanted`, `offset`, `searchTerm`, `location`, `isRemote`, `jobType` filters apply post-scrape using existing helpers.
- Output: `JobResponseDto` with `jobs`, `total` count, and standard diagnostics on errors.
- `id` stable: `rdw-<requisitionId>` or `rdw-<clinchUuid>` fallback.
- `companyName`: `Redwire Corporation`.
- `companyDomains: ['rdw.com', 'redwirespace.com']` declared in plugin metadata so both canonical and legacy domains resolve.

## Data mapping

Search page (`https://careers.rdw.com/jobs/search?page=N`):
- Pagination: `nav[aria-label="Pagination"] a[href^="/jobs/search?page="]`.
- Job cards: `article.col-12.job-search-results-card-col`.
  - Title & detail URL: `h3.card-title.job-search-results-card-title a`.
  - Requisition ID: `.job-component-requisition-identifier span`.
  - Workplace type: `.job-component-workplace-type span` (text `Remote`/`Hybrid`/`On Site`, `data-value` `remote`/`hybrid`/`on_site`).
  - Location: `.job-component-location span`.
  - Department: `.job-component-department span`.
  - Summary: `p.job-search-results-summary`.

Detail page JSON-LD (`script[type="application/ld+json"] @type JobPosting`):
- `title`, `description` (HTML), `datePosted`, `validThrough`, `employmentType`, `hiringOrganization.logo`.
- `identifier.value` (Clinch UUID).
- `jobLocation[].address` with `addressLocality`, `addressRegion` (full US state names or `Remote`), `postalCode`, `addressCountry` (two-letter code).

Title prefix normalization:
- `Temporary ` -> `JobType.TEMPORARY`.
- `Contract - ` / `Contractor, ` / `Contractor – ` -> `JobType.CONTRACT`.
- `Intern – ` / `Internship ` -> `JobType.INTERNSHIP`.
- `Hybrid, ` / `Remote, ` / `On Site, ` -> `workFromHomeType`, with `isRemote` only when prefix or card data is `Remote`.
- Strip prefix with `^(Contractor|Contract|Temporary|Internship|Intern|Hybrid|Remote|On[- ]?Site)\s*[,–—-]\s+`.

Location normalization:
- `addressCountry` maps to `Country` enum when available.
- Remote: `addressRegion === 'Remote'` with empty `addressLocality` sets `isRemote: true` and country from `addressCountry`.
- US: convert full state name in `addressRegion` to two-letter code via `getStateCode`; `addressLocality` -> city.
- Non-US: `addressLocality` + `addressCountry`.

## Risks & mitigations

- WAF blocks raw HTTP: use `BrowserPool.getPage({ proxy, stealth: true, headful: true })`.
- Detail pages are slow to fetch: sequential `page.goto` per detail to avoid rate limiting.
- `employmentType` JSON-LD always `FULL_TIME`: derive `jobType` and `workFromHomeType` from title and card `workplace-type` instead.
- Detail page may have slug-only URL without UUID: fallback to requisition id for `id`.

## Test plan

- Fixture-based Jest unit tests for:
  - Search page pagination and card extraction.
  - Detail page JSON-LD parsing.
  - Title prefix normalization (contractor, temporary, intern, hybrid, remote, on-site).
  - US and non-US location mapping; remote handling.
  - Error classification on `BrowserPool` failure.

## References

- `source-company-terminusindustrials` for Cheerio parsing pattern.
- `source-company-truemetalsupply` for `BrowserPool` usage.
- `JobPostDto`, `LocationDto`, `getJobTypeFromString`, `parseLocationList`, `decodeHtmlEntities`, `markdownConverter` in `@ever-jobs/common`.
