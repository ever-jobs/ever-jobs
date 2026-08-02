# Tasks: 5043 — source-ats-submit4jobs

| Field | Value |
| --- | --- |
| Spec ID | 5043 |
| Slug | source-ats-submit4jobs |
| Status | implemented |

## Task list

- [x] T1 — Gather tenants (3 live boards) and reverse-engineer the Submit4Jobs
  (Pereless) architecture: board embed `<script src>` → api host/template/cid;
  CF session priming via `embed/iframe.cfm`; `getJobs` JSON API; the
  `magneto` vs `magnetolive` filter-shape / body-inlining difference
- [x] T2 — Register `Site.SUBMIT4JOBS = 'submit4jobs'` and scaffold the package
  (`packages/plugins/source-ats-submit4jobs/`); wire the four registration
  points (enum, `packages/plugins/index.ts`, `tsconfig.base.json`,
  `jest.config.js`)
- [x] T3 — `submit4jobs.constants.ts` (host suffix, URL builders, embed regex,
  headers, caps, per-template default filters, salary-type → pay-period map) +
  `submit4jobs.types.ts` (`Submit4jobsApiCoords`, `Submit4jobsJob`,
  `Submit4jobsListItem`)
- [x] T4 — `submit4jobs.service.ts`: discover coords from the board page, prime
  the CF session (cookie replay), `getJobs` enumeration, conditional per-job
  detail fan-out for body-less rows; location via `parseLocationList`,
  compensation, employmentType, datePosted, company name
- [x] T5 — Mocked-HTTP unit tests (`submit4jobs.service.spec.ts`): discovery
  (both templates), cookie prime/replay, list mapping, conditional detail
  fan-out, location, compensation (hourly/yearly/empty), date parse, de-dupe,
  resultsWanted, no-slug, slug-from-url, error-HTML → `[]`, description
  formatting, emails
- [x] T6 — Update `docs/index.md`, `docs/log.md`, `docs/questions.md`
