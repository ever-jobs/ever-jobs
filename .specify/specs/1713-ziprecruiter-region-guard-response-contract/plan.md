# Plan: 1713 — ZipRecruiter: region guard, geo-block diagnostics and the jobs-app response contract

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1713       |
| Status       | done       |
| Last updated | 2026-09-25 |

## Approach

A fix inside the existing plugin; no registration, enum, path-alias or jest-mapper change (the
plugin is already registered everywhere). Every change either cuts requests or corrects parsing;
nothing adds an endpoint, a header or a detail fetch.

1. **Region guard first.** `isSupportedCountry(input.country)` is the first statement of `scrape`,
   before the HTTP client exists, so an unsupported country costs nothing.
2. **Geo-block memo next.** An instance `Map<egress, until>` keyed by the proxy list. A live entry
   returns the geo diagnostic with no request. Entries expire lazily; the map is pruned and bounded
   on every write. The clock is an injectable `now()`.
3. **Session event.** Form-encoded `URLSearchParams` (repeated `property`), POSTed on a client
   created with `cookies: true` so the session cookies reach the search. A `cf-waf` 403 here ends
   the scrape and starts the memo; anything else is a warning.
4. **Pagination loop.** Sequential pages, `randomSleep(5000, 10000)` between them, a page budget
   derived from `offset + resultsWanted`, dedup on `listing_key`, a guard against a token that
   returns no new ids, and per-job isolation. The first thrown page error becomes the diagnostics
   and ends the loop, keeping what was collected.
5. **Mapping.** Country code to name before `parseLocationList` (the CA pitfall), salary from
   `compensation_*` with Spec 1695's `intervalFromPeriodToken`, posting time through Spec 1696's
   `postedFromTimestamp` + `postedTimeFields`, a type-safe `remote`, the canonical double-slash link.
6. **Switches.** `resolveZipRecruiterOptions(process.env)` is read per scrape; each behaviour
   change has an env var that restores the pre-1713 behaviour (spec section 7.3). Legacy mode keeps
   the old request builder verbatim as `buildLegacyParams`.

## Files

| File | Change |
| ---- | ------ |
| `packages/plugins/source-ziprecruiter/src/ziprecruiter.service.ts` | region guard, memo, session, loop, mapping, `describeError`; `@SourcePlugin` description (BOM and LF kept) |
| `packages/plugins/source-ziprecruiter/src/ziprecruiter.constants.ts` | URLs, `zipRecruiterJobUrl`, `SUPPORTED_COUNTRIES` / `isSupportedCountry`, country and currency maps, filter and label maps, TTL / memo bound / page cap / page-size estimate / delays, `GEO_BLOCK_DETAIL`, session fields and `buildSessionEventBody`, `isGeoBlockError`, env names and `resolveZipRecruiterOptions`, header-identity comment. `ZIPRECRUITER_HEADERS` and `SESSION_EVENT_DATA` unchanged. |
| `packages/plugins/source-ziprecruiter/src/ziprecruiter.types.ts` | new: `ZipJob`, `ZipHiringCompany`, `ZipJobsResponse`, `ZipErrorBody` |
| `packages/plugins/source-ziprecruiter/__tests__/ziprecruiter.service.spec.ts` | new unit suite |
| `packages/plugins/source-ziprecruiter/__tests__/fixtures/*.json` | new synthetic fixtures (two pages, one `cf-waf` body) |
| `packages/plugins/source-ziprecruiter/__tests__/ziprecruiter.e2e-spec.ts` | offline region case; live case gated on `RUN_NETWORK_E2E` and failing on a bare zero |

## Risks

| Risk | Mitigation |
| ---- | ---------- |
| The contract is inferred and no 200 page could be captured | every field optional and read defensively; retired names kept as fallbacks; a page of unusable records is reported, not silent; spec Q2 to replace the synthetic fixtures |
| Page size is not 20 | it only sizes the budget, with one page of slack; `ZIPRECRUITER_MAX_PAGES` overrides |
| The memo hides a recovered egress | 30 min TTL; `ZIPRECRUITER_GEO_BLOCK_TTL_MS=0` turns it off; a proxied request is never suppressed |
| A behaviour change breaks a caller | every change has an env switch back (spec section 7.3) |

## Rollback

Set the env vars in spec section 7.3 (`ZIPRECRUITER_REGION_GUARD=false`,
`ZIPRECRUITER_GEO_BLOCK_TTL_MS=0`, `ZIPRECRUITER_LEGACY_PARAMS=true`,
`ZIPRECRUITER_HOURS_FILTER=false`, a large `ZIPRECRUITER_MAX_PAGES`), or revert the plugin folder.
No data or schema is involved.

## Verification

`npx jest --testPathPatterns "packages/plugins/source-ziprecruiter"`, a red control (the new unit
suite against the pre-1713 service), and `npx tsc --project tsconfig.typecheck.json --noEmit`.
