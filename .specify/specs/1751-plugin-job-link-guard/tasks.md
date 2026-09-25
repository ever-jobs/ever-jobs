# Tasks: 1751 — no plugin hands people an API URL as a job link

| Field   | Value |
| ------- | ----- |
| Spec ID | 1751  |
| Status  | done  |

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

- [x] T1 — Audit every `jobUrl` / `jobUrlDirect` / `applyUrl` assignment in
  `packages/plugins/*/src`. Acceptance: count and classification derived from the AST
  (1,791 sites, 1,164 plugins), every flagged row read in code — notes.md.
- [x] T2 — `public-url.ts` in `@ever-jobs/common` (`API_URL_PATTERN`, `isApiLikeUrl`,
  `firstPublicUrl`). Acceptance: `public-url.spec.ts` 28/28.
- [x] T3 — ReliefWeb: never `entry.href`; public node page fallback. Acceptance:
  `reliefweb.job-url.spec.ts` 3/3.
- [x] T4 — NAV: never the feed `item.url`; arbeidsplassen ad page fallback; `applyUrl` set;
  non-URL `applicationUrl` text no longer becomes a link. Acceptance:
  `navjobs.job-url.spec.ts` 3/3.
- [x] T5 — HiringThing, Loxo, Bullhorn, Ceipal: public candidates and `companyUrl` before the
  legacy API link; Ceipal/Loxo `applyUrl` public-only. Acceptance: `*.job-url.spec.ts`
  4 + 4 + 3 + 5 cases, last-resort behaviour pinned by a test each.
- [x] T6 — Guard `scripts/__tests__/plugin-job-url-hosts.spec.ts`. Acceptance: 12/12;
  scans 1,165 plugins / 1,520 valued assignments; only the four named exceptions produce
  findings; red when SmartRecruiters' `job.ref` is reintroduced.
- [x] T7 — Red controls: the six adapter suites against the pre-fix services fail 13 of 22.
- [x] T8 — Docs: spec/plan/tasks/notes, `docs/index.md` row, `docs/log.md` entry, **Q-110**.
- [ ] T9 — (Q-110 follow-up) decide the last-resort policy for tenants with no public page,
  then either drop the four exceptions or keep them.
- [ ] T10 — (follow-up) Workday site-less fallback URL, Oracle `/careers/job/<id>`
  fallback, and Zwayam's `api.zwayam.com/job_preview/` link verified live.
