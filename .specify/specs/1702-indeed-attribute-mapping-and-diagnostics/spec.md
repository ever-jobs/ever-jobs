# Spec: 1702 — Indeed: remote, job type and location from the right fields, and no silent empty results

| Field          | Value                                     |
| -------------- | ----------------------------------------- |
| Spec ID        | 1702                                      |
| Slug           | indeed-attribute-mapping-and-diagnostics  |
| Status         | done                                      |
| Owner          | agent                                     |
| Created        | 2026-09-25                                |
| Last updated   | 2026-09-25                                |
| Supersedes     | (none)                                    |
| Related specs  | 1696, 1697, 5082, 5024                    |

## 1. Problem Statement

`source-indeed` maps a `jobSearch` job onto `JobPostDto` with rules that cannot match what the
endpoint sends, and it hides failed requests as empty results.

| # | Where (HEAD `a243b1b9`) | What is wrong | Effect |
|---|---|---|---|
| R1 | `indeed.utils.ts` `isJobRemote` | Compares `attributes[].key` with `'remotejob'`. Keys are opaque 5-character codes; the Remote workplace attribute is `DSQF7` (the public site's own Remote filter is `sc=0kf:attr(DSQF7);`). | `isRemote` is always `false`. |
| R2 | `indeed.service.ts` `processJob` | `location.formatted.long` is requested but never read. | "Remote in Austin, TX 78701" is reported on-site; the label is lost. |
| R4 | `indeed.utils.ts` `getJobType` | Keeps attributes whose key starts with `'job-types'`. Keys are codes (`CF3CP` = Full-time). | `jobType` is always `null`. |
| R8 | `indeed.service.ts` scrape loop | A 200 with `errors` and no `data.jobSearch` logs and `break`s with no diagnostics; an HTTP error is classified from the generic client message only, so the GraphQL error text and the block-page evidence are lost. | A broken or blocked source looks "empty". |
| P1 | `indeed.service.ts:171,182` | `toDateOnly(datePublished)` drops the exact instant the endpoint gives, and returns `null` for a numeric-string timestamp. | No `datePostedAt` (Spec 1696); a string timestamp loses the date entirely. |
| P2 | scrape loop | No page cap, and a sleep before the `resultsWanted` check. | `resultsWanted: 5000` pages 50 times; one extra 5–10 s sleep per scrape. |

Live evidence (2026-09-24 and 2026-09-25): every POST to `https://apis.indeed.com/graphql` from our
egress is answered with a 403 edge block page ("Sorry, you have been blocked"), both with an honest
user agent and with the plugin's existing headers. The GraphQL response shape below is therefore
taken from the requested document, and the fixtures are synthetic.

## 2. Goals

- Decide remote / hybrid from the job's **workplace attribute** and the **head of its formatted
  location** only. Never the description, never the title.
- Resolve `jobType` from the employment-type attribute **codes**, then from whole-label aliases.
- Use `location.formatted.long`: keep it verbatim in `LocationDto.text`, carry `postalCode`, and
  parse it for geography only when the job has no structured city/state/country.
- Make every failed request a `ScrapeDiagnostics`: block pages → `blocked`, GraphQL validation →
  `bad_input` naming the field, anything else → `unknown`. Keep jobs already collected
  (upstream infers `partial`).
- Adopt the Spec 1696 posted-time helpers: `datePublished` is an exact instant.
- Keep every pre-1702 behaviour reachable behind a switch.

## 3. Non-Goals

- **The GraphQL request is not changed.** The document, its variables, the `filters` value, the
  headers, the API key and the user agent are byte-identical to HEAD. Every live POST was
  edge-blocked, so a rework could not be verified (Q-1702-1). A test pins the request.
- No local post-filter for `isRemote` / `jobType` (Q-1702-4).
- No currency change: `estimated.currencyCode` is not requested by the current document (Q-1702-3).
- No `offset` support and no per-page `limit` change: both live in the document (Q-1702-3).
- No new browser-like headers, no challenge handling. A block is reported, never worked around.

## 4. User / Caller Stories

> As a **job seeker filtering on remote work**, I want **`isRemote` to be true for jobs the board
> itself labels Remote**, so that **remote jobs are not discarded as on-site**.

> As an **operator**, I want **a blocked or rejected Indeed request to say so in diagnostics**, so
> that **I can tell a broken source from an empty search**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `isRemote` is true when an attribute key is `DSQF7` (or the legacy `remotejob`), when a WHOLE attribute label is a remote word (`Remote`, `Fully remote`, `100% remote`, `Temporarily remote`, `Work from home`, `WFH`), or when `formatted.long` (else `.short`) starts with `Remote` / `Temporarily remote`. | must |
| FR-2  | `workFromHomeType` is `'Remote'` for FR-1, else `'Hybrid'` when a whole label is `Hybrid`, `Hybrid work` or `Hybrid remote`, or the formatted location starts with `Hybrid`; otherwise the key is absent. Remote wins over hybrid. | must |
| FR-3  | Skill labels ("Remote desktop support", "Remote sensing"), the description and the title never set FR-1 / FR-2. | must |
| FR-4  | `jobType`: codes `CF3CP`→fulltime, `75GKK`→parttime, `NJXCK`→contract, `VDTG7`→internship; any other attribute resolves only when its whole label is an alias (`getJobTypeFromString`, label mode). De-duplicated, attribute order. `job-types*` keys still resolve. | must |
| FR-5  | Location: structured `city`, `state`, `country` (else `countryCode`), `postalCode`, and `text` = the formatted label. Only when city, state and country are all empty is the label parsed: the workplace head ("Remote in ", "Hybrid work in ") is dropped and a trailing US ZIP goes to `postalCode`, so the city never reads "Remote in Austin". `city`/`state`/`country` keys are always present. | must |
| FR-6  | HTTP error: the client message is enriched with the first GraphQL error (`message [CODE] (+N more)`, ≤ 300 chars), the status when missing, and an `edge block page (cloudflare)` marker, then classified. A GraphQL code decides first: validation/parse/bad-input → `bad_input`; `UNAUTHENTICATED`/`FORBIDDEN`/`CSRF_ERROR` → `blocked`. | must |
| FR-7  | HTTP 200 without `data.jobSearch`: block page → `blocked`; GraphQL errors → FR-6 code mapping, else `unknown`; anything else → `unknown`. Never a silent empty result. | must |
| FR-8  | HTTP 200 with `errors` next to data: the data is used and the error logged; diagnostics are set from it only when no job results. | must |
| FR-9  | A page on which every attempted job throws while mapping sets `unknown` ("every job on page N failed to map: …"). Paging continues as before. | should |
| FR-10 | Posted time: `postedFromTimestamp(datePublished ?? dateOnSite, fetchedAt)` spread through `postedTimeFields`. A null, empty or zero value counts as absent. | must |
| FR-11 | At most `EVER_JOBS_INDEED_MAX_PAGES` pages (default 10); the inter-page sleep runs only when another page will be fetched. | must |
| FR-12 | Pre-1702 behaviour stays reachable (§7.1). | must |

## 6. Non-Functional Requirements

| ID    | Requirement | Target |
| ----- | ----------- | ------ |
| NFR-1 | Requests per scrape | ≤ 10 by default, strictly sequential, 5–10 s apart (unchanged sleep) |
| NFR-2 | Regex safety | Label rules are anchored; the ZIP rule runs on whitespace-collapsed text ≤ 200 chars |
| NFR-3 | Helpers | Pure and total: junk attributes/locations/bodies never throw |

## 7. Contracts

### 7.1 Switches (read on every scrape; unset or unrecognised = ON)

| Env var | Default | OFF (`false`/`0`/`no`/`off`) restores |
| ------- | ------- | ------------------------------------- |
| `EVER_JOBS_INDEED_ATTRIBUTE_MAPPING` | on | `isRemote` = any key `=== 'remotejob'`; `jobType` from `job-types*` keys only (not de-duplicated); no `workFromHomeType` |
| `EVER_JOBS_INDEED_FORMATTED_LOCATION` | on | `LocationDto({ city, state, country })` exactly |
| `EVER_JOBS_INDEED_MAX_PAGES` | `10` | `0` / `off` / `none` / `unlimited` = no cap (pre-1702); a positive integer = that cap; anything else = 10 |
| `EVER_JOBS_POSTED_TIME_DETAIL` (Spec 1696) | on | `datePosted` only |

### 7.2 Interface (`packages/plugins/source-indeed/src`)

```ts
// indeed.constants.ts
export const INDEED_REMOTE_ATTRIBUTE_KEY = 'DSQF7';
export const INDEED_JOB_TYPE_ATTRIBUTE_KEYS: Readonly<Partial<Record<JobType, string>>>;
export interface IndeedMappingOptions { attributeMapping?: boolean; formattedLocation?: boolean }
export function readIndeedMappingOptions(env?: NodeJS.ProcessEnv): Required<IndeedMappingOptions>;
export function readIndeedMaxPages(env?: NodeJS.ProcessEnv): number; // 0 = no cap

// indeed.utils.ts (options default ON)
export function detectWorkplace(job, options?): { isRemote: boolean; workFromHomeType: 'Remote' | 'Hybrid' | null };
export function isJobRemote(attributes, options?): boolean;       // kept, now the attribute part of detectWorkplace
export function getJobType(attributes, options?): JobType[] | null; // signature widened, not changed
export function buildLocation(location, options?): LocationDto;

// indeed.diagnostics.ts
export function graphqlErrorDetail(body: unknown): string | null;
export function graphqlErrorCode(body: unknown): string | null;
export function isBlockPage(body: unknown): boolean;
export function diagnoseHttpError(err: unknown): ScrapeDiagnostics;
export function diagnoseGraphqlErrors(body: unknown): ScrapeDiagnostics | null;
export function diagnoseMissingJobSearch(body: unknown): ScrapeDiagnostics;
```

### 7.3 Errors

| Situation | `diagnostics.reason` | `detail` |
| --------- | -------------------- | -------- |
| 403 edge block page | `blocked` | `Request failed with status code 403 - edge block page (cloudflare)` |
| 400 `GRAPHQL_VALIDATION_FAILED` | `bad_input` | `... - GraphQL: Cannot query field "x" on type "Job". [GRAPHQL_VALIDATION_FAILED]` |
| 400 `CSRF_ERROR` | `blocked` | as above |
| 200 block page | `blocked` | `HTTP 200 with an edge block page (cloudflare) instead of JSON` |
| 200 errors, no data | by code, else `unknown` | `GraphQL: <message> [CODE]` |
| 200 no `data.jobSearch` | `unknown` | `response had no data.jobSearch` / `non-JSON response (N characters) ...` |
| every job on a page fails to map | `unknown` | `every job on page N failed to map: <first error>` |
| timeout / network | `timeout` / `fetch_error` | the client message (unchanged classification) |

## 8. Test Plan

- Unit — `__tests__/indeed.utils.spec.ts` (28): workplace code/labels/location head/hybrid/precedence,
  skill-label and description false positives, junk input, `getJobType` codes/labels/non-aliases,
  `buildLocation` structured/fallback/legacy, switch readers.
- Unit — `__tests__/indeed.diagnostics.spec.ts` (18): GraphQL detail and code, block-page
  recognition on the trimmed live block page, every row of §7.3.
- Service — `__tests__/indeed.service.spec.ts` (23, mocked `createHttpClient` and `randomSleep`,
  `Date.now` pinned): the mapping on a synthetic page, posted time (ms, numeric-string seconds,
  `dateOnSite`, none), both mapping switches, the posted-time kill switch, the request pinned
  byte-for-byte, paging with duplicates, sleep only between pages, the page cap and its env, and
  every diagnostic path including partial results.
- Regression proof: on HEAD, `isJobRemote([{ key: 'DSQF7' }])` is `false`, `getJobType([{ key: 'CF3CP' }])`
  and `getJobType([{ label: 'Temporary' }])` are `null`, and `toDateOnly('1790121600')` is `null`.
- E2E — `__tests__/indeed.e2e-spec.ts` (2, live, `resultsWanted: 3`): the smoke test, plus a remote
  search that must never be a silent empty (tolerates `blocked`) and checks the workplace and
  posted-time contracts when jobs come back. Run once on 2026-09-25: both requests returned the 403
  block page and the suite reported `blocked` with the `cloudflare` marker.

## 9. Open Questions

(Recorded for `docs/questions.md`; defaults marked.)

- **Q-1702-1 — GraphQL document and filters rework (unverified).** The current document declares
  variables and fields (`$dateOnSiteFrom: DateInput`, `fromage`, `seoFriendlyToken`,
  `$filters: [SearchFilterInput!]`, `dateOnSite`, `location.state/country`, `formattedRange`,
  `employer.dpiUrl/companyProfile/relatedJobs`) that may not exist in the schema; one unknown field
  fails the whole document. The remote/job-type filters are sent as `[{ name, value }]` pairs, which
  may be ignored or rejected; the object shape the endpoint accepts is most likely a composite of
  `keyword` filters on `attributes` keys (`DSQF7`, `CF3CP` …) plus a `date` filter for `hoursOld`.
  **Default — proceeding:** unchanged until a live run can see a response; the new `bad_input`
  diagnostic names the offending field on the first run that gets past the edge.
- **Q-1702-2 — API key and user agent.** The request pairs a desktop-browser user agent with an
  app-style API key and overrides any operator `input.userAgent`. Whether a different key or a
  consistent identity is accepted is unverifiable from our egress. **Default:** unchanged; any
  change must follow the crawl policy.
- **Q-1702-3 — Currency, offset and page size.** `getCompensation` defaults to USD and the
  document does not request `estimated.currencyCode`; `input.offset` is ignored and `limit: 100` is
  fixed in the document. **Default:** unchanged (document-level changes, Q-1702-1).
- **Q-1702-4 — Local post-filter.** Dropping jobs whose computed `isRemote` / `jobType` does not
  match the input would make the filters correct even if the server ignores them, but would also
  drop jobs the server matched on a signal we do not see. **Default:** not added.
- **Q-1702-5 — Crawl manifest.** Once plugin metadata carries crawl hints, declare
  `{ maxConcurrentPerHost: 1, minIntervalMs: 5000 }` and record that honest-UA POSTs are
  edge-blocked; then the in-plugin sleep can move to the host scheduler.
- **Q-1702-6 — Shared parser.** `parseLocationText('Remote in New York, NY 10001')` gives
  `city: 'Remote in New York'` and `name: '10001'`. This plugin strips the head and the ZIP itself;
  the shared parser deserves the same fix with other plugins' fixtures as regression data.

## 10. Decisions

- **D-01 — Whole labels and location heads only.** The attribute list mixes workplace, schedule,
  benefit and skill entries, so a substring scan false-positives on "Remote desktop support".
  Anchored whole-label rules and a head-of-location rule do not, and the description/title are
  never read ("no remote work" appears on on-site jobs).
- **D-02 — Remote wins over hybrid**, matching how the Remote filter treats `DSQF7`.
- **D-03 — The new rules are a superset of the old.** `remotejob` and `job-types*` keys still
  resolve in the new mode, so nothing the old mapping reported is lost.
- **D-04 — Two switches, not one.** Workplace/job-type mapping and location mapping change
  different output fields; an operator can revert either alone. Env names follow the
  `EVER_JOBS_*` on-by-default pattern (`false`/`0`/`no`/`off`).
- **D-05 — Page cap added under the crawl policy.** Not a request change: the same request is sent
  fewer times. `0` restores the uncapped loop. The sleep that ran after the last needed page is gone.
- **D-06 — The server's error code outranks the status line.** A 400 `CSRF_ERROR` is a refusal
  (`blocked`), a 400 validation error is `bad_input`; the generic classifier handles the rest.
- **D-07 — A zero or empty `datePublished` counts as absent**, as the old truthiness check treated
  it, so it never becomes 1970-01-01; `dateOnSite` is then used.
- **D-08 — Mapping failures report but do not stop paging**, keeping the old loop behaviour.

## 11. References

- `packages/plugins/source-indeed/src/{indeed.constants,indeed.utils,indeed.diagnostics,indeed.service}.ts`
- `packages/common/src/converters/posted-time.ts` (Spec 1696)
- `packages/models/src/dtos/scrape-diagnostics.dto.ts` (Spec 5082)
- `packages/models/src/enums/job-type.enum.ts` (Spec 1697)
