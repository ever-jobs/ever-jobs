# Plan: 5032 — Paycom real API mapping (full rewrite)

| Field | Value |
| --- | --- |
| Spec ID | 5032 |
| Status | implemented |
| Created | 2026-06-28 |

## Phases

1. **Common helper** — add `jobPostingLdFromNode(value: unknown): JobPostingLd
   | null` to `@ever-jobs/common` (`utils/jsonld.ts`): JSON-parse a string,
   run the existing `collectJobPostings` + `mapJobPosting` on the parsed value,
   return the first `JobPosting`. Reuses Spec 5022 mapping without a `<script>`
   round-trip. Add `jobsonld.spec.ts` cases.
2. **Constants** — rewrite `paycom.constants.ts` for the real surface: board
   origin + `paycomBoardUrl`/`paycomJobUrl` builders, API origin + search /
   detail / company-name paths, `PAYCOM_SESSION_JWT_REGEX`,
   `PAYCOM_SEARCH_FILTERS` (full empty-filters object), `PAYCOM_REMOTE_TYPE_CODES`,
   clientkey regexes, headers.
3. **Types** — rewrite `paycom.types.ts` to model the real wire shapes:
   `PaycomJobPreview`, `PaycomSearchResponse`, `PaycomJobPosting`,
   `PaycomDetailResponse`, `PaycomCompanyNameResponse`, and a normalised
   `PaycomJob`.
4. **Service** — rewrite `paycom.service.ts`:
   - resolve the clientkey from `companySlug` / `companyUrl`;
   - fetch the board page, read `sessionJWT`;
   - fetch the company name; POST the search with full `filtersForQuery`;
   - per preview, GET + unwrap the detail, parse `googleJobJson` via
     `jobPostingLdFromNode`;
   - assemble + map to `JobPostDto`: title, companyName, body (description +
     qualifications), location (ZIP-stripped via `parseLocationText`),
     employmentType, department, `datePosted`, `isRemote` / `workFromHomeType`,
     structured-first compensation, ids/urls;
   - graceful degradation throughout (no throw on 4xx / missing token).
5. **Tests** — add the mocked `paycom.service.spec.ts`; refresh the e2e header
   comment to the real contract (keep it live + zero-tolerant).
6. **Verify** — `source-ats-paycom` + `common` jest suites; `apps/api`
   `tsc --noEmit`; `lint:docs`.

## Packages touched

- `packages/common` (`src/utils/jsonld.ts`, `__tests__/jsonld.spec.ts`).
- `packages/plugins/source-ats-paycom` (`src/paycom.constants.ts`,
  `src/paycom.types.ts`, `src/paycom.service.ts`,
  `__tests__/paycom.service.spec.ts`, `__tests__/paycom.e2e-spec.ts`).

## Risks

- Undocumented, reverse-engineered API; mitigated by graceful empty-on-drift and
  the live e2e suite + the fetch1 harness probe.
- `googleJobJson` is the only `datePosted` source; if a tenant omits it, the date
  is null (preview `postedOn` fallback covers the rare case it is present).
