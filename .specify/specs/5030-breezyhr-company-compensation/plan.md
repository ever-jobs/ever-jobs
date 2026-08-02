# Plan: 5030 — BreezyHR company display name + structured-first compensation

| Field | Value |
| --- | --- |
| Spec ID | 5030 |
| Status | implemented |
| Created | 2026-06-28 |

## Phases

1. **Types** — add `company?: { name?: string | null } | null` to `BreezyJob`;
   add a `BreezyDetail { description, baseSalary }` interface (import
   `JobPostingLdSalary` from `@ever-jobs/common`).
2. **Detail overlay** — rename `fetchDescriptions`/`fetchDescription` to
   `fetchDetails`/`fetchDetail`, returning `BreezyDetail` (the first ld+json
   `JobPosting` with a description **or** a `baseSalary`): both the description
   and the structured `baseSalary`.
3. **Compensation** — in `processJob`, pass
   `structured: jobPostingLdToCompensation(detail?.baseSalary)` to
   `resolveCompensation` with the free-text list `salary` as fallback; set
   `salarySource = structured ? 'structured' : compensation ? 'description'
   : null`. Drop the now-redundant `extractCompensation` helper (and the
   `salaryToCompensation` / `CompensationDto` imports it used).
4. **Company name** — `companyName = listing.company?.name?.trim() || company`.
5. **Test** — add deterministic synthetic cases (company display name, slug
   fallback, structured-first over free text, text fallback `salarySource`);
   keep the existing free-text/format/location/jobType/fail-safe suites green.
6. **Verify** — run the `source-ats-breezyhr` jest suite; typecheck the
   `apps/api` build; `lint:docs`.

## Packages touched

- `packages/plugins/source-ats-breezyhr` (`src/breezyhr.service.ts`,
  `src/breezyhr.types.ts`, `__tests__/breezyhr.service.spec.ts`).

## Risks

- Structured-first changes the emitted interval for postings whose free text and
  structured `baseSalary` disagree (the `"$30 - $45"` → `YEAR` case). Intended
  per Spec 5018; `salarySource` records the winning source.
- ld+json `baseSalary` shapes vary; extraction reuses the shared
  `parseJobPostingLd` / `jobPostingLdToCompensation` (Spec 5022 / 5018), already
  hardened for the common `MonetaryAmount` variants.
