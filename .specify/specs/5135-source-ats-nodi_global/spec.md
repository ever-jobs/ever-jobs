# Spec: 5135 — Source ATS plugin: Nodi (`source-ats-nodi_global`)

| Field | Value |
| --- | --- |
| Spec ID | 5135 |
| Slug | source-ats-nodi_global |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-19 |

## Problem

Nodi (`nodi.global`) is a multi-tenant ATS; each customer board lives at
`https://app.nodi.global/company/<slug>` (a Next.js app whose SSR HTML only
renders a "0 positions" skeleton — jobs load client-side). No ever-jobs
plugin covered it.

## Contract

- `companySlug` addresses the tenant (`'radical ai'` — the board path slug,
  space URL-encoded).
- `GET api.nodi.global/job-offers/active/company/<slug>` returns the full
  offer list — each record carries `id`, `title`, `location`, `department`,
  `type`, `modality`, `seniority`, `min_salary`/`max_salary`/`currency`/
  `frequency`, `created_at`, `magic_link`, and the full HTML `description`.
  A single list call per board; no detail fetches.
- `GET api.nodi.global/companies/by-name?name=<slug>` resolves
  `company_name` + `website` for `companyName`/`companyUrl`; a failed lookup
  degrades to the slug and does not fail the scrape.
- `jobUrl`/`applyUrl` = `magic_link` (`app.nodi.global/jobs/public/<id>`).
- `modality` → `isRemote`/`workFromHomeType`; `type` → `jobType`/
  `employmentType`; `created_at` → `datePosted`; salary range →
  `compensation` via `resolveCompensation` (description text as fallback);
  `description` HTML → plain text.

## Verified live

- `radical ai` board: API returns 8 active offers; `scrape()` returns 8
  jobs with title, Brooklyn/New York locations, Engineering/Materials
  departments, USD salary ranges, and descriptions.

## Non-goals

- No pagination observed or needed (the endpoint returns the full active
  list).
- No posted-date granularity beyond `created_at`.
