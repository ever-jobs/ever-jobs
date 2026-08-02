# Spec: 5050 — source-company-canekast

| Field | Value |
| --- | --- |
| Spec ID | 5050 |
| Slug | source-company-canekast |
| Status | implemented |
| Plugin | `packages/plugins/source-company-canekast` |
| Category | `company` (single company — CaneKast / canekast.com) |
| Related specs | 5047 (per-role PDF job descriptions via unpdf); 5042/5045/5046/5048/5049 (prior company careers plugins) |

## Problem

CaneKast (`canekast.com`) hosts its careers page on **WordPress (Elementor)** with **no ATS**. Each open role is a heading on `/careers/` linking to a **per-role PDF job description** under `/wp-content/uploads/`; applying goes through a **single shared on-page form** (no per-role apply URL, no `mailto:`). No adapter existed, so these openings were not ingested.

Two properties shape the design:

- The listing page is **server-rendered plain HTML** (HTTP 200, no Cloudflare, no JS challenge), so the roles and their PDF links are readable with a plain HTTP GET + Cheerio — no headless browser.
- The role's substance (description, mailing-address location) lives **only in the PDF**, not the listing HTML.

## Scope

- New single-company plugin `source-company-canekast` (`category: 'company'`).
- Enumerate roles from the `/careers/` HTML; fetch each role PDF and extract its text.
- Map to `JobPostDto`:
    - `id` — `canekast-<pdf-stem>`
    - `title` — the role's listing anchor text (trailing `.pdf` dropped)
    - `companyName` — `CaneKast`
    - `jobUrl` — the role PDF URL
    - `location` — parsed from the PDF letterhead address (e.g. `Chaska, MN`)
    - `description` — the PDF text with the letterhead stripped
    - `applyUrl` — the careers page (where the shared form lives)
    - `emails` — `[]`
    - `datePosted` — `null`
    - `isRemote` — `false`

## Non-goals

- No compensation: the page and PDFs state no pay, so compensation is omitted (never guessed).
- No `employmentType`/`jobType`: not stated in the PDFs.
- No per-role apply URL or email: the site exposes only one shared form.
- No headless browser: the listing is server-rendered.

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.CANEKAST`).
- All HTTP goes through the shared `@ever-jobs/common` client; PDF text via `unpdf` (already a repo dependency); location via the shared `parseLocationList` (Spec 5001).

## Test plan

Fixture-based unit tests over captured listing HTML + real extracted PDF text:

- three roles parsed, de-duped by PDF, non-`/uploads` decoy PDF ignored
- identity/jobUrl/shared-apply-form/null-date mapping
- location derived from the PDF letterhead (`Chaska, MN`)
- PDF body → description with the letterhead stripped
- graceful degradation when a PDF fails (listing fields kept, description + location null)
- input filters (searchTerm, resultsWanted)
- empty listing returns no roles (no throw)
