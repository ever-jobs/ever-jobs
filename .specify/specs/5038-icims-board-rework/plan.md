# Plan: 5038 — iCIMS board rework

| Field | Value |
| --- | --- |
| Spec ID | 5038 |
| Status | implemented |
| Created | 2026-07-07 |

## Packages touched

- `packages/plugins/source-ats-icims` — service, constants, types, unit tests.

No core, models, or shared-helper changes. Drops the Playwright/`BrowserPool`
path and the JSON-gateway code entirely.

## Phases

1. **Constants/types.** `buildIcimsBoardUrl(subdomain, page)` (embeddable
   `?ss=1&in_iframe=1&pr={page}` form), page-size/limit/ceiling constants,
   header + parsing regexes (`Page X of N`, `Job Listings at {Company}`, numeric
   job id). `IcimsListItem` / `IcimsBoardPage` interfaces.
2. **Board parse.** Cheerio over `.iCIMS_JobCardItem`: title (`h3`, anchor-title
   fallback), canonical URL + numeric id, location cell, Category header field,
   listing snippet; read the `<title>` for the company display name and the
   pager for the total page count.
3. **Walk + map.** Page `pr` from 0, de-dupe by id, stop on short/empty page,
   pager total, or `resultsWanted`; map each card to `JobPostDto`
   (`{country}-{state}-{city}` split, `isRemote` from location/title).
4. **Addressing.** Resolve the subdomain from `companySlug` (bare or URL) or
   `companyUrl` (`*.icims.com` host label); empty input → `[]`.
5. **Tests.** Mocked-HTTP unit suite over generated board fixtures.

## Risks

- **Theme variance.** Tenants can restyle the board. The parse targets the
  stable `iCIMS_JobCardItem` / `iCIMS_JobHeaderTag` structure and degrades to
  the fields it can find (never throws); an unknown tenant (HTTP 4xx) yields
  `[]`.
- **Listing-only description.** The card snippet is truncated marketing copy;
  full body/date/pay need a per-job detail fetch (out of scope, noted for a
  follow-up).
- **Pager absence.** If a board omits "Page X of N", termination falls back to
  the short-page rule and the `ICIMS_MAX_PAGES` ceiling.
