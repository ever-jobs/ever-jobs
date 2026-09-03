# Spec: 5092 — Source Company Plugin: Trossen Robotics

| Field          | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Spec ID        | 5092                                                    |
| Slug           | source-company-trossenrobotics                          |
| Status         | in progress                                             |
| Owner          | agent                                                   |
| Created        | 2026-08-30                                              |
| Last updated   | 2026-08-30                                              |

## Problem

Trossen Robotics (`trossenrobotics.com`) hosts careers on a custom Wix site at `https://www.trossenrobotics.com/careers`. The list page and each `/careers/<slug>` detail page are client-side rendered; the static HTML contains only the Wix bootstrap and no recognizable ATS or JSON-LD `JobPosting` schema, so the source falls through generic detection as `needs company plugin`.

## Goals

Add `source-company-trossenrobotics` to ingest Trossen Robotics jobs via the shared `BrowserPool` headless browser and map them to `JobPostDto`.

## Non-goals

- Generic Wix careers-page support.
- Handling domains other than `trossenrobotics.com` / `www.trossenrobotics.com`.
- Synthesizing fields not present on the page (e.g. a city/state for onsite roles where none is shown).

## Contract

- `ScraperInputDto` support:
  - `companyDomain: ['trossenrobotics.com']` resolves to `Site.TROSSENROBOTICS`.
  - `companyUrl` may override the start URL.
  - `resultsWanted`, `offset`, `searchTerm`, `isRemote`, `jobType` filters apply post-scrape.
- Output: `JobResponseDto` with `jobs`, `total` count, and standard diagnostics on errors.
- `id` stable: `trossenrobotics-<slug>`.
- `companyName`: `Trossen Robotics`.
- `companyDomains: ['trossenrobotics.com', 'www.trossenrobotics.com']`.

## Data mapping

Careers list page (`https://www.trossenrobotics.com/careers`):
- Rendered DOM: a `main` element containing `section.wixui-section` job cards.
- Each card contains:
  - `h2` with the role title.
  - A `p`/`div`/`span` with metadata in the form `date | employment type | workplace type`.
  - An `a[aria-label="Learn More and Apply"]` whose `href` is `/careers/<slug>`.
- Cards without the `Learn More and Apply` link are ignored.

Detail page (`/careers/<slug>`):
- First `main section` holds the rendered `h1` title and `Full Time | Onsite` metadata.
- The next `main section` holds the date (`Date: MM/DD/YY` or `Ongoing`), compensation/summary text, and the full job description rendered as paragraphs and `ul` lists.
- The embedded application form is stripped before markdown conversion.

Metadata parsing:
- `datePosted`: parsed from a leading `MM/DD/YY` token; `Ongoing` or missing date yields `null`.
- `employmentType`: raw token(s) such as `Full Time`, `Full Time & Part Time`; split on `|`, `&`, `/`, `,` and normalized through `getJobTypeFromString` into `jobType`.
- `workplaceType`: `Remote`, `Hybrid`, or `Onsite`; sets `isRemote` and `workFromHomeType`.
- `description`: the cleaned detail-section inner HTML converted to markdown with `markdownConverter`.

## Risks & mitigations

- Content only renders after JavaScript: use `BrowserPool.getPage({ proxy, stealth: true, headful: true })` and wait for `main section a[aria-label="Learn More and Apply"]` on the list page and `main section` on the detail page.
- No per-role location is published; onsite roles leave `location` unset rather than fabricating one.
- Application form DOM is mixed into the description section; remove `form`, `iframe`, `script`, `style`, and the exact `Apply now.` marker before markdown conversion.

## Test plan

Fixture-based Jest unit tests for:
- List-page card extraction (title, detail URL, date, employment type, workplace type).
- Detail-page description extraction and markdown conversion.
- Fallback when `datePosted` or employment-type metadata is absent.
- `ScraperInputDto` filters (`searchTerm`, `isRemote`, `jobType`, `resultsWanted`, `offset`).
