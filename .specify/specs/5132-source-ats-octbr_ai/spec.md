# Spec 5132 — Source ATS Plugin: Octbr (octbr.ai)

## Problem

Octbr (octbr.ai) is a multi-tenant ATS: every customer gets a
`<slug>.octbr.ai` Laravel + Inertia app that renders its careers board. Ever
Jobs has no plugin for it, so companies hosted there return 0 jobs.

## Shape of the board

- `GET https://<slug>.octbr.ai/` returns server-rendered HTML whose root div
  carries an Inertia `data-page` JSON prop.
- `props.jobsByDepartment` is `[{ department, jobs[] }]`. Each job:
  `{id, title, slug, url, location, location_type, location_type_label,
  employment_type, employment_type_label, posted_date}` where `posted_date`
  on the listing is relative ("1 month ago").
- `props.organisation.name` is the company display name; `props.totalJobs`
  is the published count.
- `GET https://<slug>.octbr.ai/jobs/<slug>` is another Inertia page;
  `props.job` carries `description`, `responsibilities`, `requirements`
  (HTML), `posted_date` (absolute, e.g. "August 5, 2026"), `department`,
  `salary_range`, `salary_currency`, `location`, `employment_type(_label)`,
  `location_type(_label)`.
- The page advertises `/feeds/jobs.json`, but it returns an HTML error page
  — not a usable source.

## Contract

- `input.companySlug` is the tenant slug (`starcloud` →
  `starcloud.octbr.ai`).
- Job id: `octbr_ai-<companySlug>-<numeric id>`.
- `jobUrl`/`applyUrl`: the job's `url` (apply is on-page).
- `department` from the `jobsByDepartment` group key.
- `location` from the job's `location` string via `parseLocationText`.
- `isRemote`: `location_type === 'remote'` or the location text says remote.
- `jobType`: `getJobTypeFromString(employment_type_label ?? employment_type)`.
- `description`: detail page `description` + `responsibilities` +
  `requirements`, HTML-stripped, joined with section headers.
- `datePosted`: detail page `posted_date` parsed via `Date`.

## Non-goals

- No login/apply automation (apply is an on-page form).
- No cross-tenant discovery; each slug is a separate board.
