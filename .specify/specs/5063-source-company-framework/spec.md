# Spec: 5063 — source-company-framework

| Field | Value |
| --- | --- |
| Spec ID | 5063 |
| Slug | source-company-framework |
| Status | implemented |
| Plugin | `packages/plugins/source-company-framework` |
| Category | `company` (single company — Framework Automation / framework.co) |
| Related specs | 5042/5045/5046/5047/5048/5049/5050/5051/5052/5053/5056/5057/5059/5061/5062 (prior company careers plugins); 5058 (single-bound salary parsing — reused) |

## Problem

Framework Automation (`framework.co`, "building fully automated apparel manufacturing facilities in the United States") hosts its careers page as a **custom Framer site** with **no ATS**. The page is server-side generated (`server: Framer`, `ssg-status: optimized`), so the role text, location, salary, and full job descriptions are all present in the server-rendered HTML. `/hiring` lists open roles, each linking to an on-domain `/jobs/{slug}` detail page. Applying happens through a single on-domain form at `/apply` (a native Framer form with a role dropdown) — there is no per-role apply URL and no third-party ATS or Indeed involvement. No adapter existed, so these openings were not ingested.

Unlike IperionX (Spec 5059, summary-only), Framework publishes a **full JD on its own domain**, so this is a standard two-step careers scraper (like Hylio 5061) — plain HTTP + Cheerio, no headless browser.

## Approach

Plain-HTTP fetch (no headless browser — server-rendered Framer). Two steps, both on `framework.co`:

1. **GET `/hiring`** — enumerate the on-domain `/jobs/{slug}` links, deduped by slug. The Framer listing markup is soup (title/location are not reliably inside the anchor), so enumeration only harvests the slug; the title/location come from the detail page.
2. **GET `/jobs/{slug}`** (bounded fan-out via `Promise.allSettled`) — parse:
    - title — from the document `<title>` (the trailing ` - Framework` suffix stripped); slug-derived title as fallback
    - location — the Framer named container `[data-framer-name="Location"]` (e.g. `Los Angeles, CA`)
    - salary — the Framer named container `[data-framer-name="Salary"]` (e.g. `$150k-$200k+ | Generous Equity`)
    - description — the named rich-text JD sections (`Who we are`, `Life at Frameworks`, `Requirements`) in document order → markdown

## Scope

- New single-company plugin `source-company-framework` (`category: 'company'`).
- Map each role to `JobPostDto`:
    - `id` — `framework-<slug>` (stable on-domain detail slug)
    - `title` — detail `<title>` role name; slug-derived title as fallback
    - `companyName` — `Framework Automation`; `companyUrl` — `/hiring`
    - `jobUrl` — the employer's own on-domain detail page `/jobs/{slug}` (canonical URL)
    - `applyUrl` — the shared on-domain `/apply` form (there is no per-role apply URL)
    - `description` — the detail JD sections → markdown
    - `compensation` — the stated `Salary:` range via `salaryToCompensation` (yearly interval) → min 150000 / max 200000 / USD
    - `location` — `Los Angeles, CA` (stated on the detail page) via `parseLocationList`
    - `isRemote` — `false`
    - `employmentType` / `jobType` — null (not stated on-site)
    - `datePosted` — null; `emails` — `[]`

## Non-goals

- **No Indeed / third-party involvement.** There is no Indeed URL on this surface; applying is a native on-domain Framer form. No off-domain URL is ever fetched (the test seam fails if any non-`framework.co` URL is requested).
- **No generic-email harvesting.** The site footer shows a generic `contact@framework.co` address; it is **not** harvested as a job email — `emails` = `[]`.
- **No fabricated fields.** `employmentType` / `jobType` / `datePosted` are left null (none stated); the HQ is never synthesized (the detail page states the real `Los Angeles, CA` location).
- **No plugin-local salary logic.** The salary range is resolved via the shared `salaryToCompensation` (Spec 5058), not a plugin-local parser. The stated `+` (open-ended marker) and `| Generous Equity` note are not modeled as additional structured compensation — the value is the `$150k-$200k` annual range.

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.FRAMEWORK`).
- HTTP goes through the shared `@ever-jobs/common` client; description via `markdownConverter`; compensation via `salaryToCompensation`; location via `parseLocationList`.
- `Logger` (not `console.log`); a per-role detail failure degrades to the listing-only fields (slug-derived title, on-domain `jobUrl`, `/apply`, null description/location/compensation); a top-level fetch/parse failure returns an empty `JobResponseDto` (no throw).
- Description extraction depends on the CMS collection's rich-text field names (`Who we are` / `Life at Frameworks` / `Requirements`), which are shared across the site's roles. If that template ever changes, the description degrades to null while title / location / salary (parsed independently) still populate.

## Test plan

Fixture-based unit tests over the captured `/hiring` + two `/jobs/{slug}` detail pages (the detail fetch seam throws if any non-`framework.co` URL is requested, proving nothing off-domain is fetched):

- module resolves through NestJS DI; `Site.FRAMEWORK === 'framework'`
- both live roles enumerated and deduped, with `framework-<slug>` id, `Site.FRAMEWORK`, company name, `emails=[]`
- `jobUrl` is the on-domain `/jobs/{slug}` page; `applyUrl` is the shared `/apply` form; `jobUrl` is never an Indeed URL
- `location` is `Los Angeles, CA` (city `Los Angeles` / state `CA`); `isRemote=false`
- stated `$150k-$200k+ | Generous Equity` → yearly compensation, min 150000 / max 200000 / USD (shared helper)
- `employmentType` / `jobType` / `datePosted` remain null
- detail JD sections carried into the description as markdown (About Framework / The Opportunity / Who You Are present)
- graceful degradation when a detail page cannot be fetched (role still emits from the listing with slug title + on-domain jobUrl, null description/location/compensation)
- input filters (searchTerm, offset, resultsWanted); a board with no role links returns nothing (no throw)
