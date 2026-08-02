# Spec: 5065 — source-company-mara

| Field | Value |
| --- | --- |
| Spec ID | 5065 |
| Slug | source-company-mara |
| Status | implemented |
| Plugin | `packages/plugins/source-company-mara` |
| Category | `company` (single company — Mara Defense / mara.inc) |
| Related specs | 5042/5045/5046/5047/5048/5049/5050/5051/5052/5053/5056/5057/5059/5061/5062/5063/5064 (prior company careers plugins) |

## Problem

Mara Defense (`mara.inc`) hosts its careers page as a **custom Webflow site** with **no ATS**. The openings are server-rendered in the static `/career` HTML, so the role title, highlight qualifier, location, and employment type are all present in the page HTML. Each opening is an inline card with an "apply now" button that links to **LinkedIn**; there is no on-domain per-role page, no salary, no job description, and no posted date. The page's JSON-LD is only `WebPage`/`BreadcrumbList` (no `JobPosting` data). No adapter existed, so these openings were not ingested.

Like Terminus (Spec 5064) this is a **single-step** scrape — plain HTTP + Cheerio, no headless browser and no detail fan-out.

## Approach

Plain-HTTP fetch of `/career` (server-rendered Webflow — no headless browser). Each opening is a `.mr-job-content-box` card with human-authored (stable) Webflow class names. Per card:

- title — the large `.mr-h4` heading; the small highlight chip (`.label-transparant`) is appended in parentheses **only when it is not already contained in the title** (e.g. `Wargamer` + `Robotics Simulation Engineer` → `Wargamer (Robotics Simulation Engineer)`; but `Bitcaster (Embedded Systems / Electrical)` + `Bitcaster` → unchanged)
- location / employment type — the two `.label-location` chips classified by shape (a chip recognised as a job type is the employment type; the other is the location) — order is not assumed
- apply — the card's LinkedIn URL (`a[href*="linkedin.com/jobs"]`)

The board template also renders a placeholder card whose apply button points at `#`; only cards that carry a real LinkedIn apply URL are ingested.

## Scope

- New single-company plugin `source-company-mara` (`category: 'company'`).
- Map each opening to `JobPostDto`:
    - `id` — `mara-<slug>` where `<slug>` is derived from the (possibly qualifier-appended) title (the site exposes no per-role URL slug to reuse)
    - `title` — the large title, with the highlight qualifier appended in parens when not already present
    - `companyName` — `Mara Defense`; `companyUrl` — `/career`
    - `jobUrl` — `''` (no on-domain per-role page)
    - `applyUrl` — the card's LinkedIn URL (linked, never fetched)
    - `location` — the stated city (`San Francisco`) via `parseLocationList`
    - `employmentType` — the stated `Full Time`; `jobType` — via `getJobTypeFromString` → `FULL_TIME`
    - `isRemote` — `false`
    - `datePosted` — null; `emails` — `[]`; `description` / `compensation` — omitted (none stated)

## Non-goals

- **No LinkedIn (or any off-domain) fetching.** The apply link points at LinkedIn; it is carried on `applyUrl` but never requested/probed/harvested.
- **No fabricated fields.** `description` / `compensation` / `datePosted` are left empty (none stated). The location comes only from the stated card value; no state is synthesized (the site states city only).
- **No placeholder ingestion.** The Webflow template card (apply `href="#"`) is skipped — only cards with a real LinkedIn apply URL are emitted.
- **No email harvesting.** No address is exposed; `emails` = `[]`.

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.MARA`).
- HTTP goes through the shared `@ever-jobs/common` client; location via `parseLocationList`; job type via `getJobTypeFromString`.
- `Logger` (not `console.log`); a top-level fetch/parse failure returns an empty `JobResponseDto` (no throw); a careers page with no openings returns an empty result (no throw).
- Selectors depend on the Webflow `.mr-job-content-box` / `.mr-h4` / `.label-*` classes. If the site is redesigned and those classes change, enumeration degrades to empty (no throw) rather than emitting wrong data.

## Test plan

Fixture-based unit tests over the captured `/career` page (the fetch seam substitutes the captured HTML):

- module resolves through NestJS DI; `Site.MARA === 'mara'`
- only the two real openings are ingested; the placeholder card (`Senior AI engineer`, apply `#`) is skipped
- the highlight chip is appended only when not already in the title (Wargamer appended; Bitcaster not duplicated)
- title-derived `id`, `jobUrl=''`, LinkedIn `applyUrl`, never an Indeed URL
- `location` city `San Francisco` with no fabricated state; `isRemote=false`
- `employmentType` `Full Time` → `jobType=[FULL_TIME]`
- `compensation` / `description` / `datePosted` / `emails` empty
- input filters (searchTerm, offset, resultsWanted); a careers page with no openings returns nothing (no throw)
