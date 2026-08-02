# Spec: 5062 — source-company-truemetalsupply

| Field | Value |
| --- | --- |
| Spec ID | 5062 |
| Slug | source-company-truemetalsupply |
| Status | implemented |
| Plugin | `packages/plugins/source-company-truemetalsupply` |
| Category | `company` (single company — True Metal Supply / truemetalsupply.com) |
| Related specs | 5042/5045/5046/5047/5048/5049/5050/5051/5052/5053/5056/5057/5059/5061 (prior company careers plugins); 5033 (dover — shared `BrowserPool` precedent), 5047 (desktopmetal — headless `BrowserPool` company precedent) |

## Problem

True Metal Supply (`truemetalsupply.com`, metal roofing / building-material manufacturing) hosts its careers page as a **custom Wix (Thunderbolt) site** with **no ATS**. `/careers` renders a "Job Descriptions" group of Wix stylable buttons (`aria-haspopup="dialog"`); clicking a button opens a Wix **popup/lightbox** that holds that role's full job description (About Us / Position Overview / Key Responsibilities / Requirements / Why Join Us).

The openings are **client-rendered**: the initial `/careers` HTML carries the button labels but not the JD bodies, and the popups are **not standalone routes** (their `copy-of-*` slugs soft-404 when fetched directly). So a plain-HTTP fetch cannot see the descriptions. No adapter existed, so these openings were not ingested.

Seven roles are live: Project Estimator, True Service Rep, Customer Relationship Manager, Delivery Driver, CDL-A Driver, Warehouse Assoc., Asheville Facility Manager.

## Approach

Drive a **headless browser** via the shared `@ever-jobs/common` `BrowserPool` (stealth) — not plain HTTP, since the JDs only render after a client-side click. One page, `/careers` only:

1. **GET `/careers`** (headless), wait for the dialog triggers.
2. **Click each `[aria-haspopup="dialog"]` trigger** in turn; read the opened `[role="dialog"]` popup's inner text + inner HTML; close it (Escape) before the next.
3. Keep only dialogs whose text carries **≥2 job-description section markers** (About Us / Position Overview / Responsibilities / Requirements / Qualifications / Why Join Us / About the Role). This drops non-job dialogs (e.g. the page's "Color Chart & SRI Values" popup) without pinning a fixed list of role titles. Dedupe by rendered title.

## Scope

- New single-company plugin `source-company-truemetalsupply` (`category: 'company'`).
- Map each role to `JobPostDto`:
    - `id` — `truemetalsupply-<slugified-title>`
    - `title` — the rendered popup title (the dialog's first non-empty line)
    - `companyName` — `True Metal Supply`; `companyUrl` — `/careers`
    - `jobUrl` — **blank (`''`)** — the employer publishes no per-role job URL (owner decision)
    - `description` — the popup body → markdown (`markdownConverter`)
    - `location` — **only** when the title's leading token is a known facility city (e.g. `Asheville Facility Manager` → Asheville) via the shared `parseLocationList`; otherwise `null`
    - `isRemote` — `false` (in-person)
    - `datePosted` — null; `emails` — `[]`

## Non-goals

- **No Indeed scraping.** The careers page links to an Indeed company page; it is link-only and never fetched (not as a source, not during parsing).
- **No fabricated location.** Location is derived **only** from an approved title prefix (owner decision). The corporate HQ (Knoxville) is never synthesized, and incidental body text is never parsed for location — e.g. CDL-A's "greater Knoxville area" in the body must **not** become a location, and "in-person" work-mode wording is never parsed (this repo never derives work-mode from free text; `isRemote` is a plain `false`).
- **No fabricated fields.** `datePosted` = null; compensation / employment type / per-role apply URL are absent on-site and left empty. A stray `$0.00` (invoice reference) and an unfinished `[insert weight] lbs` placeholder in the source JDs are ingested as-is, never repaired or parsed as pay.
- **No plain-HTTP siteAssets reconstruction.** The Wix page-JSON path is brittle (strict param set → HTTP 400; per-publish `siteRevision` + content-hash filenames) — the headless click path is used instead (owner decision).
- **No editorial filtering / fixed count.** Every live job dialog is ingested; the plugin asserts no fixed count.

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.TRUEMETALSUPPLY`).
- Headless browsing goes through the shared `@ever-jobs/common` `BrowserPool` (stealth); the page is always closed in `finally`, and `onModuleDestroy` closes the pool.
- Description via `markdownConverter`; location via `parseLocationList`.
- `Logger` (not `console.log`); a per-dialog failure is skipped (logged at debug); a top-level navigation/parse failure returns an empty `JobResponseDto` (no throw).

## Test plan

Fixture-based unit tests over the **captured real dialog HTML/text** for all seven roles (`__tests__/fixtures/truemetalsupply-dialogs.json`), with the browser step (`fetchOpenings`) mocked so no real browser/network is used:

- all seven live openings mapped with `truemetalsupply-<slug>` id, `Site.TRUEMETALSUPPLY`, company name/url, `emails=[]`
- `jobUrl` is blank (`''`) for every role; compensation / employmentType / jobType stay empty; `datePosted` null
- description carried as markdown (Position Overview / Key Responsibilities / Requirements headings present)
- location derived **only** from the `Asheville` title prefix (`{ city: 'Asheville' }`); all other roles — including CDL-A (Knoxville only in body) — get `null`
- `collectDialogs` (driven by a fake Playwright page) keeps job dialogs, drops a non-job dialog (color chart, 0 markers), and dedupes by title
- input filters (searchTerm over title+description, offset, resultsWanted)
- empty board returns nothing; a browser-step throw degrades to an empty `JobResponseDto`
- module resolves through NestJS DI; `Site.TRUEMETALSUPPLY === 'truemetalsupply'`
