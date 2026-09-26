# Tasks: 1695 — Salary parsing hardening

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

- [x] T01 — `parseCurrency` is null-safe and K-aware. Acceptance: `null` for `Negotiable` / `''` /
  `'-'` / whitespace / `null` / `undefined`; `$100K` → 100000, `1.5k` → 1500, `500 kr` → 500;
  `thousandsSuffix: false` keeps `$100K` → 100.
- [x] T02 — `convertToAnnual` annualises only present bounds. Acceptance: min-only and max-only
  inputs keep the missing bound missing; missing / unknown / yearly interval and empty bounds are
  no-ops returning `false`; `HOURLY` / `hour` normalised; cents rounding; the five earlier cases
  unchanged.
- [x] T03 — Pay-period vocabulary and `intervalFromPeriodToken`. Acceptance: `/hr`, ` per hour`,
  ` an hour`, ` hourly`, ` pro Stunde`, `/yr`, ` per annum`, ` p.a.`, `/Jahr`, ` par an`,
  ` por año`, `/mo`, ` par mois`, `/wk`, `/day`, ` pro Tag` classified; ` per shift`, `/m`,
  `/unit` → `null`.
- [x] T04 — Range builders read per-bound tokens, the `to` separator (currency on both amounts) and
  the scale guard, with named groups. Acceptance: the per-bound, trailing-token and `to` tables in
  `salary.spec.ts`; conflicting periods and above-ceiling hourly ranges rejected; `$5 - $10
  million`, `$5 to 10 people`, `5 to 7 years` rejected.
- [x] T05 — Single bound reads its token. Acceptance: `$25/hr+` hourly min 25, `up to $4,000/mo`
  monthly max 4000, `from $28,000 per year` yearly, `starting at $1,200/wk` weekly;
  `from $40/hr to 60/hr` yields nothing rather than a floor.
- [x] T06 — Legacy grammar. Acceptance: 14 recorded pre-change outputs reproduced by
  `grammar: 'legacy'` and by `EVER_JOBS_SALARY_GRAMMAR=legacy`; the same cases pass against the
  unmodified helper (control run); explicit option beats the variable; unknown values select the
  extended grammar.
- [x] T07 — Linear near-misses and regex caching. Acceptance: 50 000-space near-misses finish well
  under 500 ms (legacy shape: seconds); bench p95 within NFR-1.
- [x] T08 — `hasSalaryAmount` and `postProcessCompensation`. Acceptance: the extended and legacy
  cases in `salary.spec.ts`; input never mutated.
- [x] T09 — Update the one earlier assertion that changes (`from $X to $Y` reads the full range;
  legacy keeps the no-match).
- [x] T10 — Regression. Acceptance: the salary-helper consumer suites and `apps/api/src/jobs` green;
  72 sampled descriptions differ in 5 places, all improvements; type-check clean.
- [x] T11 — Wire `postProcessCompensation` into `JobsService.postProcessSalary` (integrator; see the
  hook in `plan.md`) and add the extended cases to `jobs.service.spec.ts`.

Integration 2026-09-25: `JobsService.postProcessSalary` delegates to `postProcessCompensation`; five cases added to `jobs.service.spec.ts`, one pinning `EVER_JOBS_SALARY_GRAMMAR=legacy`.
