# Spec: 5056 — source-company-reelementtech

| Field | Value |
| --- | --- |
| Spec ID | 5056 |
| Slug | source-company-reelementtech |
| Status | implemented |
| Plugin | `packages/plugins/source-company-reelementtech` |
| Category | `company` (single company — ReElement Technologies / reelementtech.com) |
| Related specs | 5042/5045/5046/5047/5048/5049/5050/5051/5052/5053 (prior company careers plugins) |

## Problem

ReElement Technologies (`reelementtech.com`, rare-earth & critical-minerals processing) hosts its careers page as a **custom Webflow site** with **no ATS** and **no external job board**. The `/careers` page server-renders the open roles as Webflow CMS cards (title + a stated location), and each role is a Webflow CMS collection page at `/jobs/{slug}` that server-renders the title, the stated location, and a rich-text description. Applying is an **on-page Webflow form** on the detail page (no external board, no `mailto:`, no external URL). No adapter existed, so these openings were not ingested.

## Approach

Two-step plain HTTP read (no headless browser — the site is fully server-rendered; `reelementtech.com` 301-redirects to `www.reelementtech.com`, no JS challenge):

1. **GET `/careers`** — enumerate the role cards. Each is an `<a class="job-heading" href="/jobs/{slug}">` (title) with a stated location in the sibling paragraph of the same card. Deduped by slug.
2. **GET each `/jobs/{slug}`** — parse the `.w-richtext` block into the description (the on-page apply form sits outside `.w-richtext`, so it is naturally excluded).

The listing is the source of *which roles are open* and their location; the detail page supplies the *description*. If a detail page can't be fetched/parsed, the role still emits from the listing with a null description (graceful degradation via `Promise.allSettled`).

## Scope

- New single-company plugin `source-company-reelementtech` (`category: 'company'`).
- Map each card to `JobPostDto`:
    - `id` — `reelementtech-<slug>`
    - `title` — the card anchor text (detail `<title>` as fallback)
    - `companyName` — `ReElement Technologies`
    - `jobUrl` / `applyUrl` / `companyUrl` — the `/jobs/{slug}` detail page (the apply form lives there); `companyUrl` is `/careers`
    - `description` — the detail `.w-richtext` block → markdown
    - `location` — the per-card stated location (e.g. `Marion, IN`)
    - `isRemote` — `false` (on-site)
    - `datePosted` — `null` (no date stated anywhere)
    - `compensation` — omitted (no pay stated)
    - `emails` — `[]`

## Non-goals

- No headless browser: the listing and detail pages are server-rendered over plain HTTP.
- No fabricated fields: no salary/date/employmentType is stated, so all are omitted; location is only what each card/detail states — never the `Fishers, IN` corporate-HQ footer address.
- No editorial filtering: every live posting is ingested (the board reflects however many roles are live; it does not assert a fixed count).
- No `jobFunction`: the site exposes no structured role category, and no company plugin synthesizes one.

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.REELEMENTTECH`).
- HTTP goes through the shared `@ever-jobs/common` client; location via `parseLocationList`; description via `markdownConverter`.
- Per-role detail fetches fan out with `Promise.allSettled` (bounded, one request per role).

## Test plan

Fixture-based unit tests over captured careers HTML + role detail pages:

- both live roles enumerated with a `/jobs/` jobUrl and on-page apply URL (== jobUrl)
- identity (`reelementtech-<slug>`, `Site.REELEMENTTECH`, company name), stated `Marion, IN` location, `isRemote=false`, `datePosted=null`, `emails=[]`, no compensation
- description built from the `.w-richtext` block (markdown; excludes the apply form)
- detail unavailable → role still emits from the listing with a null description
- input filters (searchTerm, location, resultsWanted/offset)
- careers page with no cards returns nothing (no throw)
