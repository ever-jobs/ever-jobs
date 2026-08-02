# Plan: 5043 — source-ats-submit4jobs

| Field | Value |
| --- | --- |
| Spec ID | 5043 |
| Slug | source-ats-submit4jobs |
| Status | implementing |

## Phases

### Phase 1 — Registration + scaffold

- `Site.SUBMIT4JOBS = 'submit4jobs'` in `packages/models/src/enums/site.enum.ts`.
- New package `packages/plugins/source-ats-submit4jobs/` (package.json,
  tsconfig.json,
  `src/{index,submit4jobs.module,submit4jobs.service,submit4jobs.constants,submit4jobs.types}.ts`).
- Register in `packages/plugins/index.ts` (`ALL_SOURCE_MODULES`),
  `tsconfig.base.json` paths, `jest.config.js` moduleNameMapper.

### Phase 2 — Constants and types

- `submit4jobs.constants.ts`: `SUBMIT4JOBS_HOST_SUFFIX` (`.submit4jobs.com`),
  `submit4jobsBoardUrl(slug)` builder, `submit4jobsJobUrl(slug, jid, title)`,
  embed-script regex, headers, timeout / results / concurrency caps, the two
  template-default filter objects (`magneto`, `magnetolive`), salary-type →
  pay-period map (`H`→HOUR, `Y`→YEAR, …).
- `submit4jobs.types.ts`: `Submit4jobsApiCoords` (host/template/cid),
  `Submit4jobsJob` (raw API job object), `Submit4jobsListItem` (normalised row).

### Phase 3 — Service (scrape flow)

- `scrape()`: resolve slug → `discover()` (board page → api coords) →
  `primeSession()` (iframe → cookie header) → `getJobs()` (list) → conditional
  `fetchDescriptions()` (bounded fan-out for empty-body rows) → map to
  `JobPostDto[]`.
- `discover(client, slug)`: fetch board home page, regex the embed
  `<script src>` for `{apiHost, template, cid}`.
- `primeSession(client, coords)`: GET the iframe, read `Set-Cookie`, build the
  Cookie header from `CFID`/`CFTOKEN`/`CFCLIENT_CAREERHOSTING` (drop deletion
  cookies).
- `getJobs(client, coords, cookie, filters)`: POST `action=getJobs`; parse the
  JSON array; return `[]` on the Pereless error HTML.
- `fetchDescriptions(...)`: `Promise.allSettled` batches, one `getJobs`
  (`filters.jid`) per body-less row.
- `toJobPost(job, slug, format)`: map raw API job → `JobPostDto`.

### Phase 4 — Field enrichment

- `buildLocation()`: compose `city, state, fullCountryName` →
  `parseLocationList` for the normalised `LocationDto` + remote signal.
- compensation: `salary` / `salaryrange` → numeric min/max; `salarytype`
  (`H`/`Y`/…) → `getCompensationInterval` via the code→period map; `jobcurrency`.
- `datePosted`: `postingdate` → `toDateOnly` (JS-parseable
  `"Month, DD YYYY HH:MM:SS"`).
- description: `jobdescription` + `reqsexp` concatenated, formatted per
  `descriptionFormat`.
- company name: list `companyname`, de-slugified slug fallback.

### Phase 5 — Tests

- Mocked-HTTP unit tests covering discovery (both templates), session priming
  + cookie replay, list mapping, conditional detail fan-out, location,
  compensation (hourly/yearly/empty), date parse, de-dupe, resultsWanted, no
  slug, slug-from-url, error-HTML → `[]`, description formatting, emails.

### Phase 6 — Docs

- Update `docs/index.md`, `docs/log.md`, `docs/questions.md`.

## Risks

- **CF session gate**: `getJobs` returns an error page without a primed session.
  Mitigated: fetch the embed iframe first and replay the three CF cookies; an
  un-primeable board degrades to `[]`.
- **Per-tenant host/template**: tenants live on different Pereless hosts
  (`apps.submit4jobs.com`/`magneto`, `devapps.pereless.com`/`magnetolive`) with
  different default filter shapes. Mitigated: coordinates are read from the board
  page, and filters are selected by the discovered template.
- **List omits the body**: the `magnetolive` template returns empty
  `jobdescription` in the list. Mitigated: conditional per-job detail fan-out for
  body-less rows only (no N+1 where the body is inlined).
- **Error HTML masquerading as 200**: Pereless returns HTTP 200 with an HTML
  error body on a bad request. Mitigated: parse defensively; non-array →
  `[]`.
- **Cookie header hygiene**: raw `Set-Cookie` values include deletion cookies
  and unrelated entries. Mitigated: forward only the three CF cookies and skip
  past-dated deletions.
