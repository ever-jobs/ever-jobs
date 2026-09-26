# Plan: 1695 — Salary parsing hardening

| Field        | Value       |
| ------------ | ----------- |
| Spec ID      | 1695        |
| Status       | in-progress |
| Last updated | 2026-09-25  |

## Approach

All parsing changes live in `packages/common/src/utils/helpers.ts`; the API service keeps its
current body until the hook below is wired.

1. **Grammar switch.** `resolveSalaryGrammar` picks `options.grammar`, else
   `EVER_JOBS_SALARY_GRAMMAR=legacy`, else `extended`. Each builder has a `legacy` branch that
   returns the earlier regex unchanged apart from named groups, so the legacy grammar is the
   earlier behaviour, not an approximation of it.
2. **Period tokens.** `SALARY_PERIOD_UNITS` / `SALARY_PERIOD_ADVERBS` (one row per interval) build
   `SALARY_PERIOD_TOKEN_SRC`, made case-insensitive by `caseInsensitiveSrc` so the range regexes
   keep their case-sensitive ISO codes. `intervalFromPeriodToken` classifies a captured token (and
   is exported for plugins that read a separate pay-period field); `periodFromTokens` merges the
   two bounds' tokens and reports a conflict.
3. **Range builders.** The prefix, suffix and bare builders switch to named groups (`min`, `minK`,
   `minPer`, `max`, `maxK`, `maxPer`), since an optional token group between the amounts would
   shift positional indices. The extended prefix/suffix regexes add the case-insensitive scale
   guard and the `to` separator (currency on both amounts). Each whitespace run has one owning
   quantifier, which keeps near-misses linear.
4. **`extractSalary`.** Reads `match.groups`; the stated period (`options.interval ?? token`) takes
   the existing Spec 5045 branch; a conflict returns the null envelope. The single-bound matcher
   appends an optional token to its amount shapes and returns it as `period`; its range-tail guard
   looks past that token so a floor cannot be carved out of `from $40/hr to 60`.
5. **Caches.** Range regexes and the eight single-bound candidates are compiled once per currency
   alternation × number shape × grammar (bounded; no `g`/`y` flags, so no shared `lastIndex`).
6. **`parseCurrency` / `convertToAnnual`.** Null-safe, K-aware, rounded to cents; `convertToAnnual`
   reuses `ANNUALIZATION_FACTORS` and `getCompensationInterval` and returns whether it changed.
7. **`postProcessCompensation`.** The post-scrape rule as a pure function, with the earlier rules
   kept behind the legacy grammar.

## Hook for `apps/api/src/jobs/jobs.service.ts` (integrator)

Replace the body of the private `postProcessSalary(job, input)` with:

```ts
const { compensation, salarySource } = postProcessCompensation({
  compensation: job.compensation,
  description: job.description,
  country: input.country ?? Country.USA,
  enforceAnnualSalary: input.enforceAnnualSalary ?? false,
});
job.compensation = compensation;
job.salarySource = salarySource;
```

and import `postProcessCompensation` from `@ever-jobs/common` (drop `extractSalary` /
`convertToAnnual` from that import if nothing else uses them). The five existing
`describe('postProcessSalary')` cases stay green; add the extended cases pinned in
`packages/common/__tests__/salary.spec.ts` (`postProcessCompensation`). With
`EVER_JOBS_SALARY_GRAMMAR=legacy` the service then behaves exactly as before.

## Files

| File | Change |
| ---- | ------ |
| `packages/common/src/utils/helpers.ts` | grammar switch, period tokens, range builders, `extractSalary`, `parseCurrency`, `convertToAnnual`, `hasSalaryAmount`, `postProcessCompensation` |
| `packages/common/__tests__/salary.spec.ts` | new suite |
| `packages/common/__tests__/helpers.spec.ts` | the `from $X to $Y` case now reads the full range; legacy no-match kept |

## Verification

- `npx jest --testPathPatterns "packages/common/__tests__/(salary|helpers|compensation)"`.
- Control: the new suite against the unmodified helper — every legacy-grammar case passes there,
  so the recorded "before" values are real; the extended cases fail there.
- Consumer regression: the plugin suites that call the salary helpers plus `apps/api/src/jobs`.
- `npx tsc --project tsconfig.typecheck.json --noEmit`.
