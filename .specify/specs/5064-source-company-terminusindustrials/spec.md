# Spec: 5064 — source-company-terminusindustrials

| Field | Value |
| --- | --- |
| Spec ID | 5064 |
| Slug | source-company-terminusindustrials |
| Status | implemented |
| Plugin | `packages/plugins/source-company-terminusindustrials` |
| Category | `company` (single company — Terminus Industrials / terminusindustrials.com) |
| Related specs | 5042/5045/5046/5047/5048/5049/5050/5051/5052/5053/5056/5057/5059/5061/5062/5063 (prior company careers plugins) |

## Problem

Terminus Industrials (`terminusindustrials.com`, a defense-grade advanced manufacturer of large power transformers) hosts its careers page as a **custom Next.js site** (Vercel + Cloudflare) with **no ATS**. The page is server-rendered (SSR), so the role title, department, location, employment type, and full job description are all present in the server-rendered HTML of `/careers`. Each role is an inline card — there is no per-role detail route; the full JD is rendered inline (also offered as an on-domain PDF), and applying happens through an on-page modal form (Name/Email/Phone/About). There is no third-party ATS or Indeed involvement. No adapter existed, so these openings were not ingested.

Unlike Framework (Spec 5063, two-step Framer) this is a **single-step** scrape: everything is on one `/careers` page — plain HTTP + Cheerio, no headless browser and no detail fan-out.

## Approach

Plain-HTTP fetch of `/careers` (no headless browser — server-rendered Next.js). Each role is a `Careers_card__*` block. CSS-module class names are hashed (`Careers_card__cQ1y`), but the `Careers_<name>__` prefix is stable across builds, so selectors match on that prefix via `[class*="Careers_<name>__"]`. Per card:

- title — the `Careers_cardTitle__*` heading (includes the qualifier, e.g. `(Large Power Transformers)`)
- meta row — the `Careers_metaItem__*` chips classified by shape (a `City, ST` chip is the location; a job-type chip is the employment type; the remaining chip is the department) — order is not assumed
- description — the inline JD sections `Careers_section__*` (Job Summary / Key Responsibilities / Desired Qualifications) in document order → markdown; falls back to the whole dropdown body

## Scope

- New single-company plugin `source-company-terminusindustrials` (`category: 'company'`).
- Map each role to `JobPostDto`:
    - `id` — `terminusindustrials-<slug>` where `<slug>` is derived from the title (the site exposes no per-role URL slug to reuse)
    - `title` — the card title (with qualifier)
    - `companyName` — `Terminus Industrials`; `companyUrl` — `/careers`
    - `jobUrl` — `/careers` (the careers page is the canonical URL; there is no per-role detail route)
    - `applyUrl` — `null` (applying is an on-page modal form; no standalone apply URL exists)
    - `description` — the inline JD sections → markdown
    - `location` — `Austin, TX` (stated on the card) via `parseLocationList`
    - `employmentType` — the stated `Full-time`; `jobType` — via `getJobTypeFromString` → `FULL_TIME`
    - `department` — the stated `Engineering`
    - `isRemote` — `false`
    - `datePosted` — null; `emails` — `[]`; `compensation` — omitted (none stated)

## Non-goals

- **No Indeed / third-party involvement.** There is no Indeed URL on this surface; applying is an on-domain modal form. No off-domain URL is fetched.
- **No PDF parsing.** The role's JD is also offered as an on-domain PDF; the HTML already carries the same JD, so the PDF is not fetched or parsed.
- **No fabricated fields.** `compensation` / `datePosted` are left empty (none stated). Location comes only from the stated card value; the HQ is never synthesized independently.
- **No email harvesting.** The apply modal form has no exposed address; `emails` = `[]`.

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.TERMINUSINDUSTRIALS`).
- HTTP goes through the shared `@ever-jobs/common` client; description via `markdownConverter`; location via `parseLocationList`; job type via `getJobTypeFromString`.
- `Logger` (not `console.log`); a top-level fetch/parse failure returns an empty `JobResponseDto` (no throw); a careers page with no role cards returns an empty result (no throw).
- Selectors depend on the `Careers_<name>__` CSS-module prefixes. If the site is redesigned and those prefixes change, enumeration degrades to empty (no throw) rather than emitting wrong data.

## Test plan

Fixture-based unit tests over the captured `/careers` page (the fetch seam substitutes the captured HTML):

- module resolves through NestJS DI; `Site.TERMINUSINDUSTRIALS === 'terminusindustrials'`
- the role is mapped with a title-derived `id`, `/careers` `jobUrl`, `applyUrl=null`, `emails=[]`, `datePosted=null`, no compensation, and never an Indeed URL
- `location` is `Austin, TX` (city `Austin` / state `TX`); `isRemote=false`
- `employmentType` `Full-time` → `jobType=[FULL_TIME]`; `department=Engineering`
- the inline JD sections carried into the description as markdown (Job Summary / Key Responsibilities / Desired Qualifications present)
- input filters (searchTerm, offset, resultsWanted); a careers page with no role cards returns nothing (no throw)
