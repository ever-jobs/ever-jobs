# Spec: 5034 — JazzHR board rework (de-dupe + real DOM + detail overlay)

| Field | Value |
| --- | --- |
| Spec ID | 5034 |
| Slug | jazzhr-board-rework |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5015, 5018, 5030, 5031 |

## Problem

The JazzHR public-board path (`scrape` → `parseHtml`) half-works. All five of its
CSS selectors miss the live `resumator`/`applytojob.com` board theme, so it falls
back to "any `<a href*="/apply/">`". The board renders each job twice (a desktop
table row and a mobile block), so that fallback yields **two entries per job**;
on large boards the duplicates consume the `resultsWanted` cap and silently drop
real roles. It also sets `companyName` to the slug, and never opens the detail
page, so `description`, `employmentType`, and `department` are absent.

Verified read-only against 6 live JazzHR boards (opulo, herthametals, biosero,
gocanvas, liquidpiston, deka) carrying **71 open roles**:
the plugin returned ~2× that count, with `companyName` = slug and no body,
employment type, or department.

## Scope

Rework the public-board path in `jazzhr.service.ts` (and supporting
constants/types):

- **List.** Parse the desktop `<table id="jobs_table">` via Cheerio. A job is an
  `<a class="job_title_link" href="/apply/jobs/details/{code}">`; the row's second
  cell is the location. De-dupe by board `code` (so the mobile copy is ignored).
- **Department.** Inline `<span class="resumator_department">` on the row, else
  the most recent `<tr class="resumator_department_heading">` section row.
- **Company name.** From the board's schema.org `Organization` ld+json `name`
  (e.g. "Opulo, Inc"), falling back to the detail page's `h2.job_company`, then
  the slug. **Never the slug first** (same class as Specs 5030/5031).
- **Detail overlay.** Fetch each role's `/apply/jobs/details/{code}` page under
  bounded concurrency (`Promise.allSettled`) and parse:
  - `description` — `div.job_description` (full body), formatted per
    `descriptionFormat`;
  - `employmentType` — trailing segment of `h3.job_meta` ("Dept - Location -
    Type"), mapped to `jobType` via `getJobTypeFromString`.
- **isRemote.** Location or title mentions "remote".
- **Job URL / id.** Canonical `/apply/jobs/details/{code}`; stable
  `id` = `jazzhr-{slug}-{code}` and `atsId` = `code`.
- **Graceful degradation.** A failed detail fetch yields the board-only fields
  for that job; one role never nukes the batch.

The authenticated Resumator API path (`scrapeWithApi`) is retained; it keeps the
slug as `companyName` (the `/jobs` payload carries no account name) and now emits
the canonical detail URL and `jobType`.

## Non-goals

- No change to the public `JobPostDto` shape.
- JazzHR's public board/detail HTML exposes no posted date or structured pay, so
  `datePosted` and `compensation` stay unset on the board path (they remain
  available on the authenticated API path where the payload provides them).
- No live-network dependency in unit tests (the live e2e suite stays separate).

## Contracts

- A board with N distinct roles yields exactly N `JobPostDto` (no mobile-copy
  duplicates), capped at `resultsWanted`.
- `companyName` is the Organization display name (e.g. "Opulo, Inc"), not the
  slug, whenever the board exposes it.
- `description` is the detail's `div.job_description`, format-converted; `null`
  when the detail fetch fails.
- `employmentType` is the `h3.job_meta` trailing segment when present; `jobType`
  is the mapped enum.
- `department` is the inline span or section heading; `null` when neither exists.
- `jobUrl` is `https://{slug}.applytojob.com/apply/jobs/details/{code}`.

## Test plan

Unit (`packages/plugins/source-ats-jazzhr/__tests__/jazzhr.service.spec.ts`,
mocked HTTP):

- de-dupes the duplicate mobile anchor (one job per role);
- uses the Organization display name, not the slug;
- overlays detail body / employment type / department; maps location + jobType;
- reads the department from a section-heading row;
- flags remote from the location;
- survives a failed detail fetch (board-only fields, `description` null);
- honors `descriptionFormat` html/plain;
- empty result when no `companySlug`;
- authenticated API path maps the Resumator payload.

Plus the existing live e2e suite (`jazzhr.e2e-spec.ts`).
