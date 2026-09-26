# Spec: 1711 — BDJobs on the public JSON search and details API

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1711                                     |
| Slug           | bdjobs-public-json-api                   |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-25                               |
| Last updated   | 2026-09-25                               |
| Supersedes     | (none)                                   |
| Related specs  | 5082, 1689, 1696, 1698, 1699             |

## 1. Problem Statement

`source-bdjobs` scraped the legacy HTML search page `https://jobs.bdjobs.com/jobsearch.asp` with
cheerio card selectors. That page is gone: it now answers **302** to `https://bdjobs.com/h/jobs/`,
a script-rendered shell (`<base href=/h/>`) with none of the `div.job-item` /
`div.sout-jobs-wrapper` / `div.norm-jobs-wrapper` / `div.featured-wrap` cards and no `jobdetail`
links. `findJobListings()` returned `[]`, the loop logged "No more BDJobs listings found" and the
plugin returned `new JobResponseDto([], undefined)`, which the fan-out reads as a healthy, empty
board.

BDJobs is in `DEFAULT_SITE_NAMES`, so a default-search source had been returning zero jobs, with
no diagnostic, since the site moved. The live e2e spec did not notice: every assertion sat behind
`if (response.jobs.length > 0)`.

The new site is backed by two public JSON endpoints that need no auth, cookie or token:

| Endpoint | Probe (2026-09-24, honest User-Agent, 3 requests 3 s apart) |
| -------- | ------------------------------------------------------------ |
| `GET https://api.bdjobs.com/robots.txt` | 404: the API host has no robots file |
| `GET https://api.bdjobs.com/Jobs/api/JobSearch/GetJobSearch?keyword=developer&pg=1&rpp=30&isPro=0` | 200 JSON, 30 `data` rows + 1 `premiumData` row, `common.totalpages: 4` |
| `GET https://gateway.bdjobs.com/jobapply/api/JobSubsystem/Job-Details?jobId=1536338&ln=1` | 200 JSON, 3.15 s |

Both hosts sit behind a CDN that served no challenge to the honest User-Agent.

While rebuilding, the old code's mapping defects were fixed too: the **deadline** could become
`datePosted`; free-text dates went through `new Date(...)` (`"Sep 23, 2026"` became `2026-09-22`
on a Europe/Madrid host); details were fetched *before* the seen-id check; the page loop had no
cap; `jobType` / `companyIndustry` were copied from a helper that never returned them; and the
client lost its timeout whenever `proxies` was set.

## 2. Goals

- The default path scrapes the JSON API and returns real jobs for a default search.
- A board that answers with anything other than the expected JSON is a **diagnostic**, never a
  silent zero.
- Every field the old plugin produced is still produced; every new field is sourced from data the
  API actually returns.
- Polite by construction: honest User-Agent, one host at a time, sequential pages and details,
  a page cap, a details budget in calls and in wall-clock time.
- Nothing removed: the legacy HTML path stays selectable.

## 3. Non-Goals

- Server-side `location` (numeric ids), `postedWithin`, `jobNature` / `jobLevel` filters: their
  value sets are unverified (follow-ups F2, F3, F5).
- `rpp` above 30 (unverified, F4).
- A crawl-manifest declaration: `IPluginMetadata` has no `crawl` field in this tree yet (F1).
- Sub-day posting precision (`datePostedAt`): `publishDate` carries a `Z`, but whether it is UTC
  or Bangladesh wall-clock time is unproven (§9 Q2), so no instant is claimed.

## 4. User / Caller Stories

> As a **caller of a default fan-out**, I want **BDJobs to return Bangladeshi jobs again**, so
> that **the regional board contributes results instead of an invisible zero**.

> As an **operator**, I want **a dead or changed BDJobs endpoint to show up as
> `blocked` / `fetch_error` / `unknown` / `partial`**, so that **I can see it without reading
> logs**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | Search via `GetJobSearch` with `keyword` (trimmed, omitted when blank), `pg`, `rpp=30`, `isPro=0`, and `workplace=1` when `isRemote` is true. Empty params are not sent. | must |
| FR-2  | Page 1 unions `premiumData` (first) with `data`; one `seenIds` set spans every page. | must |
| FR-3  | `startPage = floor(offset / 30) + 1`; `offset % 30` rows of the first fetched page are skipped. | must |
| FR-4  | Stop when enough jobs are kept, at `common.totalpages`, on an empty page, on a page that adds **no new ids**, or after `min(needed + 2, BDJOBS_MAX_PAGES = 20)` page requests. | must |
| FR-5  | Client-side filters before any details call: `isRemote` (the row's `WorkPlace` must name home working), `jobType` (unknown types kept), `hoursOld` (every row judged; rows without a parseable ISO instant kept). `country` is ignored (the DTO default is USA; the board is Bangladesh-only). `location` is not filtered (neighbourhood labels). | must |
| FR-6  | Details (`Job-Details?jobId=&ln=1`) are a second, **sequential** pass over kept jobs only, bounded by `descriptionDepth` (`board` 0, `detail-25` 25 (default), `detail-all` all), by `BDJOBS_DETAIL_TIME_BUDGET_MS = 45 000` measured from the start of the scrape, and by 3 consecutive failures. Jobs not reached keep their list fields. | must |
| FR-7  | Output mapping per §7.1; list `jobDescription` (an education snippet) is never a description. | must |
| FR-8  | Diagnostics per §7.2. | must |
| FR-9  | `BDJOBS_MODE=html` (alias `BDJOBS_STRATEGY=legacy-html`) runs the legacy HTML scraper; default and unrecognised values run the API. Never an automatic fallback. | must |
| FR-10 | Honest headers: `User-Agent: Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)` (overridden by `input.userAgent`), `Accept: application/json`, `Accept-Language: en-US,en;q=0.8`. Redirects pinned to `bdjobs.com` (Spec 1689). | must |
| FR-11 | `requestTimeout` (default 30 s) is passed as both `timeout` and `requestTimeout`; `retries*` and `rateDelay*` pass through. | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Default run cost (`resultsWanted` 15, default depth) | 1 search + ≤ 15 details requests, sequential, ≤ ~50 s |
| NFR-2  | Fan-out deadline | details stop at 45 s from scrape start, well inside the 120 s fan-out deadline |
| NFR-3  | Parsing | no `new Date(freeText)`; every regex linear (whitespace collapsed before newline rules; salary input capped at 120 chars) |
| NFR-4  | Privacy | the details payload echoes the caller's public IP (`ClientIpAddress`): never mapped, never logged, scrubbed from fixtures |

## 7. Contracts

### 7.1 Output mapping (`bdjobs.parse.ts`)

| `JobPostDto` | Source |
| ------------ | ------ |
| `id` | raw `Jobid` (digits only; same id space as the legacy `jobid=` URL parameter, no prefix) |
| `title` | `jobTitle` → `JobTitleBng` (a Bangla-only title is kept verbatim); a row with neither is skipped. Details `JobTitle` fills an empty title. |
| `companyName` | `companyName` → details `CompanyNameENG` / `CompnayName` |
| `jobUrl` | `https://bdjobs.com/h/details/<Jobid>` (emitted, never fetched) |
| `applyUrl` | details `ApplyURL` when an absolute http(s) URL |
| `datePosted` | ISO prefix of `publishDate`; fallback details `PostedOn` via `parseMonthDayYear`. **Never** the deadline. |
| `compensation` | `Tk. <min>[ - <max>] (<Monthly|Yearly|Hourly|Daily|Weekly>)` → BDT, commas (lakh grouping) stripped, single figure min = max; `--` / empty / `Negotiable` → `null`. Details `JobSalaryMinSalary`/`Max` win when `ShowSalary === '1'` and an interval is known. |
| `jobType` | list `JobType` (`FullTime`, `Contract`) → fallback details `JobNature` with aliases `contractual`→contract, `full time`, `part time`, `internship`, `freelance`→contract |
| `isRemote` / `workFromHomeType` | `WorkPlace` (or details `JobWorkPlace` when the list is empty): home only → `true`/`Remote`; home and office (or `hybrid`) → `false`/`Hybrid`; else `false`. "Anywhere in Bangladesh" is **not** remote. |
| `location` / `locations` | `parseLocationList([label])`: `Bangladesh` for an empty label or "Anywhere in Bangladesh"; unchanged when it already ends in Bangladesh or names another country; else `<raw>, Bangladesh`. `location.text` = the raw label. Country is the display string `Bangladesh`. |
| `countryCode` | `BD` when the location is in Bangladesh |
| `description` | details present: body, then `Context`, `Education`, `Experience`, `Additional requirements`, `Benefits` sections (empty ones skipped), then `Deadline: <deadline>`; converted per `descriptionFormat` (HTML passthrough, PLAIN stripped, MARKDOWN and unset converted). Without details: list `jobContext` or `null`. |
| `skills` | details `SuggestedSkills` + `SkillsRequired`, split on `,`, trimmed, de-duplicated case-insensitively; unset if none |
| `experienceRange` | list `experience` unless `NA` |
| `vacancyCount` | details `JobVacancies` when present (`--` → `null`); without details the list `Vacancies` when > 0 |
| `companyLogo` | `logoUrl` when an absolute http(s) URL |
| `companyUrl` | details `CompanyWeb` (`https://` added when it has no scheme) |
| `companyAddresses` | details `CompanyAddress` unless `CompanyHideAddress === 'True'` |
| `companyIndustry` / `companyDescription` | details `CompanyBusiness`: a single line ≤ 150 chars is the industry; a longer profile becomes `companyDescription` |
| `emails` | emails in the description HTML ∪ details `ApplyEmail`, de-duplicated |
| `listingType` | `premium` when the row came from `premiumData` or `AdType === '2'` |

### 7.2 Errors

| Situation | Result |
| --------- | ------ |
| Page 1 throws (403 / 5xx / timeout / DNS) | `[]` + `classifyScrapeError(err)` |
| A later page throws | jobs so far + `classifyScrapeError(err)` (read as `partial`); details still run |
| 200 with a string/HTML body | challenge markers → `blocked` "challenge page instead of JSON"; else `fetch_error` "unexpected non-JSON search response" |
| 200 JSON without a `data` array | `unknown` "unexpected search response shape: <keys>" |
| `total_records_found === 0` / empty page | `[]`, no diagnostic (fan-out infers `empty`) |
| One details call fails, `JobFound !== 'True'`, or `Closed` | warn, keep the list-only job, no diagnostic |
| Every attempted details call fails (≥ 2 attempted) | `classifyScrapeError(lastErr)` attached |
| A malformed details body | counts as a failed call (`unknown` if all fail) |
| A row fails to map | logged with its `Jobid`, skipped |

### 7.3 Configuration

| Name | Values | Default |
| ---- | ------ | ------- |
| `BDJOBS_MODE` | `api` / `json` → JSON API; `html` / `legacy` / `legacy-html` → legacy HTML path; anything else → API with a warning | `api` |
| `BDJOBS_STRATEGY` | read only when `BDJOBS_MODE` is unset; `legacy-html` selects the legacy path | unset |

## 8. Test Plan

- Unit (`bdjobs.parse.spec.ts`, 88): salary table, TZ-safe dates under three `TZ` values, job
  type aliases, workplace, location labels, skills/emails, description assembly (order, linear on
  a long whitespace run), formats, list mapping, details enrichment, response interpretation,
  strategy resolution.
- Unit (`bdjobs.service.spec.ts`, 45): the 19 design cases (field mapping of 1536338, deadline
  regression, dedupe before details, bounded pagination incl. a server ignoring `pg` and a
  999-page board, offset, keyword, `isRemote`, `hoursOld`, `jobType`, depth budgets incl. the
  time budget, formats, not-found/closed, every diagnostic row, headers/client options) plus
  sequential-fetch and strategy-switch cases.
- Unit (`bdjobs.legacy-html.spec.ts`, 12): the legacy path under `BDJOBS_MODE=html`, its three
  design patches, the page cap, the shell/challenge diagnostics and honest headers.
- Live (`bdjobs.e2e-spec.ts`): 1 search + 2 details requests; unconditional assertions.
- Mutation controls run once: removing the seen-id check, reading `deadlineDB` as the posting
  date, dropping the no-new-ids stop, dropping the time budget, or ignoring a non-JSON body each
  turns the service suite red.

## 9. Open Questions

- **Q1.** Is `rpp > 30` honoured? Only 30 is used.
- **Q2.** Is `publishDate`'s `Z` real UTC? The leading date matches the site's own `PostedOn`
  either way, so `datePosted` is safe. Observed times (03:30–15:26 `Z`) fit Bangladesh office
  hours only if read as UTC, which suggests the `Z` is real, but `datePostedAt` stays unset until
  it is proven. `hoursOld` reads it as written, which is the later of the two readings and so
  never drops a fresh row.
- **Q3.** `premiumData` was only seen on page 1; the union + dedupe handles any page.
- **Q4.** Does list `Vacancies: 1` mean "unspecified"? With details, `--` wins (`null`).

## 10. Decisions

- **D-01 — `BDJOBS_MODE=api|html`.** The switch the lane was given; the design's
  `BDJOBS_STRATEGY=legacy-html` is honoured as an alias when `BDJOBS_MODE` is unset.
- **D-02 — Legacy constants stay in `bdjobs.constants.ts`**, marked `@deprecated`, rather than
  moving into `bdjobs.legacy-html.ts`: nothing is deleted and no import path changes. The old
  browser header set is kept as `BDJOBS_LEGACY_BROWSER_HEADERS` for reference only; **no path
  sends it**, the legacy path now identifies itself with the honest User-Agent.
- **D-03 — `BDJOBS_MAX_PAGES` caps requests, not the page number.** Read as an absolute page
  number, any `offset` ≥ 600 would fetch nothing.
- **D-04 — Premium rows first, and `offset` counts them.** They are the ads the site shows at
  the top of page 1; the skip applies to the de-duplicated first fetched page.
- **D-05 — Vacancies follow Q4:** a details `--` overrides the list count to `null`.
- **D-06 — Title fallback.** A row with neither list title is skipped before details (so the
  details `JobTitle` fallback only fills a title that is otherwise empty).
- **D-07 — Emails from the HTML.** The markdown converter escapes `_`, which would cut
  `first_last@x.com` short, so emails are read from the assembled HTML.
- **D-08 — Three consecutive details failures stop the pass**, so a down details host costs a
  few requests, not one per job; the all-failed diagnostic still fires.
- **D-09 — `CompanyBusiness` split.** Live verification showed some employers put a
  multi-paragraph company profile there; it goes to `companyDescription`, a short line to
  `companyIndustry`.
- **D-10 — Unset `descriptionFormat` is MARKDOWN** (the DTO default).
- **D-11 — Legacy path patched beyond the three design fixes:** a page cap, a stop on a page
  with no new ids (the old loop could spin forever on a server ignoring `pg`), a diagnostic when
  page 1 is the new site shell or a challenge, the honest User-Agent, and card dates parsed from
  the `BDJOBS_DATE_FORMATS` layouts without `new Date(...)`.
- **D-12 — Overseas labels.** A location label that already names another country is not given
  a Bangladesh suffix and gets no `countryCode`.

## 11. References

- `packages/plugins/source-bdjobs/src/` — `bdjobs.service.ts`, `bdjobs.parse.ts`,
  `bdjobs.types.ts`, `bdjobs.constants.ts`, `bdjobs.legacy-html.ts`
- `packages/models/src/dtos/scrape-diagnostics.dto.ts` — `classifyScrapeError`,
  `looksLikeChallenge`
- `packages/common/src/http/http-client.ts` — `createHttpClient`, `allowedRedirectHosts`
- Sibling patterns: `source-solidjobs` (description formats), `source-ats-kula_ai` (depth
  budget), `source-naukri` (offset → page)
