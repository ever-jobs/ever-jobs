# Spec: 5052 — source-company-solideon

| Field | Value |
| --- | --- |
| Spec ID | 5052 |
| Slug | source-company-solideon |
| Status | implemented |
| Plugin | `packages/plugins/source-company-solideon` |
| Category | `company` (single company — Solideon / solideon.com) |
| Related specs | 5042/5045/5046/5047/5048/5049/5050/5051 (prior company careers plugins) |

## Problem

Solideon (`solideon.com`) hosts its careers page on **WordPress (Elementor)** with **no ATS**. The `/careers/` landing page lists the open roles; each links to its own **server-rendered detail page** at the site root (`/solideon-<slug>/`) that carries the full job description plus a per-role **Salary Recommendation**, **Location**, and a WordPress publish date. Applying is an on-page **Paperform** embed on each detail page (no external board, no `mailto:`, no per-role apply URL beyond the detail page). No adapter existed, so these openings were not ingested.

The pages are **server-rendered plain HTML** (HTTP 200; Cloudflare-fronted but no JS challenge), so the roles are readable with a plain HTTP GET + Cheerio — no headless browser.

## Scope

- New single-company plugin `source-company-solideon` (`category: 'company'`).
- Enumerate role links from `/careers/`; fetch each detail page; map to `JobPostDto`:
    - `id` — `solideon-<slug>`
    - `title` — the listing anchor text
    - `companyName` — `Solideon`
    - `jobUrl` / `applyUrl` — the per-role detail page (the Paperform lives there)
    - `description` — the detail `<main>` body → markdown (apply section + leading title/divider chrome removed)
    - `location` — the per-role stated "Location:" city/state (parenthetical dropped)
    - `compensation` — the per-role "Salary Recommendation" range, when stated
    - `datePosted` — the detail page's JSON-LD `datePublished`
    - `isRemote` — `false` (roles are stated On-Site)
    - `emails` — `[]`

## Non-goals

- No fabricated fields: `compensation` is populated only for the roles that state a salary (2 of 4 at time of writing) and omitted otherwise; `location` is each role's own stated city (so the Manufacturing Engineer resolves to Hampton Roads, VA, not Berkeley).
- No headless browser: listing and detail pages are server-rendered.
- The "General Career Interest" block is a general contact form, not an opening — excluded by the role-link pattern.

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.SOLIDEON`).
- All HTTP goes through the shared `@ever-jobs/common` client; body → markdown via `markdownConverter`; salary via `salaryToCompensation`; location via `parseLocationList`; date via `toDateOnly`.

## Test plan

Fixture-based unit tests over captured careers + detail HTML:

- four openings enumerated with the expected titles
- identity / per-role apply page / detail-page date mapping
- per-role location, including the non-Berkeley (Hampton Roads, VA) role
- compensation populated where stated, omitted where absent
- JD body → description with the apply form removed
- input filters (searchTerm, resultsWanted)
- listing with no role links returns nothing (no throw)
