# Spec: 1705 — Welcome to the Jungle: board-wide search, mapping fixes, credential self-heal

| Field          | Value                                          |
| -------------- | ---------------------------------------------- |
| Spec ID        | 1705                                           |
| Slug           | wttj-board-search-mapping-credentials          |
| Status         | done                                           |
| Owner          | agent                                          |
| Created        | 2026-09-25                                     |
| Last updated   | 2026-09-25                                     |
| Supersedes     | (none)                                         |
| Related specs  | 1689, 1695, 1696, 1697, 1698, 1699, 1700, 5018, 5082 |

## 1. Problem Statement

`source-ats-wttj` reads Welcome to the Jungle (welcometothejungle.com, about 90k live postings, 67%
located in France) through the public search index the site's own front-end uses. A live probe on
2026-09-24 (identifying user agent, three requests, two seconds apart) showed three problems.

**B — the hit mapping is wrong or thin.**

- The remote flag is a deny-list: every `remote` token except `no` counts as remote. The index uses
  `fulltime`, `partial`, `punctual`, `no` and `unknown`, so 78.4% of postings came out
  `isRemote: true` while only 6.9% are fully remote. `unknown` alone is 42.7% of the board.
- `key_missions` is a list of sentences on the wire. The type said `string`, and `cleanText()`
  returns `null` for an array, so the missions never reached the description. The summary was
  dropped whenever a profile existed.
- The structured salary (`salary_minimum` / `salary_maximum` / `salary_currency` /
  `salary_period`, present on a third of postings) was discarded.
- `jobType`, `countryCode`, `workFromHomeType`, the company logo, headcount, sectors and every
  office after the first were never set.
- The URL locale was the posting language, which the site does not serve for `de`, `it`, `pt`
  and a few others.

**A — the source cannot search.** Without a `companySlug` / `companyUrl` the plugin returned `[]`,
even though the same index answers keyword, city, country, remote, contract and date filters over
the whole board.

**C — a rotated key looks like an empty board.** Every HTTP status was mapped to "no hits". If the
public search key rotates, every company and every search returns zero jobs with reason `empty`,
and nothing tells an operator.

## 2. Goals

- Correct remote, description, salary, job-type, country and office mapping for every hit.
- Board-wide search through the existing registration, polite and within the index's limits.
- A refused key is re-read once from a public page, and otherwise reported as `blocked`.
- Every pre-1705 behaviour stays reachable through an env switch.

## 3. Non-Goals

- The thin job-board registration (`Site.WELCOMETOTHEJUNGLE`, a non-ATS plugin that joins the
  default fan-out and delegates to `scrapeBoard`). It touches the site enum, the plugin index,
  `tsconfig.base.json` and `jest.config.js`, which this lane does not own. `scrapeBoard` is the
  public entry point it will call through the registry.
- Detail-page enrichment (the full JSON-LD description, `descriptionDepth: 'detail-all'`).
- Radius search (`distance`) and time-window partitioning past the 1,000-hit window.
- A per-plugin crawl manifest: `IPluginMetadata` has no field for it yet.

## 4. User / Caller Stories

> As an **API caller**, I want **`siteType: ['wttj'], searchTerm: 'data', location: 'Paris'`** to
> return Paris data jobs, so that **I can search the board without knowing a company slug**.

> As a **caller filtering on remote**, I want **`isRemote: true` to mean fully remote**, so that
> **hybrid and unknown postings stop polluting remote searches**.

> As an **operator**, I want **a rotated key to heal itself or show up as `blocked`**, so that
> **a silent zero-job source is not mistaken for an empty board**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | B1: `fulltime` → `isRemote: true`, `workFromHomeType: 'Remote'`; `partial` / `punctual` → `false`, `'Hybrid'`; `no` (and `none` / `false` / `onsite`) → `false`, no free-text fallback; `unknown`, missing or any other token → the existing remote regex over title, office city / state and profession. | must |
| FR-2  | B2: description = `<p>summary</p>`, `<ul><li>` per mission, then the profile HTML, joined by `\n`, each only when present; text is HTML-escaped; a string `key_missions` is kept as a paragraph. | must |
| FR-3  | B3: structured salary first (`salary_minimum`/`maximum` + `getCompensationInterval(salary_period)`, else `salary_yearly_minimum` as a yearly floor), never without a three-letter currency; then `resolveCompensation` over the plain-text description. | must |
| FR-4  | B4: `contract_type` → `jobType` by table (see §10 D-01), then the shared vocabulary, then `OTHER`; `employmentType` unchanged. | must |
| FR-5  | B5: `countryCode` (primary office, validated alpha-2), `locations[]` (one per office, deduplicated, primary first), `companyLogo`, `companyNumEmployees`, `companyDescription`, `companyIndustry` (sector names, deduplicated), `jobFunction` (profession category), `experienceRange` when flagged. | must |
| FR-6  | B6: URL locale = posting language only when it is `en` / `fr` / `es` / `cs` / `sk`, else `en`. | should |
| FR-7  | A1: `scrapeBoard(input)` always runs board mode; with `WTTJ_BOARD_MODE=on` (opt-in since the review fixup, D-10), `scrape()` runs it when no company is given and a criterion is (`searchTerm`, `location`, `hoursOld > 0`, `isRemote: true`, `jobType`). By default, and with no criterion, `scrape()` without a company still returns `[]` with no request. A company keeps company mode, byte-identical request. | must |
| FR-8  | A2: criteria map to `query`, `facetFilters` and `numericFilters` (§7.1); user values lose `"`, control characters and a leading `-`. `country` filters only when it is not `USA` / `US_CANADA` / `WORLDWIDE`; a country in `location` wins. | must |
| FR-9  | A3: one index (`_en`; `_fr` only on HTTP 404 / 400), one page at a time, constant page size, pages never past the 1,000-hit window; `offset >= 1000` → `bad_input` with no request; a request the window cuts short while the board has more → `partial`. | must |
| FR-10 | C: HTTP 401 / 403, or 400 / a body `message` matching the refusal text, re-reads app id, key and index prefix from a public detail page (single-flight, at most once per 10 minutes) and retries the query once; otherwise `blocked`. | must |
| FR-11 | Transport failures and other HTTP errors stop the walk and return what was collected with `classifyScrapeError`; one malformed hit is logged and skipped. | must |
| FR-12 | Identifying user agent by default; `input.userAgent` overrides it. | must |

## 6. Non-Functional Requirements

| ID    | Requirement | Target |
| ----- | ----------- | ------ |
| NFR-1 | Pacing between index requests of one scrape | 0.5–1.0 s (a caller's slower pacing wins; since the Spec 1690 merge the 0.5 s minimum is also the client's `minIntervalFloorMs`, which no crawl-policy layer shortens) |
| NFR-2 | Concurrency per scrape | 1 request at a time |
| NFR-3 | Board requests per scrape | 1 page when `resultsWanted ≤ 100`, else ≤ `ceil(resultsWanted / 100) + 1`; plus at most one `_fr` fallback and one self-heal retry; never more than 50 |
| NFR-4 | Credential-page fetches | ≤ 3 per refresh, ≥ 2 s apart, ≤ 1 refresh / 10 min / process, no retries, redirects pinned to the site |
| NFR-5 | Request timeout | ≤ 15 s |
| NFR-6 | Payload | `attributesToRetrieve` limited to the mapped fields; no highlight / snippet |

## 7. Contracts

### 7.1 API / Interface

```ts
class WelcomeToTheJungleService implements IScraper {
  scrape(input: ScraperInputDto): Promise<JobResponseDto>;      // company mode, or board mode (FR-7)
  scrapeBoard(input: ScraperInputDto): Promise<JobResponseDto>; // board mode, always
}

// POST https://{appId}-dsn.algolia.net/1/indexes/{prefix}_en/query
interface BoardQueryBody {
  query: string;                      // searchTerm ('' = newest first)
  hitsPerPage: number;                // 1..100, constant per scrape
  page: number;
  facetFilters?: string[][];          // AND of OR-groups, in this order:
  //   ["offices.city:X", "offices.state:X"]   city (region alone: state first)
  //   ["offices.country_code:XX"]              country
  //   ["remote:fulltime"]                       isRemote / "Remote" location
  //   ["remote:partial", "remote:punctual"]     "Hybrid" location
  //   ["contract_type:…", …]                    jobType (reverse of the B4 table)
  numericFilters?: string[];          // ["published_at_timestamp>{now - hoursOld*3600}"]
  attributesToHighlight: [];
  attributesToSnippet: [];
  attributesToRetrieve: string[];
}
```

Env switches (read on every call):

| Variable | Default | Effect of the non-default value |
| -------- | ------- | ------------------------------- |
| `WTTJ_BOARD_MODE` | off | `on` / `true` / `1` / `yes`: `scrape()` without a company but with a criterion runs board mode (D-10); unset or anything else keeps the pre-1705 company-only `scrape()` |
| `WTTJ_REMOTE_MODE` | strict | `legacy`: the old deny-list `isRemote` (`workFromHomeType` is still set) |
| `WTTJ_DESCRIPTION_LAYOUT` | sections | `legacy`: the old body (string missions + profile, else summary) |
| `WTTJ_URL_LOCALE_GUARD` | on | `off`: the posting language is the URL locale, as before |
| `WTTJ_USER_AGENT_MODE` | honest | `browser`: the pre-1705 desktop-browser user agent |
| `WTTJ_CREDENTIAL_REFRESH` | on | `off`: never fetch a credential page; a refused key is `blocked` |
| `WTTJ_CREDENTIALS_SEED_URL` | (unset) | a detail page tried after the last served one and before the built-in seed |

`EVER_JOBS_POSTED_TIME_DETAIL` (Spec 1696) also applies to the new `datePostedAt` fields.

### 7.2 Errors

| Reason (`ScrapeDiagnostics`) | Meaning |
| ---------------------------- | ------- |
| `blocked` | The key was refused and could not be rediscovered (jobs collected before it are kept) |
| `partial` | Board mode: the 1,000-hit window cut the request short and the board has more matches |
| `bad_input` | Board mode: `offset >= 1000`; no request was made |
| `fetch_error` / `timeout` | Transport failure or HTTP error mid-walk (`classifyScrapeError`) |

## 8. Test Plan

- Unit `wttj.mapper.spec.ts` (44): remote matrix incl. the `unknown` regression and the legacy
  rule, all 11 contract tokens, salary shapes, description layouts, offices, company metadata,
  experience, URL locale.
- Unit `wttj.query.spec.ts` (28): the full filter set, country rules, remote / hybrid / region /
  unparseable locations, sanitising, `hoursOld`, page planning for every offset / size pair.
- Unit `wttj.credentials.spec.ts` (26): extraction, refusal detection, seed-URL safety and order,
  single-flight, cooldown, unchanged-key result, reset.
- Unit `wttj.service.spec.ts` (55): company request unchanged, B1–B6 through the service, every
  env switch, pacing and user agent, mode selection, board pagination and window, fallback and
  error paths, credential self-heal end to end (retry headers, one fetch for concurrent scrapes).
- Live `wttj.e2e-spec.ts`: two board cases added (tolerant, `resultsWanted <= 3`).
- Synthetic fixtures only: `__tests__/fixtures/wttj-hits.json` (8 invented hits),
  `__tests__/fixtures/wttj-detail-runtime-config.html` (~2 KB invented page).

## 9. Open Questions

- Whether `/{de|it|pt|…}/companies/…` URLs 404 (the B6 guard is defensive; not probed).
- The full set of `salary_period` values; unknown ones get no interval.
- Whether the company jobs page also embeds the runtime config (a longer-lived seed than a posting).
- The core text-salary parser returns nothing for `€32,000 - €36,000` and `32 000 €` while it
  reads `€32k - €36k` and `$32,000 - $36,000`; the fallback therefore misses many French
  descriptions. Belongs to the salary parser, not this plugin.

## 10. Decisions

- **D-01 — `apprenticeship` maps to `JobType.APPRENTICESHIP`.** The shared vocabulary gained a
  dedicated work-study member (Spec 1697) after this work was scoped; mapping it to `INTERNSHIP`
  would contradict the shared resolver. The board filter is the exact reverse of the table, so
  `INTERNSHIP` filters `contract_type:internship` and `APPRENTICESHIP` filters
  `contract_type:apprenticeship`.
- **D-02 — page size is the smallest size that fits the slice in one page.** `clamp(want, 1, 100)`
  alone reads `offset 130 + 20` as two 20-hit pages; the planner picks 25-hit page 5 instead. For
  more than 100 hits it is 100.
- **D-03 — "Hybrid" and region-only locations become filters.** The location parser returns
  `workFromHomeType: 'Hybrid'` with no place for "Hybrid", and a state code for a US state name;
  appending those to the free-text query would match nothing. Hybrid → `remote:partial|punctual`;
  a region → the caller's own spelling as `offices.state` / `offices.city`. "Worldwide" filters
  nothing. Only a location the parser cannot read at all goes into the query text.
- **D-04 — the window `partial` needs a board that has more.** A request the window cuts short is
  `partial` only when `nbHits` exceeds what was returned; otherwise the board simply ran out.
- **D-05 — the legacy browser user agent is opt-in only.** It is never switched to automatically
  on a 403; an operator must set `WTTJ_USER_AGENT_MODE=browser`. Since the Spec 1690 merge
  (2026-09-26) the plugin's UA is only *declared*: the configured crawl UA goes out under the
  default `identify` mode, so the switch also opts both clients into `userAgentMode: 'plugin'`
  (`WTTJ_BROWSER_UA_CRAWL_POLICY`); `EVER_JOBS_CRAWL_USER_AGENT_MODE=strict` still sends the
  configured UA, and a caller's `userAgent` (caller layer, `strict`) still decides what goes out.
- **D-06 — no retry with an unchanged key.** If the credential page yields the same key, the query
  is not retried (it would be refused again) and the result is `blocked`.
- **D-07 — company-mode transport failures now carry a diagnostic.** The jobs are unchanged; the
  `fetch_error` / `timeout` reason replaces an indistinguishable `empty`.
- **D-08 — posting instant (Spec 1696).** `datePostedAt` / precision / basis come from
  `published_at` (else the epoch timestamp) and are kept only when their day equals the
  `datePosted` the plugin always emitted.
- **D-09 — company mode keeps its request body byte for byte** (no `attributesToRetrieve`), so the
  existing behaviour and payload are untouched.
- **D-10 — Board mode in `scrape()` is opt-in (review fixup, 2026-09-25).** The site's robots.txt
  disallows its own search pages (`*/jobs?query=*`, `/*?`), and board mode searches the whole index
  on the search provider's host with the site's `Referer` / `Origin`. robots.txt does not govern
  that host, but the owner has not ruled (docs/questions.md Q-099), so `WTTJ_BOARD_MODE` now
  defaults to off and `on` enables it. `scrapeBoard()` itself is unchanged.

## 11. References

- `packages/plugins/source-ats-wttj/src/wttj.service.ts` — modes, walks, self-heal wiring.
- `packages/plugins/source-ats-wttj/src/wttj.mapper.ts` — B helpers.
- `packages/plugins/source-ats-wttj/src/wttj.query.ts` — A helpers.
- `packages/plugins/source-ats-wttj/src/wttj.credentials.ts` — C.
- `packages/plugins/source-ats-ashby/src/ashby.service.ts` — the `isRemote` = fully remote convention.
- `packages/common/src/utils/helpers.ts` — `resolveCompensation` (Spec 5018).
