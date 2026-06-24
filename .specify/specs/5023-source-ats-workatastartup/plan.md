# Plan: 5023 — `source-ats-workatastartup`

| Field | Value |
| --- | --- |
| Spec ID | 5023 |
| Status | implemented |
| Created | 2026-06-24 |

## Approach

Mirror the paylocity/bamboohr **list-spine + bounded detail-overlay** shape,
but the list spine is an embedded Inertia `data-page` JSON blob (not a REST
API) and the detail overlay reuses the Spec 5022 `parseJobPostingLd` helper.

### Data sources (YC public mirror)

- List: `GET https://www.ycombinator.com/companies/{slug}/jobs`
  → HTML with `<div ... data-page="{...escaped JSON...}">`.
  `props.company` (name, slug, website, location, logo_url, one_liner) +
  `props.jobPostings[]` (id, title, url, applyUrl, location, type, prettyRole,
  salaryRange, equityRange, minExperience, visa, skills, companyName).
- Detail: `GET https://www.ycombinator.com{job.url}`
  → `<script type="application/ld+json">` `JobPosting` (description, datePosted,
  employmentType, baseSalary, jobLocation) + a `data-page` with `props.job`
  (markdown `description` fallback).

### Modules

- `workatastartup.constants.ts` — base hosts, URL builders
  (`companyJobsUrl`, `canonicalCompanyUrl`, `detailUrl`), headers, concurrency
  + default result caps.
- `workatastartup.types.ts` — `WaasJobPosting`, `WaasCompany`,
  `WaasPageProps`, `WaasInertiaPage`.
- `workatastartup.service.ts` — `extractInertiaPage(html)` (regex the
  `data-page` attribute, HTML-unescape, `JSON.parse`, defensive), `scrape()`,
  `fetchDetail()`, `processJob()`.
- `workatastartup.module.ts`, `index.ts` — NestJS module + barrel.

### Field mapping helpers (reuse common)

- `parseJobPostingLd` (5022) for the ld+json detail.
- `resolveCompensation` (5018) structured-first, text fallback `salaryRange`;
  `jobPostingLdToCompensation` to lift ld `baseSalary` into a `CompensationDto`.
- `parseLocationList` for ld `jobLocation` labels (multi → `; `), list
  `location` (` / `-delimited) as fallback; gives `isRemote`/`workFromHomeType`.
- `getJobTypeFromString` for `type`; `extractEmails`, `htmlToPlainText`,
  `markdownConverter` for description formats.

### Concurrency / robustness

- Detail fetches via a small bounded pool (cap 5) over the wanted slice;
  `Promise.allSettled` so one failure yields a list-only job, never a throw.
- Whole `scrape` wrapped: any top-level fetch/parse error → `JobResponseDto([])`
  with a logged warning (defensive, like every other plugin).

## Registration

1. `packages/models/src/enums/site.enum.ts` → `WORKATASTARTUP = 'workatastartup'`.
2. `packages/plugins/index.ts` → import + `ALL_SOURCE_MODULES`.
3. `tsconfig.base.json` → `@ever-jobs/source-ats-workatastartup` path.
4. `jest.config.js` → `moduleNameMapper` entry.

## Verification

- `npm run test -- packages/plugins/source-ats-workatastartup`
- `npm run build`, `npm run lint:docs`
- network-gated smoke (RUN_NETWORK_E2E) against diode + loombotic boards.
