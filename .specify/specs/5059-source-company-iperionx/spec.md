# Spec: 5059 — source-company-iperionx

| Field | Value |
| --- | --- |
| Spec ID | 5059 |
| Slug | source-company-iperionx |
| Status | implemented |
| Plugin | `packages/plugins/source-company-iperionx` |
| Category | `company` (single company — IperionX / iperionx.com) |
| Related specs | 5042/5045/5046/5047/5048/5049/5050/5051/5052/5053/5056/5057 (prior company careers plugins); **5060** (shared opt-in bare state/province classification — dependency) |

## Problem

IperionX (`iperionx.com`, titanium metals manufacturing) hosts its careers page as a **custom WordPress page** with **no ATS**. Unlike the other company careers sites, `/careers/` is a **summary-only board**: it lists each open role with only a title, a one-or-two-sentence blurb, and an "Apply Now" button — and that button links **out to an Indeed job page** (`indeed.com/job/{slug}`). The full job detail lives on Indeed. Scraping Indeed is explicitly out of scope (and hostile to scraping), so the Indeed URL is used only as the apply/job link and is never fetched. No adapter existed, so these openings were not ingested.

## Approach

Single plain-HTTP fetch (no headless browser — the page is server-rendered WordPress; Cloudflare-fronted but served without a JS challenge). There is **no per-role detail fetch**: everything the site exposes is on the one page, and the off-site Indeed "detail" is deliberately not read.

1. **GET `/careers/`** — in the "Current Openings" section, each real role card contains an "Apply Now" anchor to `indeed.com/job/{slug}`. Anchor on those (which naturally skips the section header and the newsletter blocks), then read the `<h3>` title and the `.subheading` blurb from the same card. Deduped by Indeed slug.

Because the site is summary-only, this plugin intentionally maps **only the few fields the site states** and leaves the rest empty — no salary, no posted date, no employment type are published on-site.

## Scope

- New single-company plugin `source-company-iperionx` (`category: 'company'`).
- Map each card to `JobPostDto`:
    - `id` — `iperionx-<indeed-slug>` (stable slug from the Indeed URL path)
    - `title` — the `<h3>` text with the trailing " - {location}" suffix removed (e.g. `Production Supervisor - Night - Virginia` → `Production Supervisor - Night`)
    - `companyName` — `IperionX`
    - `jobUrl` / `applyUrl` — the Indeed job URL (apply destination; **never fetched**); `companyUrl` is `/careers/`
    - `description` — the summary blurb → markdown (short; explicitly not the full JD, which lives on Indeed)
    - `location` — the per-role stated location from the title suffix (a bare US state, e.g. `Virginia`) via `parseLocationList([...], { allowBareStateProvince: true })` (Spec 5060) → `{ state: 'VA' }`; null when a role has no suffix
    - `isRemote` — `false` (on-site manufacturing)
    - `emails` — `[]`

## Non-goals

- **No Indeed scraping.** The Indeed link is the apply/job URL only; the plugin never fetches it. The full job description is therefore intentionally not captured.
- **No fabricated fields.** Fields the site does not state are left empty — `datePosted` = null, `compensation` omitted, `employmentType`/`jobType` unset. This is the deliberate "summary-only, accept empty fields" case.
- **No detail fan-out.** There is no on-domain detail page, so there is a single fetch and no per-role concurrency.
- **No `jobFunction`.** The site exposes no structured role category, and no company plugin synthesizes one.
- **No HQ substitution.** Location is only what each role states (the bare state `Virginia` → `{ state: 'VA' }`); never the `Charlotte, NC` corporate HQ from external data.
- **No plugin-local state map.** The bare state is resolved via the shared parser's opt-in (Spec 5060), not a duplicated state list in the plugin.
- **No editorial filtering / fixed count.** Every live card is ingested (6 live now; the plugin asserts no fixed count).

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.IPERIONX`).
- HTTP goes through the shared `@ever-jobs/common` client; location via `parseLocationList` with `{ allowBareStateProvince: true }` (Spec 5060); description via `markdownConverter`.
- **Depends on Spec 5060** for the bare-state opt-in (dependency PR order 5060 → 5059).
- `Logger` (not `console.log`); a fetch/parse failure returns an empty `JobResponseDto` (no throw).

## Test plan

Fixture-based unit tests over the captured careers HTML:

- all six live roles enumerated, deduped, each with an `indeed.com/job/` apply URL (== jobUrl) and `iperionx-<slug>` id; `Site.IPERIONX`, company name, `emails=[]`
- title has the trailing location suffix removed; an internal hyphen is preserved (`Production Supervisor - Night`); blurb captured as markdown
- the bare-state suffix `Virginia` is classified as `{ state: 'VA' }` (no city; `displayLocation()` === `VA`); `isRemote=false`
- unstated fields left empty: `datePosted` null, `compensation`/`employmentType`/`jobType` unset
- input filters (searchTerm, resultsWanted)
- page with no role cards returns nothing (no throw)
