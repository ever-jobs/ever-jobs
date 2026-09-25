# Spec: 1713 — ZipRecruiter: region guard, geo-block diagnostics and the jobs-app response contract

| Field          | Value                                        |
| -------------- | -------------------------------------------- |
| Spec ID        | 1713                                         |
| Slug           | ziprecruiter-region-guard-response-contract  |
| Status         | done                                         |
| Owner          | agent                                        |
| Created        | 2026-09-25                                   |
| Last updated   | 2026-09-25                                   |
| Supersedes     | (none)                                       |
| Related specs  | 5082, 1695, 1696, 1699, 1700                 |

## 1. Problem Statement

`source-ziprecruiter` reads the ZipRecruiter mobile-app search endpoint
(`GET https://api.ziprecruiter.com/jobs-app/jobs`). ZipRecruiter lists US and Canadian jobs only,
and its app API refuses every request whose egress is outside North America. The plugin knew
neither fact, and it read its field names from a retired partner API. A probe on 2026-09-24 (honest
user-agent, three requests about 20 s apart, EU egress) confirmed:

- `https://api.ziprecruiter.com/robots.txt` and the `www` one are identical and deny `/` to
  `User-agent: *`. Even the allow-listed crawlers are denied `/jobs/` (the job-detail path),
  `/jobs-search` and `/apply/`.
- The retired partner endpoint `GET /jobs/v1` answers 404 `{"error":"not found"}` from the
  origin, so it is no fallback.
- The jobs-app endpoint answered HTTP 403
  `{"status_code":403,"error_code":"forbidden cf-waf","error_message":"Forbidden"}` to our egress.

Root causes in the plugin before this spec:

| Where | Before | Effect |
| --- | --- | --- |
| region | `input.country` never read | a Germany or UK search still called the API |
| client | `createHttpClient(input)` without a cookie jar | the session event's cookies were thrown away |
| session event | JSON object | the endpoint expects a form-encoded body with repeated `property=<k>:<v>` |
| pagination | read `continue_token` | the response key is `continue`: the loop always stopped after page 1 |
| id | `job.job_id ?? job.id` | the id is `listing_key`: every job could be skipped, a silent zero |
| 403 | `classifyScrapeError(err)` | the `cf-waf` body was lost: a geo restriction looked like anti-bot |
| query | `radius_miles`, `days_ago`, `form`, `continue_token` | retired names; the endpoint reads `radius`, `days`, `continue_from`; `isRemote` and `easyApply` were never sent |
| location | raw `job_country` | `'CA'` is ambiguous with California; not normalised |
| salary | `salary_min_annual` / `salary_max_annual`, always `YEARLY` / `USD` | never populated; hourly CAD pay would be labelled yearly USD |
| job type | `replace('_', '')` | replaced only the first `_` |
| remote | `(job.remote ?? '').toLowerCase()` | a boolean `remote: true` threw, and the per-job catch dropped every remote job |
| link | `job.job_url ?? job.url ?? ''` | an empty `jobUrl` breaks dedup downstream |
| date | raw ISO string | not the date-only `datePosted` every other source emits |
| offset | ignored | |

A caught 403 never reaches the circuit breaker: the plugin resolves with diagnostics, and
`CircuitBreakerService.exec` counts only thrown errors. So nothing stopped each search from repeating
a request known to fail. The only e2e test asserted nothing when zero jobs came back.

## 2. Goals

- Do not search where the board cannot serve: non-North-American countries return `bad_input`
  with **no** request.
- Name a geo-block exactly (`blocked`, detail naming `cf-waf` and the North-America-only rule), and stop repeating
  it from the same egress for 30 minutes.
- Read the response contract the endpoint actually uses: `continue` / `continue_from`,
  `listing_key`, `compensation_*`, `buyer_type`, boolean `remote`.
- Honour `offset`, `isRemote`, `easyApply` and `hoursOld` (exactly, on the client).
- No new crawl surface; fewer requests than before, never more.

## 3. Non-Goals

- No job-detail fetch. robots.txt disallows `/jobs/` for every agent, so the description and links
  come from the list payload only, and `jobUrlDirect` stays `null` unless that payload carries one.
- No new header, user-agent or device identity. The header set is unchanged (section 9, Q1).
- No `crawl` manifest field on `@SourcePlugin`; another branch is adding the field. Suggested value
  for when it exists: `{ maxConcurrentPerHost: 1, minIntervalMs: 5000 }`.
- No change outside `packages/plugins/source-ziprecruiter` (the MCP tool description is left to
  its owner, section 9, Q4).

## 4. User / Caller Stories

> As an **API caller searching Germany**, I want ZipRecruiter to say it serves the US and Canada
> only, so that an empty row is not mistaken for "no jobs".

> As an **operator on an EU egress**, I want the diagnostic to say the API refuses requests from
> outside North America, and the plugin to stop re-asking, so that the cause is obvious and the host
> is not hammered.

> As a **caller in the US**, I want more than the first 20 jobs, with salary, remote flag and a
> working link on each.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `country` outside `{USA, CANADA, US_CANADA, WORLDWIDE}` (unset allowed) returns `[]` + `bad_input` naming US/Canada, before any client is created. | must |
| FR-2  | A 403 whose body `error_code` contains `cf-waf` returns `blocked` with the geo detail, on the session POST or any search page. | must |
| FR-3  | After a geo-block, the same egress (`JSON.stringify(input.proxies ?? [])`) makes no request for 30 min and returns the geo detail plus "not retried until <ISO>". A different proxy list is not suppressed. The memo holds at most 64 egresses. | must |
| FR-4  | A geo-blocked session POST skips the search GET. Any other session failure is logged at warn and the search runs. | must |
| FR-5  | Session event: by default the pre-1713 JSON event on a client without a cookie jar (D-10). Opt-in (`ZIPRECRUITER_SESSION_EVENT=form`): form-encoded `event_type=session`, `logged_in=false`, `number_of_retry=1` and one `property=<k>:<v>` per property, on a client created with `cookies: true`. `off` sends none. | must |
| FR-6  | Query: `search`, `location`, `radius`, `days = max(1, ceil(hoursOld / 24))`, `employment_type` (omitted when unmapped), `remote=1`, `zipapply=1`, `continue_from`. | must |
| FR-7  | Pages are sequential, 5-10 s apart, at most `min(10, ceil((offset + resultsWanted) / 20) + 1)`. Stop on: enough jobs, an empty page, no token, a page with no new ids, the cap, or an error. | must |
| FR-8  | Output: `id = zr-<listing_key>` (fallback `job_id`/`id`), `jobUrl = https://www.ziprecruiter.com/jobs//j?lvk=<key>` (double slash kept; fallback `job_url`/`url`; never `''`), `countryCode`, `location`/`locations` from a label whose country code is mapped to a name first, `compensation` from `compensation_*`, `datePosted` date-only, `listingType = buyer_type`, `isRemote`, `workFromHomeType`. | must |
| FR-9  | `offset + resultsWanted` unique jobs are collected and `slice(offset)` returned. | must |
| FR-10 | With `hoursOld`, jobs whose `posted_time` is older than `now - hoursOld` are dropped; jobs without one are kept. | should |
| FR-11 | A page error after jobs were collected returns those jobs and the diagnostics (the fan-out marks the source `partial`). | must |
| FR-12 | A page whose records all lack an id, title or link returns `unknown` with a detail, not a silent zero. A non-JSON body returns `blocked` when it looks like a challenge page, else `unknown`. | should |
| FR-13 | Every behaviour change can be switched back by env var (section 7.3). | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Requests from a non-NA egress | 1 per 30 min per egress (was 2 per search) |
| NFR-2  | Requests for an unsupported country | 0 |
| NFR-3  | Concurrency against the host | 1 (sequential pages, no detail fetch) |
| NFR-4  | Unit suite | offline, no timers, under 20 s |

## 7. Contracts

### 7.1 Endpoint

`GET https://api.ziprecruiter.com/jobs-app/jobs` → `{ jobs: ZipJob[], continue?: string | null }`.
`ZipJob` fields read: `listing_key`, `name`, `job_description`, `hiring_company.{name,url,logo}`,
`job_city`, `job_state`, `job_country` (`US`/`CA`), `employment_type`, `posted_time`,
`compensation_min`, `compensation_max`, `compensation_interval`, `compensation_currency`,
`buyer_type`, `remote`, `apply_url`, `save_job_url`. Retired names read only as fallbacks:
`job_id`, `id`, `title`, `snippet`, `job_url`, `url`, `salary_min_annual`, `salary_max_annual`,
`continue_token`. Types live in `src/ziprecruiter.types.ts`.

`POST https://api.ziprecruiter.com/jobs-app/event`, `Content-Type: application/x-www-form-urlencoded`.

### 7.2 Errors

| Response | Diagnostic |
| --- | --- |
| 403 + `error_code` containing `cf-waf` | `blocked`: `geo-restricted: the ZipRecruiter app API refuses requests from outside North America (HTTP 403 forbidden cf-waf)` |
| other 403, 401 | `blocked` (shared classifier) |
| 429, 5xx | `fetch_error` (the HTTP client already retries 429 and honours `Retry-After`) |
| unsupported country | `bad_input`: `ZipRecruiter serves US/Canada only; country <C> not searched` |

### 7.3 Options (env, read on every scrape)

| Env var | Default | Restores |
| --- | --- | --- |
| `ZIPRECRUITER_REGION_GUARD` | on | `false`/`0`/`off`/`no`: search every country |
| `ZIPRECRUITER_GEO_BLOCK_TTL_MS` | `1800000` | `0`: no memo, every scrape tries again |
| `ZIPRECRUITER_MAX_PAGES` | derived, capped at 10 | a positive integer replaces the whole page budget |
| `ZIPRECRUITER_LEGACY_PARAMS` | off | `true`/`1`/`on`/`yes`: JSON session event and `radius_miles` / `days_ago` / `form` / `continue_token`, no `remote` / `zipapply`, `employment_type=''` for an unmapped type |
| `ZIPRECRUITER_HOURS_FILTER` | on | `false`/`0`/`off`/`no`: keep the server's whole-day superset |
| `ZIPRECRUITER_SESSION_EVENT` | `json` | `json`: the pre-1713 JSON session event without a cookie jar (the default); `form`: the app-shaped form-encoded event on a cookie-enabled client (opt-in, D-10); `off`: no session event |

The Spec 1696 switch `EVER_JOBS_POSTED_TIME_DETAIL=false` drops the new `datePostedAt` /
precision / basis keys.

## 8. Test Plan

- Unit `__tests__/ziprecruiter.service.spec.ts` (54 cases, synthetic fixtures in
  `__tests__/fixtures/`): region guard (no client, no request), pagination (`continue_from`, no
  `continue_token`, loop guard, empty page, page cap, page budget, env cap, offset), field mapping
  (annual USD, hourly CAD, `contractor`, CA is Canada, dropped id-less record, boolean/string
  `remote`, formats, `jobUrlDirect`, retired-field fallbacks, currency defaults), query names,
  `hoursOld` filter and its switch, session body, geo-block on search and session, memo TTL/egress/
  bound/off, plain 403, 429, partial, all-invalid page, non-JSON bodies, option parsing. Run against
  the pre-1713 service, 44 of the 54 fail.
- E2E `__tests__/ziprecruiter.e2e-spec.ts`: an ungated offline case (Germany → `bad_input` in under
  1 s, no network) and a live case behind `RUN_NETWORK_E2E=1` that fails on a bare zero.
- The fixtures are synthetic: no 200 page can be captured from our egress. Replace them with a
  trimmed real page (< 50 KB) once section 9, Q2 is run.

## 9. Open Questions

Verification from a US or Canadian egress (owner or a US proxy; at most 3 requests, a few seconds
apart). Recorded for `docs/questions.md` by the integrator.

- **Q1 — Request identity.** Does the search answer 200 with our honest user-agent plus the Basic
  credential? If it is 403 from the US too, the app identity is required, and whether to send it is an
  owner decision given the robots stance. (default — proceeding: headers unchanged)
- **Q2 — Contract.** Confirm `continue` / `continue_from` and the page size (assumed about 20).
- **Q3 — Credential.** Confirm the Basic credential is accepted. On 401 it needs refreshing.
- **Q4 — Filter values.** Confirm `employment_type` values for contract, temporary and internship.
  (default — proceeding: the pre-1713 values `contractor`, `temporary`, `intern`; an unmapped type
  sends no filter)
- **Q5 — MCP description.** `apps/mcp/src/tools.ts` could say "US/Canada job board (requires
  North-American egress)". Left to that file's owner.
- **Q6 — Ops (live change, needs a board claim).** Our fleet's egress is in the EU and
  `zip_recruiter` is in the default site set with `DEFAULT_COUNTRY=USA`, so the region guard does not
  stop the per-search 403; the memo cuts it to about one request per 30 min per pod. Either disable
  the source for our deployment (`EVER_JOBS_DISABLED_SOURCES`), drop it from `DEFAULT_SITE_NAMES`,
  or give it a North-American proxy (proxies are global today).

## 10. Decisions

- **D-01 — `bad_input`, not `blocked`, for an unsupported country.** The request asked for something
  the board cannot serve; nothing refused us.
- **D-02 — A geo-block stays `blocked`.** From the operator's side the egress really was refused; the
  detail names the cause and the fix.
- **D-03 — Memo keyed by proxy list, in the plugin.** The breaker cannot see a caught 403, and a
  different proxy is a different egress. Bounded to 64 entries so caller-supplied proxy lists cannot
  grow it without limit.
- **D-04 — Session properties are the pre-1713 values, re-encoded.** The form body carries the same
  `device_make` / `device_model` / `device_os` / `device_form_factor` / `platform` values the JSON
  event already sent, plus `locale` and a timestamp. No app build, screen or manufacturer values
  were added: the crawl policy forbids adding device identity. If Q1 finds the endpoint needs more,
  that is the same owner decision as the user-agent.
- **D-05 — `employment_type` values kept.** The pre-1713 values are unverified, not disproved, and
  `contractor` is also the response's own vocabulary. Only the `''` sent for an unmapped type is
  gone (omitted instead), except in legacy mode.
- **D-06 — Posting time through Spec 1696.** `datePosted` is exactly what `toDateOnly` gives;
  `postedFromTimestamp` + `postedTimeFields` also carry the `Z` instant as `datePostedAt`
  (`exact` / `timestamp`).
- **D-07 — Salary period through Spec 1695.** `intervalFromPeriodToken` reads `annual`, `hourly` and
  longer labels (`per hour`); unknown labels default to `YEARLY`. A currency-less salary defaults to
  CAD for `CA` jobs, USD otherwise.
- **D-08 — A job with no link is dropped.** An empty `jobUrl` breaks dedup. Such records count as
  skipped, and a page of only skipped records is reported as `unknown`.
- **D-09 — `ZIPRECRUITER_MAX_PAGES` replaces the budget.** Unset, the page budget is derived from
  `offset + resultsWanted` and capped at 10; set, the operator's number is the budget.
- **D-10 — The app-shaped session event is opt-in (review fixup, 2026-09-25).** The form-encoded
  event on a cookie jar is what makes the app handshake succeed, so it makes the app identity more
  convincing. Whether to keep that identity at all is an open owner decision (section 9, Q1, and
  `docs/questions.md` Q-099), so the default stays the pre-1713 JSON event without a cookie jar,
  and `ZIPRECRUITER_SESSION_EVENT=form` opts in. The geo-block detail states the fact only; it no
  longer tells callers how to get around the restriction.

## 11. References

- `packages/plugins/source-ziprecruiter/src/ziprecruiter.service.ts`, `.constants.ts`, `.types.ts`
- `packages/models/src/dtos/scrape-diagnostics.dto.ts` (`classifyScrapeError`, `looksLikeChallenge`)
- `packages/common/src/http/http-client.ts` (`cookies`, 429 retry with `Retry-After`)
- `packages/common/src/converters/posted-time.ts` (Spec 1696), `packages/common/src/utils/helpers.ts`
  `intervalFromPeriodToken` (Spec 1695), `packages/common/src/utils/location-parser.ts` (Spec 1699)
- `packages/plugin/src/circuit-breaker/circuit-breaker.service.ts` (counts thrown errors only)
