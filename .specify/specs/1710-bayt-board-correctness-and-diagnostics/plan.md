# Plan: 1710 — Bayt: correct search URLs and card mapping, and a challenge is never an empty board

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1710       |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

Split the plugin into three files so the parsing is testable without the network:

1. `bayt.constants.ts` — base URL, headers, market table, regional countries, page cap,
   delays, default results, and `resolveBaytOptions` (overrides → env → default).
2. `bayt.parse.ts` — pure functions: slug, market path, URL builder with a robots guard,
   canonical URL, id extraction, location cell parsing with regional promotion, posted
   label parsing, `parseListing`, `toJobPost` (new and legacy mapping), and
   `baytFetchDiagnostics`.
3. `bayt.service.ts` — the page loop only: validate input and path up front, build the
   client, fetch pages sequentially, classify each outcome, dedupe, filter, offset, cap.

Posted dates reuse the Spec 1696 helpers (`parseRelativeAge`, `relativeAgeToMs`,
`postedFromRelativeLabel`, `postedTimeFields`) rather than a local date parser, so Bayt
rows carry the same precision/basis fields as every other source and obey its kill switch.
Locations reuse `parseLocationList` / `parseLocationText`; the local promotion step only
matters when ISO country names are switched off (Spec 1699's
`EVER_JOBS_LOCATION_ISO_COUNTRY_NAMES=false`), because with them on the parser already
reads "Amman, Jordan" as a country.

The market path honours `country` only when it is a Bayt market. The input DTO defaults
`country` to `USA`, so treating any set `country` as "requested" would make `location`
unreachable for every API caller; a non-market `country` therefore falls through to
`location`, then to `international`.

`buildSearchUrl` doubles as a robots guard: it throws for the country-less path and for any
`filters[` / `options[` spelling. The service calls it once before creating the client, so
a refused path is `bad_input` with zero requests.

## 2. Phases

### Phase 1 — Pure parsing

- Deliverables: `bayt.constants.ts`, `bayt.parse.ts`, `bayt.parse.spec.ts`, fixtures.
- Exit criteria: every design case for slug, URL, market, location, id, URL, posted label
  and diagnostics passes.

### Phase 2 — Service loop

- Deliverables: rewritten `bayt.service.ts`, `bayt.service.spec.ts`.
- Exit criteria: the fourteen design scenarios plus sequential-fetch, sleep and env
  switch cases pass with `@ever-jobs/common` mocked.

### Phase 3 — Live gate and docs

- Deliverables: gated `bayt.e2e-spec.ts`, this spec folder.
- Exit criteria: default `jest` skips the live test; one opt-in run reports `blocked`.

## 3. Packages Touched

| Package                         | Change |
| ------------------------------- | ------ |
| `packages/plugins/source-bayt`  | `src/bayt.constants.ts` (new), `src/bayt.parse.ts` (new), `src/bayt.service.ts` (rewritten, BOM and LF kept), `__tests__/bayt.parse.spec.ts` (new), `__tests__/bayt.service.spec.ts` (new), `__tests__/bayt.e2e-spec.ts` (gated), `__tests__/fixtures/*.html` (new, synthetic) |
| `packages/models`               | (no change) |
| `packages/common`               | (no change) |
| registration files              | (no change — existing plugin) |

## 4. Dependencies

None new. `cheerio` (already used), `@ever-jobs/common` helpers from Specs 1696 and 1699.

## 8. Test Plan

- Unit (`bayt.parse.spec.ts`, 86 cases): slug table incl. transliteration and a linear-time
  guard, legacy slug encoding, URL builder and robots guard, market resolution, location
  parsing and promotion, id extraction, canonical URLs, posted labels, listing parsing,
  new and legacy mapping, fetch diagnostics, option resolution.
- Service (`bayt.service.spec.ts`, 30 cases): transport options and headers, search URLs,
  bad input, mapping, legacy switches, remote flag, dedup and stop rule, sleep placement,
  one-in-flight, offset, default results, page cap and its env var, every diagnostic row,
  `hoursOld`.
- Red control: mutating five fixes (timeout key, 200-challenge check, dedup, query strip,
  transliteration) fails 12 cases.
- E2E: `RUN_NETWORK_E2E=1` only.

## 10. Decisions

- **D-01 — Correctness and diagnostics only.** The listing is challenge-gated from our
  network; the plugin reports `blocked` and never tries to get past it.
- **D-02 — A non-market `country` is "unset".** See §1; `EVER_JOBS_BAYT_COUNTRY_SCOPE=false`
  restores the fixed `/en/international/` path.
- **D-03 — `offset` and `hoursOld` compose over the visible set.** `hoursOld` is applied
  first, then `offset`, so two calls with the same filters page through the same list.
- **D-04 — Freshness uses the label's age, not the rounded date.** "3 days ago" is at least
  72 h old; comparing the label's age (a lower bound) keeps a row whenever it could be in
  the window, matching the Spec 1696 freshness contract.
- **D-05 — Legacy switches keep old behaviour reachable, not old hazards.** The legacy slug
  still percent-encodes `/ ? # \`, and the robots guard applies to every mode.
- **D-06 — Page cap is configurable but bounded.** `EVER_JOBS_BAYT_MAX_PAGES` (1..50)
  replaces the pre-1710 "no cap but `resultsWanted`".

## 11. References

- `packages/common/src/converters/posted-time.ts` (Spec 1696)
- `packages/common/src/utils/location-parser.ts` (Spec 1699 `isoCountryNames`)
- `packages/models/src/dtos/scrape-diagnostics.dto.ts` (Spec 5082)
- `packages/common/src/http/http-client.ts` (`createHttpClient` scraper-input branch)
