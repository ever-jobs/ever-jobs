# Spec: 1704 — Google Jobs rows come from one record each, or not at all

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| Spec ID        | 1704                                   |
| Slug           | google-jobs-record-extraction          |
| Status         | done                                   |
| Owner          | agent                                  |
| Created        | 2026-09-25                             |
| Last updated   | 2026-09-25                             |
| Supersedes     | (none)                                 |
| Related specs  | 5082                                   |

## 1. Problem Statement

`source-google` (`Site.GOOGLE`) returned rows whose title, company and URL did not belong together.
The parser ran two unrelated regexes over the page — one for anything shaped like
`["<5-100 chars>","<2-80 chars>",`, one for any URL containing `careers`, `jobs` or `apply` — and zipped
the two lists by position:

```ts
const jobUrl = urls[i] ?? `https://www.google.com/search?q=${encodeURIComponent(title + ' ' + company + ' jobs')}`;
const jobId = `go-${Math.abs(this.hashCode(jobUrl))}`;
```

So job *i* got URL *i* from a list that also held Google's own navigation links; UI strings came out as
"title/company" pairs; a job with no URL got a made-up search link; and the id was a hash of whichever
URL it was handed, which collides and poisons dedup. Location was always an empty `LocationDto`.

A block was also indistinguishable from an empty result: a 200 interstitial that yielded no rows
returned `JobResponseDto([], undefined)`. And the follow-up loop requested more pages whether or not
the first page said there were any.

The request path is robots-disallowed and the plugin is kept for callers who opt into it; this spec
does **not** make it crawl more or harder. It makes what it already fetches honest.

## 2. Goals

- Every row is built from one inline job record: title, company, location label, URL and id all come
  from the same record. Never index-pairing.
- A record without an http(s) URL is skipped; no synthetic search URL is ever emitted.
- `id` is `go-<stable record id>` (`[28]`), falling back to `go-<url hash>` only when the record has none.
- `location` / `locations` come from the record's label through `parseLocationList`; remote-only labels
  (`Anywhere`, `Remote`, `Work from home`, `WFH`) set `isRemote` and never become a city.
- A first page with no rows reports why: `blocked` for Google's interstitials and generic challenges,
  `unknown` (with detail) otherwise.
- The existing follow-up loop runs only when the first page carries a forward cursor, dedupes by id
  across pages, stops on a page with no new rows, is capped in pages, and reports `partial` when it
  gives up on errors after rows were collected.
- The live e2e runs only under `RUN_NETWORK_E2E`.

## 3. Non-Goals

- No new endpoint, no cursor-based pagination endpoint, no new or changed request headers, no new
  request parameters. The first request is byte-identical to before (`ibp=htl;jobs`, `hl=en`).
- No description, `datePosted`, `jobType`, `compensation` or `emails` extraction from the record, and no
  `hoursOld` / `offset` / `country` / `jobType` query mapping. Recorded as follow-ups (§9).
- No change to the hard-coded user-agent the plugin already sends (a policy question, §9).

## 4. User / Caller Stories

> As a **caller of `siteType: ['google']`**, I want **each row's URL to be that job's URL**, so that
> **I never send a candidate to another company's posting**.

> As an **operator**, I want **a zero-row Google answer to say `blocked` or `unknown`**, so that **I can
> tell a wall from an empty search**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | Records are found by key: `"<key>":[` then a balanced-bracket scan (string- and escape-aware) from that `[`, then `JSON.parse`. No fixed closing-bracket suffix. | must |
| FR-2  | Known keys (`GOOGLE_JOB_PAYLOAD_KEYS`, today `['520084652']`) are tried first. When none yields a record, any `"<9 digits>":[` whose value passes the shape check is accepted, and the key is logged at `warn`. | must |
| FR-3  | Shape check `isJobRecord`: array of ≥ 13 entries; `[0]`, `[1]`, `[2]` non-blank strings; `[3][0][0]` an http(s) URL. The same predicate guards both paths and accepts a record as it really starts (`["<title>", …`). | must |
| FR-4  | A key nested inside an accepted record is not read as a second record. | must |
| FR-5  | Row fields: `id`, `title`, `companyName`, `jobUrl`, `location` (always an object, as before), `locations` when non-empty, `isRemote: true` only when remote, `workFromHomeType` when known, `site`. | must |
| FR-6  | Rows are unique by id within a page and across pages. | must |
| FR-7  | Zero rows on the first page: `blocked` when `looksLikeChallenge` or `looksLikeGoogleInterstitial` (status 429, final URL under `/sorry/`, "unusual traffic", `/httpservice/retry/enablejs`, `/sorry/index`, a meta refresh to `enablejs`); otherwise `unknown` with a detail naming the likely cause. | must |
| FR-8  | A first-page error is `classifyScrapeError(err)`, except that an error whose response is a Google interstitial (e.g. 429 from `/sorry/`) is `blocked`. | must |
| FR-9  | The follow-up loop runs only when the first page has a `jsname="Yust4d"` element with a non-blank `data-async-fc`. | must |
| FR-10 | The loop stops on a page with no new rows, at `resultsWanted`, after 3 failed requests, or after `EVER_JOBS_GOOGLE_MAX_PAGES` requests (default 10). | must |
| FR-11 | The loop giving up on errors after rows were collected returns those rows with `partial`; with no rows, the classified error. | must |
| FR-12 | `EVER_JOBS_GOOGLE_LEGACY_PARSER=true` restores the pre-1704 read path in full (index-pairing parser, ungated loop, no dedupe, silent `[]`). Only the page cap applies to it. | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Scan work per page is bounded | ≤ 256 KiB per record, ≤ 8 MiB per page, ≤ 500 key candidates |
| NFR-2  | Hostile input (20 000 never-closing keys) | parses to `[]` in < 2 s |
| NFR-3  | Requests per scrape | ≤ 1 + `EVER_JOBS_GOOGLE_MAX_PAGES`, strictly sequential, 3–6 s apart |

## 7. Contracts

### 7.1 API / Interface

```ts
// packages/plugins/source-google/src/google.parser.ts (pure, exported from the package)
export function findArrayEnd(text: string, start: number, maxChars?: number): number;
export function extractBalancedArray(text: string, start: number, maxChars?: number): string | null;
export function isJobRecord(value: unknown): value is unknown[];
export function findJobRecords(text: string, options?: GoogleScanOptions): GoogleRecordScan;
export function extractGoogleCursor(html: string): string | null;
export function looksLikeGoogleInterstitial(html: string, finalUrl?: string | null, status?: number | null): boolean;
export function googleJobId(record: unknown[], jobUrl: string): string;
export function googleLocation(label: string): { location; locations; isRemote; workFromHomeType };
export function googleRecordToJobPost(record: unknown): JobPostDto | null;
export function parseGoogleJobRecords(text: string, options?: GoogleScanOptions): GoogleParsedPage;

// packages/plugins/source-google/src/google.constants.ts
export const GOOGLE_JOB_PAYLOAD_KEYS: readonly string[]; // ['520084652']
export function googleLegacyParserEnabled(env?: NodeJS.ProcessEnv): boolean; // EVER_JOBS_GOOGLE_LEGACY_PARSER
export function googleMaxPages(env?: NodeJS.ProcessEnv): number;            // EVER_JOBS_GOOGLE_MAX_PAGES
```

| Env var | Default | Effect |
| ------- | ------- | ------ |
| `EVER_JOBS_GOOGLE_LEGACY_PARSER` | off | `true`/`1`/`yes`/`on` restores the pre-1704 read path |
| `EVER_JOBS_GOOGLE_MAX_PAGES` | `10` | positive integer cap on follow-up requests; anything else keeps the default |

Both are read on every scrape.

### 7.2 Errors

| Reason | When |
| ------ | ---- |
| `blocked` | zero rows and the first page (or the first page's error response) is an interstitial or challenge |
| `unknown` | zero rows, no interstitial: `no job payload or cursor on first page (…)` or `forward cursor present but no job records parsed (…)` |
| `partial` | rows collected, then 3 failed follow-up requests; detail names the underlying reason |
| classified | first-page error, as `classifyScrapeError` |

## 8. Test Plan

- Unit (`__tests__/google.parser.spec.ts`, 38 cases): balanced scan with strings/escapes/limits; the
  shape predicate (including the `[[[`-anchored mistake); known key, rotated key, known-key-without-record
  fallback, nested key, malformed record, caps and a hostile-input timing bound; cursor extraction;
  interstitial detection; row mapping, stable ids, hash fallback, trimming; remote labels; env switches.
- Unit (`__tests__/google.service.spec.ts`, 27 cases, HTTP and sleep mocked): the title→URL pairs are
  exact, and the legacy path — still reachable — misattributes the same page; no URL → skipped; stable
  ids; location and `Anywhere`; rotated-key warn; the request is unchanged; the cursor gate; cross-page
  dedupe and stop; `resultsWanted`; the page cap (env and default); every diagnostic path; the legacy
  path's old silent `[]`, ungated loop and page cap.
- E2E (`__tests__/google.e2e-spec.ts`): skipped unless `RUN_NETWORK_E2E`; asserts `go-` ids, http(s)
  URLs that are never a search URL, and a diagnostic on zero rows.
- Fixtures are synthetic, built from the documented record layout. No captured Google page is committed.

## 9. Open Questions

- The plugin still sends a fixed desktop-browser user-agent through `setHeaders`, which also overrides a
  caller's `input.userAgent`. Whether to drop it is a crawl-policy decision; left unchanged here
  (default — proceeding).
- The first request still uses `ibp=htl;jobs`. If Google no longer serves the job payload on that page,
  the plugin now answers `unknown` with a detail instead of wrong rows; moving to another vertical or a
  cursor endpoint is out of scope and needs an owner ruling on the robots-disallowed path.
- Follow-ups if the plugin is ever extended: description (`[19]`, plain text), posted age (`[12]`),
  `jobType` phrase mapping in the query (it still appends the raw enum value), `hoursOld` / `offset` /
  `country`.

## 10. Decisions

- **D-01 — Records, not lists.** A row exists only if one record supplies all of its fields. This is the
  whole fix for the misattribution; everything else is diagnostics.
- **D-02 — Balanced scan, not a suffix regex.** A fixed run of closing brackets breaks the moment the
  wrapper depth changes; bracket depth does not.
- **D-03 — One shape predicate for both paths.** A fallback that requires `[[[` before the record can
  never match, because a record starts with its title string. The same `isJobRecord` guards the known-key
  path and the fallback, and a test pins that a record starting with `["` is found.
- **D-04 — The loop is gated, not removed.** It keeps its request, retries and step; it now runs only when
  the page says there is a next page, and it is capped.
- **D-05 — The old path stays reachable.** `EVER_JOBS_GOOGLE_LEGACY_PARSER` restores it whole, so the
  change is reversible without a deploy of old code. The page cap applies to both paths because the
  branch's crawl policy requires capped pagination; raising `EVER_JOBS_GOOGLE_MAX_PAGES` recovers the old
  reach.
- **D-06 — `Anywhere` is not a city.** The shared location parser reads it as one; the plugin treats a
  label that is only a remote spelling as remote with no site before calling it.
- **D-07 — A 429 from Google is `blocked`.** Google's rate-limit answer is its `/sorry/` wall; reporting
  it as `fetch_error` hid a block behind a transport error.

## 11. References

- `packages/plugins/source-google/src/google.parser.ts`, `google.constants.ts`, `google.service.ts`
- `packages/models/src/dtos/scrape-diagnostics.dto.ts` (`classifyScrapeError`, `looksLikeChallenge`)
- `packages/common/src/utils/location-parser.ts` (`parseLocationList`)
