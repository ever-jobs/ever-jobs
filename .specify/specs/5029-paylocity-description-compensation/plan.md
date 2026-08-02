# Plan: 5029 — Paylocity full-body description, structured compensation, clean company name

| Field | Value |
| --- | --- |
| Spec ID | 5029 |
| Status | implemented |
| Created | 2026-06-28 |

## Phases

1. **Types** — add `baseSalary: JobPostingLdSalary | null` to `PaylocityJobDetail`
   (import the type from `@ever-jobs/common`).
2. **Detail parse** — in `parseDetail`:
   - Description = `parseDetailHtml(html).description` (full visible body), with
     the ld+json `JobPosting.description` as a fallback only.
   - Extract the first ld+json `baseSalary` into the returned detail.
   - Narrow `parseDetailHtml`'s return type to `Pick<…, 'description' | 'jobType'>`.
3. **Compensation** — in `processJob`, pass
   `structured: jobPostingLdToCompensation(detail?.baseSalary)` to
   `resolveCompensation` and set `salarySource = baseSalary ? 'structured'
   : compensation ? 'description' : null`.
4. **Company name** — add `cleanCompanyName(title)` (strip trailing ` [\d+]`) and
   use it for `companyName`.
5. **Test** — update the existing compensation test to assert structured-first
   behaviour + tighten the company-name assertion; add deterministic synthetic
   tests for full-body description and the text fallback.
6. **Verify** — run the `source-ats-paylocity` jest suite; typecheck the package
   + the `apps/api` build.

## Packages touched

- `packages/plugins/source-ats-paylocity` (`src/paylocity.service.ts`,
  `src/paylocity.types.ts`, `__tests__/paylocity.service.spec.ts`).

## Risks

- The compensation test that previously asserted `salarySource: 'description'`
  on a posting whose ld+json also carries `baseSalary` legitimately changes to
  `'structured'`; this is the intended behaviour change, not a test workaround.
- ld+json `baseSalary` shapes vary; extraction reuses the shared
  `parseJobPostingLd` / `jobPostingLdToCompensation` (Spec 5022 / 5018), already
  hardened for the common `MonetaryAmount` variants.
