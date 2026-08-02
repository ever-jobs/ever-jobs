# Spec: 5020 — Paylocity board-page scrape (replace dead feed API) + detail-fetch overlay, full field mappings

| Field | Value |
| --- | --- |
| Spec ID | 5020 |
| Slug | paylocity-board-page-scrape |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-23 |
| Last updated | 2026-06-23 |
| Related specs | 5004, 5014, 5015, 5016, 5018, 5019 |

## Problem

The `source-ats-paylocity` plugin had never been run against a live company. A
harvest of 5 real Paylocity boards discovered via careers-page links
(sendcutsend.com 7 jobs, fermiamerica.com / Fermi-LLC 18, shinefusion.com /
SHINE-Medical-Technologies 44 + Shine-Spect-LLC 4, blacksea.tech / Maritime
Applied Physics 17) exposed that the plugin's only data source is **broken**:

1. **The feed endpoint returns 5xx/4xx for every company.** The plugin fetched
   `GET /recruiting/api/feed/jobs/{companySlug}` and expected a JSON array. With
   the company **GUID** (the identifier present in the public careers-page link,
   e.g. `add565e9-4cee-4334-8182-9de221ffb9e4`) it returns **HTTP 500**; with the
   numeric **ModuleId** (`42173`) it returns **HTTP 400 "request is invalid"**.
   Every URL/param/casing variant tried (`feed/jobs/{moduleId}`,
   `feed/jobs?company={guid}`, `feed/jobs/{guid}?moduleId=…`) failed. The
   live board page itself never calls `/api/feed/` — there is no XHR and no
   `apiKey` reference in the HTML — so the feed is a separate syndication
   endpoint that is disabled or partner-key-gated. As-is, the plugin returns
   **0 jobs for every real company**.
2. **Even if the feed worked, the field shape was wrong.** The `PaylocityJob`
   type read `City`/`State`/`Country`/`PostedDate`/`Department`/`JobType` flat
   off each job, but the actual job objects nest location under `JobLocation`
   and name fields differently (`JobTitle`, `HiringDepartment`, `PublishedDate`,
   `IsRemote`).

The reliable, server-rendered source is the **board HTML page**, keyed by the
**GUID** (exactly what the careers-page link provides).

## Findings — where the data actually lives

- **Board page** `GET /recruiting/jobs/All/{GUID}` (200; label segment optional)
  → `window.pageData` (server-rendered JSON):
  - `ModuleTitle` — company name (e.g. `Fermi LLC`).
  - `Jobs[]` — each: `JobId`, `JobTitle`, `LocationName`, `PublishedDate`
    (ISO w/ offset), `HiringDepartment`, `IsRemote` (bool), `IndeedRemoteType`
    (1 = remote, 2 = on-site on observed data), and nested
    `JobLocation { City, State, Zip, Country, … }`.
  - **`Description` is empty `""` in the list payload** — must come from detail.
- **Detail page** `GET /recruiting/jobs/Details/{JobId}/{GUID}` (200; both
  segments required — JobId alone 500s) → HTML body with
  `<div class="job-listing-header">LABEL</div><div>VALUE</div>` blocks:
  - `Job Type` → employment type text (e.g. `Full-time`); absent on some jobs.
  - `Description` (+ optional `Requirements` etc.) → full posting HTML.
  - Free-text pay appears in the description for hourly roles
    (e.g. sendcutsend `$22.00 - $40.00`).

## Scope

Rework the plugin to scrape the board page and overlay per-job detail, following
the detail-fetch-overlay pattern of BambooHR/Workable/BreezyHR (Specs 5014–5016)
and the shared compensation helper (Specs 5018–5019).

- **`companySlug` = the company GUID** (unchanged field, corrected meaning;
  documented). Empty slug → empty result (unchanged).
- **Board fetch + parse.** `GET /recruiting/jobs/All/{GUID}`; extract
  `window.pageData` via a string-aware brace matcher (descriptions can contain
  braces); read `ModuleTitle` + `Jobs[]`. Empty/unparseable page → `[]`
  (fail-safe, logged).
- **Detail-fetch overlay.** For the `resultsWanted` slice, fetch each job's
  `/recruiting/jobs/Details/{JobId}/{GUID}` under bounded concurrency
  (`PAYLOCITY_DETAIL_CONCURRENCY = 5`, `Promise.allSettled`); parse the
  `job-listing-header` sections for description + Job Type. A failed/empty
  detail yields `null` so the job still maps from the list (fail-safe).
- **Field mappings (maximize info per the "gaps in every ATS" review):**
  - `title` ← `JobTitle`; `companyName` ← `ModuleTitle` (fallback slug).
  - `location` ← `JobLocation` (`city`, `state`, `country`; `Remote` city when
    remote and no city) — mirrors other ATS location shape.
  - `isRemote` ← `IsRemote` (OR `IndeedRemoteType === 1`).
  - `workFromHomeType` ← `Remote` when remote; `Hybrid` when the location/name
    text says hybrid. Omitted otherwise.
  - `department` ← `HiringDepartment`.
  - `datePosted` ← `PublishedDate` → `YYYY-MM-DD`.
  - `description` ← detail Description (+ Requirements/other sections), rendered
    per `descriptionFormat` (HTML passthrough / `htmlToPlainText` /
    `markdownConverter` default).
  - `jobType` ← `getJobTypeFromString(Job Type)`; `employmentType` ← label text.
  - `compensation` ← shared `resolveCompensation({ structured: null, text:
    description })` — structured-first contract preserved for future, text
    fallback catches in-description ranges (sendcutsend `$22–$40/hr`); `null`
    when none (fermi).
  - `emails` ← `extractEmails(description)`.
  - `jobUrl` ← the detail URL; `atsId` ← `JobId`; `atsType` ← `paylocity`;
    `site` ← `Site.PAYLOCITY`; `id` ← `paylocity-{JobId}`.
- **Types.** Replace the feed-shaped `PaylocityJob` with `PaylocityPageData`,
  `PaylocityListJob`, `PaylocityJobLocation`, and a parsed `PaylocityJobDetail`.
- **Constants.** Replace `PAYLOCITY_API_BASE` (feed) with
  `PAYLOCITY_BASE` + board/detail URL builders; keep `PAYLOCITY_HEADERS`.

## Non-goals

- **No attempt to revive the feed API.** It is disabled/partner-gated; the board
  page is the supported public path. (Recorded in `docs/questions.md`.)
- **No `companySlug` auto-discovery.** The GUID is supplied by the caller (the
  upstream detector extracts it from the careers-page link). Out of scope here.
- **No change to other ATS plugins.**

## Contracts

| Input | title | company | location | description | jobType/employmentType | compensation | isRemote |
| --- | --- | --- | --- | --- | --- | --- | --- |
| board job + detail OK | `JobTitle` | `ModuleTitle` | `JobLocation` city/state/country | detail body (per format) | from detail `Job Type` | text fallback on description | `IsRemote`/`IndeedRemoteType` |
| detail fetch fails | `JobTitle` | `ModuleTitle` | list `JobLocation` | null | null/omitted | omitted | from list |
| remote job, no city | — | — | city `Remote` | — | — | — | true, `workFromHomeType=Remote` |
| board unparseable / empty slug | — | — | — | — | — | — | — (returns `[]`) |

## Test plan

Fixture-driven unit tests (mocked HTTP, no network) using the 4 real captured
pages committed under `__tests__/fixtures/`:

- **sendcutsend board (7 jobs)** → 7 mapped; company name contains `SendCutSend`; titles
  match; with detail overlay, the Production Technician job gets a non-null
  description and `compensation` `$22–$40` hourly via the text fallback.
- **fermi board (18 jobs)** → 18 mapped; company `Fermi LLC`; the Corporate Tax
  Director job: location `Dallas, TX, USA`, `department = Finance`,
  `employmentType = Full-time`, `jobType = [fulltime]`, `compensation = null`
  (no range in description), `isRemote = false`; the one remote job →
  `isRemote = true`, `workFromHomeType = Remote`.
- **detail fetch failure** → job still maps from the list, `description = null`.
- **empty companySlug** → `[]`. **`resultsWanted`** caps both job count and the
  number of detail fetches.
