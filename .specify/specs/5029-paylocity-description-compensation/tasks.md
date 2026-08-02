# Tasks: 5029 — Paylocity full-body description, structured compensation, clean company name

- [x] T1 — Add `baseSalary: JobPostingLdSalary | null` to `PaylocityJobDetail`
      (import the type from `@ever-jobs/common`).
    - Acceptance: type compiles; the field is documented.
- [x] T2 — In `parseDetail`, source the description from the full-body HTML
      sections (ld+json `description` as fallback only) and extract the first
      ld+json `baseSalary`. Narrow `parseDetailHtml`'s return type.
    - Acceptance: a detail with extra visible sections yields a description that
      includes them; `baseSalary` is populated when present in the ld+json.
- [x] T3 — In `processJob`, resolve compensation structured-first
      (`jobPostingLdToCompensation(detail?.baseSalary)`) with the description
      text as fallback, and set `salarySource` accordingly.
    - Acceptance: `baseSalary` present → structured compensation,
      `salarySource: 'structured'`; absent but salary in text → text
      compensation, `salarySource: 'description'`.
- [x] T4 — Add `cleanCompanyName` (strip trailing ` [\d+]`) and use it for
      `companyName`.
    - Acceptance: `"SendCutSend Inc [175255]"` → `"SendCutSend Inc"`; a name
      without a bracketed id is unchanged.
- [x] T5 — Update the existing compensation test to structured-first + tighten
      the company-name assertion; add synthetic full-body-description and
      text-fallback tests.
    - Acceptance: the cases above are asserted; existing suites green.
- [x] T6 — Run the `source-ats-paylocity` jest suite and typecheck the package +
      the `apps/api` build.
    - Acceptance: suite green; `tsc --noEmit` clean on both.
