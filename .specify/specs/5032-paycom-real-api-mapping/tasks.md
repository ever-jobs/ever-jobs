# Tasks: 5032 — Paycom real API mapping (full rewrite)

- [x] T1 — Add `jobPostingLdFromNode(value)` to `@ever-jobs/common`
      (`utils/jsonld.ts`): JSON-parse strings, run `collectJobPostings` +
      `mapJobPosting`, return the first `JobPosting` (or null).
    - Acceptance: maps an object / JSON string / `@graph` container and
      structured `baseSalary`; null for empty / malformed / non-`JobPosting`.
- [x] T2 — Rewrite `paycom.constants.ts` for the real surface (board + API
      origins, URL builders, `PAYCOM_SESSION_JWT_REGEX`, `PAYCOM_SEARCH_FILTERS`,
      `PAYCOM_REMOTE_TYPE_CODES`, clientkey regexes, headers).
    - Acceptance: types compile; the surface + contract are documented.
- [x] T3 — Rewrite `paycom.types.ts` (preview / search / detail / company-name
      envelopes + normalised `PaycomJob`).
    - Acceptance: fields mirror the wire shapes and are documented.
- [x] T4 — Rewrite `paycom.service.ts`: clientkey resolution, board → token,
      company-name, search with full `filtersForQuery`, detail unwrap,
      `googleJobJson` parse, structured-first compensation, field mapping,
      graceful degradation.
    - Acceptance: a tenant with a `sessionJWT` + `jobPostingPreviews` yields one
      `JobPostDto` per unique `jobId`; `companyName` from `/api/ats/company-name`;
      `datePosted` from `googleJobJson`; empty on missing token / unknown tenant.
- [x] T5 — Add the mocked `paycom.service.spec.ts`; refresh the e2e header
      comment to the real contract.
    - Acceptance: the cases in the spec test plan are asserted; e2e stays live +
      zero-tolerant.
- [x] T6 — Run the `source-ats-paycom` + `common` jest suites; typecheck
      `apps/api`; `lint:docs`.
    - Acceptance: suites green; `tsc --noEmit` clean on `apps/api`; docs lint
      clean.
