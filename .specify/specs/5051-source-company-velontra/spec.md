# Spec: 5051 — source-company-velontra

| Field | Value |
| --- | --- |
| Spec ID | 5051 |
| Slug | source-company-velontra |
| Status | implemented |
| Plugin | `packages/plugins/source-company-velontra` |
| Category | `company` (single company — Velontra / velontra.com) |
| Related specs | 5042/5045/5046/5047/5048/5049/5050 (prior company careers plugins) |

## Problem

Velontra (`velontra.com`) hosts its careers page on **WordPress (Beaver Builder)** with **no ATS**. Every open role lives inline on `/careers/` inside collapsible accordion items — each item's panel holds the full Description / Responsibilities / Qualifications prose. Applying goes through a **single shared application form** at `/apply/` (a WPForms form with a role dropdown). No adapter existed, so these openings were not ingested.

The page is **server-rendered plain HTML** (HTTP 200, no Cloudflare, no JS challenge), so the roles are readable with a plain HTTP GET + Cheerio — no headless browser. There is no per-role page, no PDF, and no per-role apply URL.

## Scope

- New single-company plugin `source-company-velontra` (`category: 'company'`).
- Fetch `/careers/`; parse the accordion items into roles.
- Map to `JobPostDto`:
    - `id` — `velontra-<title-slug>`
    - `title` — the accordion button label
    - `companyName` — `Velontra`
    - `jobUrl` — the careers page (all roles live on the one page)
    - `description` — the accordion panel prose rendered to markdown (leading "Job Title: …" heading dropped)
    - `applyUrl` — `/apply/` (the shared form)
    - `location` — `null`
    - `emails` — `[]`
    - `datePosted` — `null`

## Non-goals

- No location: the roles state none. The site's footer HQ (`Cincinnati, OH`) is site-wide, not a per-role location, so it is not asserted onto roles.
- No compensation / `employmentType` / `jobType`: not stated.
- No per-role apply URL or email: the site exposes only one shared form.
- No headless browser: the listing is server-rendered.

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.VELONTRA`).
- All HTTP goes through the shared `@ever-jobs/common` client; body → markdown via the shared `markdownConverter`.

## Test plan

Fixture-based unit tests over captured careers HTML:

- four accordion roles parsed with the expected titles
- identity/shared-apply/null-location/null-date mapping
- panel prose → description with the "Job Title:" heading dropped
- input filters (searchTerm, resultsWanted)
- empty page returns no roles (no throw)
