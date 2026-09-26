# Spec: 1706 — Internshala: a search that searches, one posting per card, and honest paging

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| Spec ID        | 1706                                    |
| Slug           | internshala-search-parsing-pagination   |
| Status         | done                                    |
| Owner          | agent                                   |
| Created        | 2026-09-25                              |
| Last updated   | 2026-09-25                              |
| Supersedes     | (none)                                  |
| Related specs  | 1695, 1696, 5082, 5024                  |

## 1. Problem Statement

`source-internshala` is in the API's default site list, so every default search calls it. It
has been returning the wrong thing:

- **The search term and location were ignored.** The plugin built `/jobs/<term>`,
  `/jobs/<term>-in-<city>` and a `/work-from-home` suffix. None of these is a site route; the
  site redirects them to the unfiltered `/jobs/` feed, so every search returned the generic
  feed (and `page-N` was appended to a dead path).
- **Every posting was emitted twice.** The card selector matched both the card container and
  its `.internship_meta` child (80 matches for 40 cards on a probed page), so
  `resultsWanted=15` gave about 8 distinct postings.
- **Internships, the board's main content, never appeared** unless `jobType=internship`.
- The id was a hash of the URL although the card carries the site's own posting id.
- No pay, posted date, skills, job type, listing type, logo or experience was mapped, so
  `hoursOld` could not work; the location was the raw text of the whole location row
  (multi-city strings, "Work from home" as a city); `isRemote` was read from the whole card
  text, so a snippet mentioning "WFH" made an onsite job remote.
- Paging had no cap, no last-page check and no duplicate stop; a listing error was swallowed
  and the result reported as `empty` rather than `blocked` / `timeout`.
- A hard-coded browser user agent overrode `input.userAgent`, and a detail page was fetched
  for every result regardless of `descriptionDepth`.

A live probe on 2026-09-24 (honest identifying UA, three requests at least 2 s apart) showed
`/jobs/keywords-python/` and `/internships/keywords-python/` answering 200 with filtered
results and a canonical equal to the request, and robots.txt allowing `/jobs/…/`,
`/internships/…/`, `/job/detail/…` and `/internship/detail/…` while disallowing any URL with a
comma, a query string, `%3F` or `%3D`.

## 2. Goals

- A filtered search (`searchTerm`, optional city / work-from-home / job type narrowing).
- Internships and jobs together by default, with `listingType` and `jobType` set.
- One `JobPostDto` per posting with a stable `is-<postingId>` id.
- INR `CompensationDto`, `datePosted` (plus the Spec 1696 precision fields), `skills`,
  per-site `locations[]`, `workFromHomeType`, `experienceRange`, `companyLogo`.
- Polite paging: sequential, 2–5 s apart, hard page cap, stop on last / empty / no-new-id pages.
- Partial results with a diagnostics reason instead of a silent empty list.
- Only robots.txt-allowed paths, enforced by a guard and tested.

## 3. Non-Goals

- No new site enum, registration or module wiring (all already in place).
- No browser automation, challenge solving or fingerprint headers.
- Indian state names in the location row stay in the city slot (the shared parser does not
  know Indian states).
- README / CHANGELOG / `docs/index.md` / `docs/log.md` rows are the integrator's.

## 4. User / Caller Stories

> As an **API caller**, I want `searchTerm=python&location=Bangalore` on Internshala to return
> Python postings in Bangalore, so that the board contributes relevant results to a fan-out.

> As an **operator**, I want a blocked or timed-out Internshala run to say so, so that an empty
> result is not mistaken for an empty board.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | Keyword listing `/{jobs,internships}/keywords-{kw}/` with `{kw}` = the term cleaned of `, ? = & # / % \`, lower-cased and URL-encoded (`data%20science`); `page-N/` from page 2; the root listing when there is no term. | must |
| FR-2  | Narrow forms for a city (`{slug}-jobs-in-{city}` / `{slug}-internship-in-{city}`, or `jobs-in-{city}` / `internship-in-{city}`) and work from home (`work-from-home-{slug}-jobs` / `…-internships`); remote wins over a city; a term whose slug would change its meaning (`c++`) uses the keyword form. | must |
| FR-3  | Canonical guard: a filtered request answered with the bare root (canonical tag or final response URL) discards the page; a narrow stream switches to the keyword form, a keyword stream stops with `fetch_error`. A 404/410 on a narrow path also switches. | must |
| FR-4  | Client-side filters on every page: work from home, city (with aliases both ways), part time (`PART_TIME` only / `FULL_TIME` excluded) and `hoursOld` (drop when the posted-age lower bound exceeds it; unknown ages kept). | must |
| FR-5  | `jobType`: unset → both streams; `INTERNSHIP` → internships; `FULL_TIME` → jobs; `PART_TIME` → both + filter; anything else → no request, `empty` diagnostics naming the value. | must |
| FR-6  | Streams alternate one page per round (internships first); a stream stops on 0 cards, no unseen id, `isLastPage=1`, the highest pagination page, the page cap, or a guard stop. Round-robin merge, then `offset`, then `resultsWanted`. | must |
| FR-7  | Card mapping per the table in the plan; one card per `div.individual_internship`; `internshipId` read through the lower-cased attribute. | must |
| FR-8  | Pay only from the pay row (`span.stipend`, else `span.mobile`, else `span.desktop`), never the post-internship offer label; Indian digit grouping; no period → job yearly / internship monthly; lump sum → `interval: null`; "Unpaid" / "Competitive salary" → `null`. | must |
| FR-9  | Posted date from the relative label; a detail-slug epoch refines it only when it falls inside the label's bucket (± slack). | must |
| FR-10 | Detail pages fetched sequentially for the first `descriptionDepth` postings (`board` 0, `detail-25` default, `detail-all`); a failure keeps the card snippet. | must |
| FR-11 | Every listing and detail URL passes the robots guard (allowed prefixes, no `?` `,` `#` `%3F` `%3D`, no disallowed prefix, no dot segments). | must |
| FR-12 | Old behaviour stays reachable: `INTERNSHALA_DEFAULT_STREAMS=job` (jobs-only default), `INTERNSHALA_ID_SCHEME=url-hash` (old ids), `descriptionDepth: 'detail-all'` (a detail per result), `userAgent` (any UA). | must |

## 6. Non-Functional Requirements

| ID    | Requirement | Target |
| ----- | ----------- | ------ |
| NFR-1 | Requests for a default search (15 results, no filters) | 2 listing + ≤ 15 detail |
| NFR-2 | Listing requests per stream | ≤ 10 (env override 1–50) |
| NFR-3 | Spacing | sequential, `randomSleep(2000, 5000)` between any two requests |

## 7. Contracts

### 7.1 Interface

`InternshalaService.scrape(input: ScraperInputDto): Promise<JobResponseDto>` (unchanged). The
package also exports its pure helpers (`internshala.parser.ts`), constants and types.

Environment switches (read on every scrape):

| Variable | Values | Default | Effect |
| -------- | ------ | ------- | ------ |
| `INTERNSHALA_DEFAULT_STREAMS` | `both`, `job`, `internship` | `both` | Streams for a search without `jobType`; `job` is the pre-1706 default. |
| `INTERNSHALA_ID_SCHEME` | `posting`, `url-hash` | `posting` | `url-hash` emits the pre-1706 `is-<hash(jobUrl)>` ids. |
| `INTERNSHALA_MAX_PAGES` | `1`–`50` | `10` | Listing requests per stream. |
| `INTERNSHALA_SLUG_TIMESTAMP` | `false`/`0`/`off`/`no` to disable | on | Detail-slug epoch refinement of the posted date. |

`EVER_JOBS_POSTED_TIME_DETAIL` (Spec 1696) still controls the three posted-time detail fields.

### 7.2 Diagnostics

| Reason | When |
| ------ | ---- |
| `empty` (with detail) | `jobType` has no equivalent; no request made |
| `blocked` / `timeout` / `fetch_error` / … | first listing or detail error, via `classifyScrapeError` (upstream reports `partial` when jobs exist) |
| `fetch_error` | the keyword search itself was answered with the unfiltered root |
| `blocked` | a page with no cards that looks like a challenge interstitial |
| (unset) | no cards and no error (upstream reports `empty`) |

## 8. Test Plan

- Unit (`internshala.parser.spec.ts`): URL builder and robots guard (T1), card count (T2),
  ids (T3), locations (T4), pay (T5), posted date (T6), page signals and canonical (T7), DTO
  mapping, filters, plan, options, merge, detail body.
- Service (`internshala.service.spec.ts`, mocked client): streams and alternation (S1),
  `jobType` (S2), stop rules and cap (S3), canonical guard (S4), filters and offset (S5),
  detail budget (S6), diagnostics (S7), HTTP client options (S8), DI (S9), legacy ids.
- E2E (live, ≤ 3 results, `board`): keyword relevance and INR currency; a multi-word
  internship search.
- Fixtures are synthetic (listing structure, invented companies and text).

## 9. Open Questions

- Should `JobType.SUMMER` map to the internship stream? It currently returns the `empty`
  diagnostic like any other unsupported value.
- The site canonicalises a multi-word keyword to hyphens (`keywords-data-science/`) while
  answering the `%20` form with the filter applied; the plugin keeps `%20` (verified) and the
  guard treats the difference as an accepted mismatch.

## 10. Decisions

- **D-01 — Honest default UA.** With no `input.userAgent` the plugin sends an identifying UA
  (`compatible; EverJobs/1.0; +…`), which the probe showed is served normally. The previous
  browser UA stays reachable through `userAgent`. No header beyond `accept` /
  `accept-language` is set.
- **D-02 — Old path forms are not kept behind a switch.** They are not site routes (the site
  redirects them to the unfiltered feed, which stays reachable with an empty `searchTerm`), and
  a location with a comma produced a robots-disallowed URL.
- **D-03 — Duplicate emission and the whole-card remote heuristic are not kept.** Both are
  defects with no consumer value; the id scheme and the jobs-only default, which consumers may
  depend on, are kept behind switches.
- **D-04 — A round fetches one page per active stream before checking the target**, so a
  default search returns both kinds for two listing requests.
- **D-05 — `isRemote` ignores the city.** A work-from-home posting has no city, so combining
  both filters would return nothing.
- **D-06 — The slug epoch sets an exact instant** (`timestamp` basis) only inside the label's
  bucket `[lowerH − 24 h, lowerH + width + 168 h]`; out-of-window digits (a re-posted aggregated
  job, digits of a company name) fall back to the label. `INTERNSHALA_SLUG_TIMESTAMP=false`
  turns it off.
- **D-07 — Pay periods go through `intervalFromPeriodToken` (Spec 1695)**, so `per month`,
  `/day` and friends map like elsewhere; amounts through `parseSalaryNumber(…, 'anglo')`,
  which reads Indian digit grouping (`10,20,000`). `extractSalary` is not used: it has no INR
  token and its upper limit rejects valid yearly INR ranges.
- **D-08 — Only page 1 can lose the filter.** A later page answered with the root, or with
  404/410, is past the end of the results: the stream stops without a diagnostic. On page 1 a
  404 on a narrow path switches to the keyword form, and on the keyword form it is reported
  (`bad_input`).
- **D-09 — Detail pages stop at a refusal (review fixup, 2026-09-25).** A 403, a 429 or a
  challenge page on a detail request ends the detail walk (the snippets are kept and the refusal
  is the diagnostic), and so do three failed detail requests in a row. `detail-all` is capped at
  100 detail requests (`INTERNSHALA_MAX_DESCRIPTION_FETCHES`), so FR-12's "a detail per result"
  holds for up to 100 results.
- **D-10 — The apply-by deadline is still read (review fixup).** The pre-1706 parser added
  `Apply by: <date>` to the description from `.apply_by .item_body` / `.ic-16-clock + span`. The
  cards in today's listings (the trimmed probe fixtures) carry neither element, but the card
  parser still reads both selectors and adds the same line when a card shows one, so nothing the
  old parser emitted is dropped.

## 11. References

- `packages/plugins/source-internshala/src/` — constants, types, parser, service.
- `packages/common/src/converters/posted-time.ts` (Spec 1696), `packages/common/src/utils/helpers.ts` (Spec 1695).
- `packages/models/src/dtos/scrape-diagnostics.dto.ts` (Spec 5082).
