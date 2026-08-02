# Spec: 5061 — source-company-hylio

| Field | Value |
| --- | --- |
| Spec ID | 5061 |
| Slug | source-company-hylio |
| Status | implemented |
| Plugin | `packages/plugins/source-company-hylio` |
| Category | `company` (single company — Hylio / hyl.io) |
| Related specs | 5042/5045/5046/5047/5048/5049/5050/5051/5052/5053/5056/5057/5059 (prior company careers plugins); 5058 (single-bound salary parsing — reused) |

## Problem

Hylio (`hyl.io`, agricultural drones / titanium-free UAS manufacturing) hosts its careers page as a **custom Webflow site** with **no ATS**. `/hiring/job-board` (`hyl.io` 301 → `www.hyl.io`) lists open roles as Webflow CMS cards; each role also has an **on-domain Webflow CMS detail page** under `/hiring/{slug}` that server-renders the full job description (About / Job Summary / Responsibilities / Qualifications / Other) plus `Job Type:` and `Pay:` lines. Applying happens **on Indeed** — each card's "APPLY" links out to an `indeed.com` URL. No adapter existed, so these openings were not ingested.

Unlike IperionX (Spec 5059, summary-only), Hylio publishes a **full JD on its own domain**, so this is a standard two-step Webflow careers scraper (like 5056/5057) — not a summary-only case.

## Approach

Plain-HTTP fetch (no headless browser — server-rendered Webflow). Two steps, both on `hyl.io`; **Indeed is never fetched**:

1. **GET `/hiring/job-board`** — each role is a `.jobtitle` block (the `<h1>` title + the Indeed "APPLY" link) paired with a sibling `.jobinformation` block that carries the on-domain "LEARN MORE" detail link (`/hiring/{slug}`). Anchor on `.jobtitle`, resolve the enclosing card (`.w-layout-grid`), and read the detail slug, the title, and the Indeed apply URL. Deduped by slug (the board index `job-board` is excluded).
2. **GET `/hiring/{slug}`** (bounded fan-out via `Promise.allSettled`) — parse the full JD body → markdown, and lift the stated `Job Type:` and `Pay:` lines.

## Scope

- New single-company plugin `source-company-hylio` (`category: 'company'`).
- Map each role to `JobPostDto`:
    - `id` — `hylio-<slug>` (stable on-domain detail slug)
    - `title` — the card `<h1>` (its inner `<br>` normalized to a space, e.g. `DRONE<br/>TECHNICIAN` → `DRONE TECHNICIAN`); detail `<h1>` preferred when present
    - `companyName` — `Hylio`; `companyUrl` — `/hiring/job-board`
    - `jobUrl` — the employer's own on-domain detail page `/hiring/{slug}` (canonical URL)
    - `applyUrl` — the Indeed apply URL (apply destination; **never fetched**)
    - `description` — the detail JD body → markdown
    - `compensation` — the `Pay:` line (e.g. `$16.00 - $20.00 per hour`) via `salaryToCompensation` (hourly interval)
    - `employmentType` / `jobType` — the `Job Type:` line (e.g. `Full-time`) via `getJobTypeFromString` → `FULL_TIME`
    - `location` — **null** (the site states no per-role location)
    - `isRemote` — `false` (in-person)
    - `datePosted` — null; `emails` — `[]`

## Non-goals

- **No Indeed scraping.** The Indeed link is the `applyUrl` only; the plugin never fetches any `indeed.com` URL (not as a source, not during parsing). `jobUrl` is the on-domain page, not Indeed.
- **No HQ substitution / no fabricated location.** The careers site states no job location (only "in-person" free text in the body, which nothing parses), so `location` is left null — the `Houston, TX` corporate HQ from external data is never synthesized. (Work-mode is never parsed from free text in this repo, so "in-person" is not classified; `isRemote` is a plain `false`.)
- **No fabricated fields.** `datePosted` = null (none stated); fields the site does not state are left empty.
- **No plugin-local salary logic.** Pay is resolved via the shared `salaryToCompensation` (Spec 5058), not a plugin-local parser.
- **No editorial filtering / fixed count.** Every live role is ingested (1 live now; the plugin asserts no fixed count).

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.HYLIO`).
- HTTP goes through the shared `@ever-jobs/common` client; description via `markdownConverter`; compensation via `salaryToCompensation`; job type via `getJobTypeFromString`.
- `Logger` (not `console.log`); a per-role detail failure degrades to the listing-only fields; a top-level fetch/parse failure returns an empty `JobResponseDto` (no throw).

## Test plan

Fixture-based unit tests over the captured job-board + detail HTML (the detail fetch seam throws if any `indeed.com` URL is requested, proving Indeed is never fetched):

- the live role enumerated and deduped, with `hylio-<slug>` id, `Site.HYLIO`, company name, `emails=[]`
- `jobUrl` is the on-domain `/hiring/{slug}` page; `applyUrl` is the Indeed job URL; `jobUrl` is never an Indeed URL
- `location` is null and `isRemote=false`
- stated `Job Type: Full-time` → `employmentType='Full-time'`, `jobType=[FULL_TIME]`; `datePosted` null
- stated `Pay: $16.00 - $20.00 per hour` → hourly compensation, min 16 / max 20 / USD (shared helper)
- detail body carried into the description as markdown (Job Summary / Responsibilities headings present)
- graceful degradation when a detail page cannot be fetched (role still emits from the listing, null description)
- input filters (searchTerm, resultsWanted); a board with no role cards returns nothing (no throw)
