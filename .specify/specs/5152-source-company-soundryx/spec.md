# Spec: 5152

| Field | Value |
| ----- | ----- |
| Spec ID | 5152 |
| Slug | source-company-soundryx |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Problem statement

Soundryx (`soundryx.com` — passive acoustic sensor networks; San
Francisco/Los Angeles, CA) lists open roles on
`https://soundryx.com/careers/`. The site is an Astro static build —
fully server-rendered HTML, no recognized ATS, no `JobPosting`
JSON-LD (only `Organization`/`WebSite` schema) — so it needs a
dedicated company plugin.

## Scope

- New plugin `source-company-soundryx`,
  `Site.SOUNDRYX = 'soundryx'` (the Spec 5069 domain derivation —
  `soundryx.com` → `soundryx`). `companyDomains: ['soundryx.com']`
  declared to pre-claim the host.
- Two-stage static fetch (no headless):
  1. GET `/careers/` → `a.srx-tile.is-link` tiles, each with `h3`
     title, `p` meta line, and `href="/careers/NNNNN-slug/"`.
  2. GET each tile's detail page — verified live: 3 roles today.
- Per detail page (`.vp-doc` content):
  - `h1` → `title` (a `<br/>` meta tail in parentheses is dropped).
  - `<p><strong>Location</strong>: …` → `parseLocationText` after the
    label; `(onsite)` maps to `workFromHomeType: 'On Site'`.
  - All body sections (`What You'll Do`, `What You've Done`,
    `Additional Requirements`, `Why Join Soundryx`, `Compensation`,
    `Export Control`, `Apply Now`) → `description` via
    `htmlToPlainText`; the `section.footnotes` block is stripped.
  - `h2#compensation` → the following `ul` text →
    `resolveCompensation({ text })` — live pages carry
    `$130,000–$180,000` + equity.
  - `h2#apply-now` → `__cf_email__` / `/cdn-cgi/l/email-protection`
    payload decoded by the standard first-byte XOR → `applyUrl` =
    `mailto:careers@soundryx.com` (shared mailbox).
- `id`/`atsId` = `soundryx-{url-slug}` (e.g.
  `00001-founding-electrical-engineer` — numeric prefix already
  unique). `jobUrl`/`jobUrlDirect` = the detail page.

## Non-goals

- No headless rendering — markup is complete in the HTML.
- No `datePosted` or `department` — not published (the nav groups all
  roles under "Engineering" but that is menu structure, not a field).
- No per-role apply target beyond the shared mailbox.

## Contracts

- `IScraper.scrape(ScraperInputDto) → JobResponseDto`.
- Zero tiles or a missing content container → `JobResponseDto([])`
  with an `empty` diagnostic; fetch failure → `classifyScrapeError`.

## Test plan

- Unit spec over live-fetched fixtures (index + 3 detail pages):
  entry count, slug ids, title/location/On-Site mapping, description
  composition without footnotes, salary-range compensation, mailto
  decoding, empty/error diagnostics, `searchTerm`/`location`/
  `resultsWanted`/`offset` filters.
