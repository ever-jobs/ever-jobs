# Plan: 5175 — factorial-apex-rebrand

| Field | Value |
| --- | --- |
| Spec ID | 5175 |
| Slug | factorial-apex-rebrand |
| Status | draft |
| Owner | agent |
| Created | 2026-10-10 |

## Approach

Small constants + service edit plus a new unit suite — ~40 lines of
production diff.

1. `factorial.constants.ts`: `FACTORIAL_APEX = 'factorial.com'`;
   `FACTORIAL_HOST_TEMPLATES = [canonical, legacy]` replaces the single
   `FACTORIAL_HOST_TEMPLATE`; docblock rewritten for the new apex.
2. `factorial.service.ts`: `scrape()` iterates `FACTORIAL_HOST_TEMPLATES`,
   fetching `{host}/` until one returns a body; sitemap then fetched from the
   winning host. `resolveSlug` already takes the first sub-domain label —
   apex-agnostic, no change.
3. `factorial.e2e-spec.ts`: `includes('factorialhr.com')` →
   `new URL(jobUrl).pathname.startsWith('/job_posting/')`.
4. New `__tests__/factorial.service.spec.ts` +
   `__tests__/fixtures/{factorial-index,factorial-detail,factorial-sitemap}.html`
   — `jest.mock('@ever-jobs/common')` with `createHttpClient` returning
   fixture bodies per URL, same pattern as `source-ats-comeet`.

## Risks

- Fixture must satisfy the exact attribute-order regexes in
  `parseIndexPage` — craft from the documented `data-*` layout, verified
  against the captured live page.
- `applyUrl` base comes from `new URL(jobUrl)`, not the fetch host — no
  change needed there.
