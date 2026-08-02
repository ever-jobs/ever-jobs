# Tasks: 5030 — BreezyHR company display name + structured-first compensation

- [x] T1 — Add `company?: { name?: string | null } | null` to `BreezyJob`; add a
      `BreezyDetail { description, baseSalary }` interface (import
      `JobPostingLdSalary` from `@ever-jobs/common`).
    - Acceptance: types compile; the fields are documented.
- [x] T2 — Rename `fetchDescriptions`/`fetchDescription` to
      `fetchDetails`/`fetchDetail`, returning `BreezyDetail` (first ld+json
      `JobPosting` with a description or a `baseSalary`).
    - Acceptance: the overlay yields both the description and the structured
      `baseSalary` when present; bounded concurrency + fail-safe preserved.
- [x] T3 — In `processJob`, resolve compensation structured-first
      (`jobPostingLdToCompensation(detail?.baseSalary)`) with the free-text list
      `salary` as fallback, and set `salarySource` accordingly. Drop the
      `extractCompensation` helper and its unused imports.
    - Acceptance: `baseSalary` present → structured compensation,
      `salarySource: 'structured'`; absent but free-text salary → text
      compensation, `salarySource: 'description'`.
- [x] T4 — `companyName = listing.company?.name?.trim() || company`.
    - Acceptance: `company.name` present → display name; absent → slug fallback.
- [x] T5 — Add synthetic tests (company display name, slug fallback,
      structured-first over free text, text-fallback `salarySource`); keep the
      existing suites green.
    - Acceptance: the cases above are asserted; existing BreezyHR suites green.
- [x] T6 — Run the `source-ats-breezyhr` jest suite and typecheck the `apps/api`
      build; `lint:docs`.
    - Acceptance: suite green; `tsc --noEmit` clean on `apps/api`; docs lint clean.
