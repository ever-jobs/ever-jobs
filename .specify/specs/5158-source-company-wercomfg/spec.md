# Spec: 5158

| Field | Value |
| --- | --- |
| Spec | 5158 |
| Title | Source Company Plugin: Werco Manufacturing (wercomfg.com) — careers index linking detail pages that carry JobPosting JSON-LD |
| Status | Approved |
| Priority | P2 |
| Site token | `wercomfg` (Site.WERCOMFG) |

## Summary

Werco Manufacturing's `/careers` index is a server-rendered page that links to
11 role detail pages (`/careers/{slug}`). Each detail page embeds a complete
schema.org `JobPosting` JSON-LD block — title, description HTML, `datePosted`,
`employmentType`, structured `jobLocation`, `identifier`, `industry`,
`occupationalCategory`, and `workHours`. The index page itself carries no
`JobPosting`, so the generic JSON-LD source cannot reach these roles: it only
parses the page it is pointed at, and the postings live one link deeper.

The plugin fetches the index, collects the detail-page links, fetches each
detail page, and normalises each page's `JobPosting` block into a `JobPostDto`.

## Problem statement

- The careers index links 11 detail pages; none of the roles are reachable
  from the index markup alone.
- Each detail page is the canonical posting — self-describing via JSON-LD —
  so no bespoke HTML scraping is required beyond the index's link list.
- The site offers no per-role apply target: the only contact route is a shared
  `info@wercomfg.com` mailbox (and a phone number).

## Requirements

### Functional

1. `Site.WERCOMFG = 'wercomfg'` registered with `companyDomains: ['wercomfg.com']`.
2. Fetch the careers index (default `https://wercomfg.com/careers`; honour
   `input.companyUrl` when provided).
3. Collect every `/careers/{slug}` detail link (deduplicate; exclude the bare
   `/careers` path itself).
4. Fetch every detail page concurrently via `Promise.allSettled`; a failed
   page contributes no jobs but does not fail the scrape.
5. Per detail page, extract the `JobPosting` node from the page's
   `application/ld+json` blocks via the shared JSON-LD utilities and map:
   - `id` / `atsId`: `wercomfg-{identifier.value}` (fall back to the URL slug).
   - `title`, `description` (HTML → text/markdown per `descriptionFormat`),
     `datePosted`, `employmentType` (→ `jobType` + raw `employmentType`),
     `location`/`locations` from the structured `jobLocation.address`.
   - `jobUrl`/`jobUrlDirect`: the detail page URL (`posting.url` or the link).
   - `applyUrl`: `mailto:info@wercomfg.com` (the site's only contact route).
   - Append `industry` / `occupationalCategory` / `workHours` to the
     description when present.
6. `applyInput` honours `searchTerm` (title/description/location), `offset`,
   and `resultsWanted`.
7. Diagnostics: `empty` when the index yields no detail links; the standard
   classified error otherwise.

### Non-functional

- Static GETs only (one index + N details); no headless rendering.
- Reuse `@ever-jobs/common` JSON-LD utilities — no bespoke JSON-LD parsing.

## Success criteria

- `scrape()` returns 11 `JobPostDto`s on the live site, each with title,
  description, `datePosted`, `jobType`, and a Broken Arrow, OK location.
- Unit tests pass on captured fixtures.

## Out of scope

- Per-role apply targets (none exist on the site).
- `compensation`, `department` — not published.
