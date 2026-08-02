# Spec: 5053 — source-company-galadyne

| Field | Value |
| --- | --- |
| Spec ID | 5053 |
| Slug | source-company-galadyne |
| Status | implemented |
| Plugin | `packages/plugins/source-company-galadyne` |
| Category | `company` (single company — Galadyne / galadyne.io) |
| Related specs | 5042/5045/5046/5047/5048/5049/5050/5051/5052 (prior company careers plugins) |

## Problem

Galadyne (`galadyne.io`) hosts its careers page as a **Next.js app (Vercel)** with **no ATS**. The `/careers` page server-renders the opening cards (title + a stated location), but the **full job descriptions are not in the server HTML** — they are rendered client-side into an on-page overlay from a hashed Next.js chunk (`.../app/careers/page-<hash>.js`). Applying is an on-page form that POSTs to Galadyne's own `/api/careers` endpoint (no external board, no `mailto:`, no per-role URL). No adapter existed, so these openings were not ingested.

## Approach

Two-step plain HTTP read (no headless browser):

1. **GET `/careers`** — enumerate the opening cards (each an `<h2>` title with a location `<span>`), AND read the current chunk URL straight from the page so the content hash **self-heals** across deploys.
2. **GET the chunk** — extract the authoritative role → description map.

The chunk stores the data as a plain object literal keyed by role title, each entry carrying `intro` / `responsibilities` / `qualifications` / `closing`. The parse anchors on the `"<title>":{intro:"` boundary and reads each field by its **unmangled** property name — not on any minified variable name, hashed CSS class, or the chunk filename. This is the authoritative source of the JD (the overlay DOM is a derived view of the same object), so parsing it directly avoids a browser round-trip.

The listing is the source of *which roles are open*; the chunk supplies the *description*. If the chunk can't be fetched/parsed, roles still emit from the listing with a null description (graceful degradation).

## Scope

- New single-company plugin `source-company-galadyne` (`category: 'company'`).
- Map each card to `JobPostDto`:
    - `id` — `galadyne-<slug>`
    - `title` — the card `<h2>` text
    - `companyName` — `Galadyne`
    - `jobUrl` / `applyUrl` / `companyUrl` — the `/careers` page (the overlay form lives there)
    - `description` — the chunk content → markdown (intro, **Responsibilities** bullets, **Qualifications** bullets, closing)
    - `location` — the per-card stated location (e.g. `Austin, TX`)
    - `isRemote` — `false` (on-site)
    - `datePosted` — `null` (no date stated anywhere)
    - `compensation` — omitted (no pay stated)
    - `emails` — `[]`

## Non-goals

- No headless browser: the listing is server-rendered and the JD lives in a fetchable chunk.
- No fabricated fields: no salary/date is stated, so both are omitted; location is only what each card shows.
- No editorial filtering: every posting is ingested, including "General Internship Application" (it carries a real JD and behaves like a role).

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.GALADYNE`).
- HTTP goes through the shared `@ever-jobs/common` client; location via `parseLocationList`.

## Test plan

Fixture-based unit tests over captured careers HTML + client chunk:

- all five postings enumerated (incl. the general internship)
- identity / stated location / on-page apply mapping
- JD description built from the chunk (Responsibilities/Qualifications, slug with parentheses normalized)
- chunk unavailable → roles still emit from the listing with null description
- input filters (searchTerm, resultsWanted)
- listing with no cards returns nothing (no throw)
