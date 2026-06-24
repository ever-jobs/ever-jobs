# Spec: 5023 — `source-ats-workatastartup` (YC Work at a Startup)

| Field | Value |
| --- | --- |
| Spec ID | 5023 |
| Slug | source-ats-workatastartup |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-23 |
| Last updated | 2026-06-23 |
| Related specs | 5018, 5019, 5022 |

## Problem

Y Combinator's **Work at a Startup** (WaaS) is a multi-tenant ATS: every YC
company gets a hosted board under a per-company slug. fetch1 now recognises it
as an ATS (`workatastartup:<slug>`) and routes diode.computer, loombotic.com,
and bucket.bot to it, but there is **no ever-jobs plugin** to harvest those
boards — the same "detected ATS, no harvester" gap manatal had before Spec 5021.

The platform exposes two URL shapes for the same underlying board:

- canonical `https://www.workatastartup.com/companies/{slug}` (no `/jobs`)
- public mirror `https://www.ycombinator.com/companies/{slug}/jobs` (with `/jobs`)

The **public mirror is the harvestable face**: the canonical WaaS board is
thin (no per-job detail pages, no descriptions, apply flow gated behind
`account.ycombinator.com` auth), whereas the YC mirror embeds everything we
need in two places:

- the company jobs page embeds an **Inertia.js `data-page` JSON blob**
  (`props.jobPostings[]`) that enumerates every opening with structured fields
  (id, title, relative detail `url`, `applyUrl`, `location`, `type`,
  `prettyRole`, `salaryRange`, `equityRange`, `minExperience`, `visa`,
  `skills`) plus `props.company`;
- each per-job detail page carries a rich schema.org `JobPosting`
  **`ld+json`** block (full HTML `description`, `datePosted`, `employmentType`,
  structured `baseSalary` min/max, multi `jobLocation`) — exactly what the
  shared `parseJobPostingLd` helper (Spec 5022) already parses.

So WaaS slots cleanly into the existing list-spine + detail-overlay pattern
(paylocity/bamboohr precedent), reusing the Spec 5022 ld+json helper and the
Spec 5018/5019 compensation helpers.

## Scope

1. **New `source-ats-workatastartup` plugin** (`Site.WORKATASTARTUP`,
   category `ats`, `isAts: true`). Input: `companySlug` (the WaaS/YC slug, e.g.
   `diode-computers-inc`). Harvest:
    - **List spine** — GET `ycombinator.com/companies/{slug}/jobs`, extract the
      `data-page` Inertia blob, read `props.jobPostings[]` and `props.company`.
    - **Detail overlay** — for each wanted job, GET
      `ycombinator.com{job.url}`, parse the `JobPosting` ld+json via
      `parseJobPostingLd`; fall back to the detail page's `data-page`
      `props.job.description` (markdown) when the ld+json description is empty.
      Bounded concurrency, isolated failures (`Promise.allSettled`).
2. **Field mapping (full ATS checklist, `ats-plugin-feature-checklist-SPEC`):**
    - `title` ← ld `title` → list `title`.
    - `companyName` ← `props.company.name` → list `companyName`.
    - `companyUrl` ← **canonical** `workatastartup.com/companies/{slug}`.
    - `jobUrl` ← public detail page `ycombinator.com{job.url}`.
    - `applyUrl` ← `job.applyUrl` (the `workatastartup.com/application?...`
      target).
    - `location` ← ld `jobLocation` (structured, multi) via `parseLocationList`
      (semicolon-joined when >1), falling back to the list `location` text
      (` / `-delimited). `isRemote`/`workFromHomeType` from the same parse.
    - `compensation` ← structured ld `baseSalary` (min/max range + interval)
      first via `resolveCompensation`, text fallback the list `salaryRange`
      (handles `$140K - $200K` and `$35 - $43 / hourly`). `salarySource`
      recorded.
    - `jobType` ← list `type` (`Full-time`) via `getJobTypeFromString`;
      `employmentType` ← raw ld `employmentType`.
    - `jobFunction` ← list `prettyRole` (`Engineering`).
    - `skills` ← list `skills`; `experienceRange` ← list `minExperience`.
    - `datePosted` ← ld `datePosted` (date-only).
    - `description` ← ld `description` (HTML) formatted per `descriptionFormat`;
      markdown `props.job.description` fallback.
    - `emails` ← `extractEmails` over the description.
    - `atsId` ← job id; `atsType` ← `workatastartup`.
    - Never fabricated: anything absent from both sources is left unset.
3. **Register in all four places** (Site enum, plugins index, tsconfig paths,
   jest moduleNameMapper).
4. **Tests** off real trimmed fixtures (diode 2 jobs single-location; loombotic
   8 jobs incl. multi-location Toronto/Austin and hourly pay).

## Non-goals

- No authenticated WaaS application/apply flow (we only read the public mirror).
- No harvesting from the canonical `workatastartup.com` board directly (thin,
  no descriptions, auth-gated) — the YC mirror is the data source.
- No equity-range modelling (`equityRange` is not a JobPostDto field); captured
  only incidentally if it ever maps.
- No fetch1 changes (detection already shipped on `devin/branch1`).

## Contracts

- Implements `IScraper` from `@ever-jobs/models`; decorated with
  `@SourcePlugin({ site: Site.WORKATASTARTUP, name: 'Work at a Startup',
  category: 'ats', isAts: true })`.
- All HTTP via `@ever-jobs/common` `createHttpClient`.
- Reuses `parseJobPostingLd`, `jobPostingLdToCompensation`, `resolveCompensation`,
  `parseLocationList`, `extractEmails`, `htmlToPlainText`, `markdownConverter`.
- No import of any other plugin.

## Test plan

- **List parse** — `data-page` blob → correct job count, company name, and the
  per-job structured fields (diode: 2; loombotic: 8).
- **Detail overlay** — ld+json description/datePosted/employmentType/structured
  salary merged onto the list job; description fallback to `props.job` markdown
  when ld+json description is absent.
- **Compensation** — structured ld `baseSalary` becomes a min/max range with the
  right interval; hourly text `salaryRange` fallback parses when ld absent.
- **Multi-location** — loombotic software role → semicolon-joined city label and
  the common country.
- **Mapping** — jobType, jobFunction, skills, experienceRange, applyUrl,
  companyUrl (canonical WaaS), jobUrl (YC mirror), atsId/atsType.
- **Robustness** — missing slug → empty result; failed detail fetch → list-only
  job (no throw); `resultsWanted` cap honoured.
