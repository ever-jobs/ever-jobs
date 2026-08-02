# Spec: 5057 — source-company-flymotion

| Field | Value |
| --- | --- |
| Spec ID | 5057 |
| Slug | source-company-flymotion |
| Status | implemented |
| Plugin | `packages/plugins/source-company-flymotion` |
| Category | `company` (single company — FLYMOTION / flymotionus.com) |
| Related specs | 5042/5045/5046/5047/5048/5049/5050/5051/5052/5053/5056 (prior company careers plugins) |

## Problem

FLYMOTION (`flymotionus.com`, public-safety drone & training) hosts its careers page as a **custom Webflow site** with **no ATS**. `/careers` 301-redirects to `www.flymotionus.com/company/careers`, which server-renders the open roles as Webflow CMS cards (title + a stated location + an employment-type badge). Each role is a Webflow CMS collection page at `/jobs/{slug}` that server-renders the title, labelled detail cards (Job Type, Location, Posted), and a rich-text description. Applying is an **embedded HubSpot form** on the detail page (`share.hsforms.com/...`) — an application-capture widget, not a job board/API, so there is nothing to route to a shared ATS reader. No adapter existed, so these openings were not ingested.

## Approach

Two-step plain HTTP read (no headless browser — the site is fully server-rendered; no JS challenge):

1. **GET `/company/careers`** — enumerate the role cards. Each is a `.careers-job-listing-panel` with an `<a href="/jobs/{slug}">` action, an `<h3>` title, a location badge, and an employment-type detail. Deduped by slug.
2. **GET each `/jobs/{slug}`** — parse the `<h1>` title, the `.w-richtext` block into the description, and the labelled detail cards (Job Type / Location / Posted). The stated pay is lifted from the rich-text `Pay:` section.

The listing is the source of *which roles are open* (plus a location/type fallback); the detail page supplies the *description* and the structured fields. If a detail page can't be fetched/parsed, the role still emits from the listing (title, location, employment type) with a null description (graceful degradation via `Promise.allSettled`).

## Scope

- New single-company plugin `source-company-flymotion` (`category: 'company'`).
- Map each card to `JobPostDto`:
    - `id` — `flymotion-<slug>`
    - `title` — the detail `<h1>` (listing card title as fallback)
    - `companyName` — `FLYMOTION`
    - `jobUrl` / `applyUrl` — the `/jobs/{slug}` detail page (the HubSpot apply form lives there); `companyUrl` is `/company/careers`
    - `description` — the detail `.w-richtext` block → markdown
    - `location` — the per-role stated location (e.g. `Tampa, FL`) via `parseLocationList`
    - `employmentType` / `jobType` — from the stated `Job Type` card (`Full-Time` → `Full-time` / `JobType.FULL_TIME`)
    - `datePosted` — the stated `Posted` card date (null if absent/unparseable)
    - `compensation` — the stated `Pay:` amount via the shared salary parser `salaryToCompensation`, which as of Spec 5058 handles both a range and a single "From $X per year" (→ min-only `CompensationDto`); omitted if none stated
    - `isRemote` — `false` (on-site)
    - `emails` — `[]`

## Non-goals

- No headless browser: the listing and detail pages are server-rendered over plain HTTP.
- No fabricated fields: only fields the site actually states are mapped; location is only what each card/detail states — never the `Tampa, Florida` corporate-HQ footer address (which happens to match here but is not the source of truth).
- No editorial filtering: every live posting is ingested (the board reflects however many roles are live; it does not assert a fixed count).
- No `jobFunction`: the site exposes no structured role category, and no company plugin synthesizes one.
- No HubSpot form submission or form-field scraping: the apply form is the destination, not a data source.

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.FLYMOTION`).
- HTTP goes through the shared `@ever-jobs/common` client; location via `parseLocationList`; description via `markdownConverter`; job type via `getJobTypeFromString`; pay (range or single bound) via `salaryToCompensation` (single-bound support added in Spec 5058).
- Per-role detail fetches fan out with `Promise.allSettled` (bounded, one request per role).

## Test plan

Fixture-based unit tests over captured careers HTML + the role detail page:

- the live role enumerated with a `/jobs/` jobUrl and on-page apply URL (== jobUrl)
- identity (`flymotion-<slug>`, `Site.FLYMOTION`, company name), stated `Tampa, FL` location, `isRemote=false`, `emails=[]`
- structured detail cards mapped: `employmentType=Full-time`, `jobType=[FULL_TIME]`, `datePosted` a 2024 `Date`
- stated pay parsed to a min-only `CompensationDto` (`minAmount=48000`, USD)
- description built from the `.w-richtext` block (markdown)
- detail unavailable → role still emits from the listing with a null description (location/type retained)
- input filters (searchTerm, resultsWanted/offset)
- careers page with no cards returns nothing (no throw)
