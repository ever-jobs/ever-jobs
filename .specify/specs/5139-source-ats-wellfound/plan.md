# Plan: 5139 — `source-ats-wellfound`: slug-keyed Wellfound company boards

| Field | Value |
| --- | --- |
| Spec ID | 5139 |
| Slug | source-ats-wellfound |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

## Approach

Clone the `source-ats-*` package shape (nearest template:
`source-ats-octbr_ai`) with the fetch path of `source-wellfound`
(BrowserPool + `__NEXT_DATA__`), keyed on the company-board URL.

## Phases

1. **Scaffold** — `packages/plugins/source-ats-wellfound/`:
   `package.json`, `tsconfig.json`, `src/{index.ts,
   wellfound_ats.{module,service,constants,types}.ts}`.
2. **Service** —
   - `resolveSlug(input)`: `companyUrl` path `/company/{slug}` → slug;
     else `companySlug`; else null.
   - Loop `?page=N` (cap `WELLFOUND_ATS_MAX_PAGES`): `page.goto` →
     read `#__NEXT_DATA__` text via `page.evaluate` →
     `apolloState.data` → collect new `JobListing` nodes by id.
     `looksLikeChallenge(content)` or missing JSON → `blocked`.
   - `mapListing(listing, startupName, format)` → `JobPostDto`
     per the spec table; `parseCompensationString` for the
     `"$120k – $200k"` form (k-suffix, en-dash, optional second
     bound, optional currency symbol).
3. **Register in four places** — `Site.WELLFOUND_ATS = 'wellfound_ats'`
   in `site.enum.ts`; `WellfoundAtsModule` in
   `packages/plugins/index.ts` `ALL_SOURCE_MODULES`;
   `@ever-jobs/source-ats-wellfound` in `tsconfig.base.json` paths and
   `jest.config.js` `moduleNameMapper`.
4. **Tests** — `__tests__/wellfound_ats.service.spec.ts` with a stubbed
   `BrowserPool` page; fixtures built inline as Apollo-cache JSON.
5. **Docs** — `docs/index.md` spec row, `docs/log.md` entry.

## Risks

- **Cloudflare**: datacenter IPs get the interstitial regardless of
  stealth (verified). Plugin reports `blocked` rather than `empty`;
  callers needing a pass run it behind a residential proxy
  (`input.proxies`) — already in the contract.
- **`?page=N` semantics unverifiable from here** (cannot reach the live
  board): dedupe-by-id termination is safe for both server-paginated
  and parameter-ignored tenants; `totalPageCount` mismatch logs a
  truncation warning rather than looping forever.
- **Apollo shape drift**: extraction filters on `__typename ===
  'JobListing'` across the whole cache rather than a fixed key path, so
  renamed connection fields don't break enumeration.
