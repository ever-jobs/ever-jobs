# Spec: 1712 — Naukri reports its captcha gate as `blocked` and parses its labels correctly

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1712                                     |
| Slug           | naukri-captcha-gate-and-label-parsing    |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-25                               |
| Last updated   | 2026-09-25                               |
| Supersedes     | (none)                                   |
| Related specs  | 5082, 5024, 1699                         |

## 1. Problem Statement

`source-naukri` is in `DEFAULT_SITE_NAMES`, so every default search calls it. Today it returns
zero jobs and blames the caller:

- The board refuses automated clients with `HTTP 406 {"message":"recaptcha required"}`. axios
  throws `Request failed with status code 406`; `classifyScrapeError` sees only that message and
  its generic `4xx` rule reports **`bad_input`**. The body is never read.
- A 200 carrying the same captcha JSON, or a challenge page, is read as "no jobs", which the
  fan-out reports as `empty`.
- The `response.status` check after the GET is dead code: axios throws before a non-2xx reaches it.

When the endpoint does answer (another egress, a proxy pool, the gate relaxing), the row mapping
is wrong in several ways:

| # | Defect |
|---|--------|
| R3 | Annual CTC salaries carry no `interval`. |
| R4 | Only `min-max Lacs\|Lakh\|Cr` parses: `Up to 10 Lacs P.A.`, `80 Lacs-1.2 Cr P.A.`, `2,50,000-3,50,000 P.A.`, `LPA`, `Crore`, `Lakhs` and `P.M.` do not. |
| R5 | Remote/hybrid come from a substring scan of title + description, so "This is not a remote role" is remote. |
| R6 | `Bengaluru, Hyderabad, Pune` is one location with that whole string as the city; `Hybrid - Bengaluru, Chennai` reads Chennai as a state; `Temp. WFH - Bengaluru` is not remote. |
| R7 | `requestTimeout` is dropped when `proxies` is set (the factory reads `requestTimeout`, the plugin passed `timeout`), so a proxied run waits the 60 s default on an edge that never answers. |
| R8 | `https://www.naukri.com${jdURL}` corrupts an absolute `jdURL`. |
| R9 | `DescriptionFormat.PLAIN` returns raw HTML. |
| R10 | `30+ Days Ago` beats the exact `createdDate`; days are taken in UTC although labels are IST-relative. |
| R11 | `offset=22` returns rows 20–39. |
| R12 | Skills keep empty and duplicate tokens; the rating can be `NaN`; `vacancy: 0` is emitted as 0. |
| R13 | The e2e test passes when the board returns nothing. |

Live probe (2026-09-24): with an honest UA the edge completes TLS and never sends a byte, on every
path including robots.txt; a browser-style UA gets the immediate 406 above. The archived
robots.txt does not disallow `/jobapi/` for `User-agent: *`. Live yield from our egress is 0.

## 2. Goals

- Report the gate as `blocked`, with the board's own message in `detail`; keep jobs already
  collected when a later page is refused (the fan-out then infers `partial`).
- Parse salary, location, remote/hybrid and date from the labels the board provides.
- Never let a hung request cost more than 20 s by default.
- Keep every pre-existing behaviour reachable (owner rule).

## 3. Non-Goals

- No attempt to solve, bypass or farm the captcha. No new headers, UA or fingerprinting; the
  existing static headers are unchanged.
- No shared-core change (`classifyScrapeError`, `createHttpClient`): see §10 follow-ups.
- No crawl-manifest metadata: the field does not exist on `IPluginMetadata` yet.
- No detail-page fetches; paging stays strictly sequential with the existing 3–7 s delay and
  50-page cap.

## 4. User / Caller Stories

> As an **operator**, I want a refused Naukri search to say `blocked: HTTP 406: recaptcha
> required`, so that I stop debugging my query.

> As a **caller**, I want a multi-city Naukri job to carry one location per city and an honest
> remote flag, so that location filters and remote filters work.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | A thrown 406/403, a body `message` matching `/captcha/i`, or a challenge page yields `ScrapeDiagnostics('blocked', 'HTTP <status>: <message>')`, detail ≤ 300 chars. | must |
| FR-2  | Any other failure keeps `classifyScrapeError` (a 404 stays `bad_input`, a timeout `timeout`). | must |
| FR-3  | A non-JSON 200 that is not a challenge is `fetch_error` (`naukri: non-JSON search response`); an empty `jobDetails` is `[]` with no diagnostic. | must |
| FR-4  | Jobs collected before a refusal are returned with the diagnostic. | must |
| FR-5  | Salary: ranges with per-bound units, `up to`, single values, Indian digit grouping, lac/lakh/LPA (×1e5) and cr/crore (×1e7); `P.A.`/annual → yearly, `P.M.`/monthly → monthly, else lakh/crore → yearly; INR; `null` for undisclosed, ambiguous (`3-5`) or inverted ranges. | must |
| FR-6  | Location: a leading/standalone/listed/parenthesised work-mode qualifier; the rest split on commas into one entry per city; `country: INDIA` unless the label names a country (one named country is folded onto the cities). Remote/hybrid from the label only. | must |
| FR-7  | Date: IST day; open-ended or missing labels defer to a plausible `createdDate`; `N Days Ago` by millisecond subtraction. | must |
| FR-8  | `requestTimeout` defaults to 20 s and is honoured with proxies; `userAgent`, `retries` and rate delays pass through. | must |
| FR-9  | `offset % 20` rows of the first page are skipped; their ids still dedupe later rows. | must |
| FR-10 | With `hoursOld`, rows dated before the IST cutoff day are dropped client-side; undated rows are kept. | should |
| FR-11 | Stop after a page when a numeric `noOfJobs` is already covered. | should |
| FR-12 | Links resolve with `URL` against the site (absolute kept, http(s) only); `PLAIN` uses `htmlToPlainText`; skills trimmed/deduped; rating/reviews finite or null; vacancy > 0 or null. | must |
| FR-13 | `NAUKRI_PARSER=legacy` restores the pre-1712 row mapping and paging; `NAUKRI_DIAGNOSTICS=legacy` restores the pre-1712 failure reporting. | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Worst-case wait on a tarpit | ≤ 20 s per call by default |
| NFR-2  | Regex work per label | bounded: labels capped (salary 200, date 64, location 1 000 chars / 50 parts), whitespace collapsed before matching |
| NFR-3  | Requests | sequential; no delay after the last page |

## 7. Contracts

### 7.1 API / Interface

```ts
// packages/plugins/source-naukri/src/naukri.parsers.ts
export function detectNaukriBlock(errOrBody: unknown): string | null;
export function parseNaukriSalary(label: string | null | undefined): CompensationDto | null;
export function parseNaukriLocationLabel(label: string | null | undefined): {
  location: LocationDto; locations: LocationDto[]; isRemote: boolean; workFromHomeType: string | null;
};
export function parseNaukriPostedDate(label: string | null | undefined, createdDate: unknown, now?: number): string | null;

// packages/plugins/source-naukri/src/naukri.constants.ts
export const NAUKRI_PARSER_ENV = 'NAUKRI_PARSER';          // current (default) | legacy
export const NAUKRI_DIAGNOSTICS_ENV = 'NAUKRI_DIAGNOSTICS'; // current (default) | legacy
export const NAUKRI_DEFAULT_TIMEOUT_S = 20;
```

### 7.2 Errors

| Situation | Result |
| --------- | ------ |
| 406 / 403 / captcha body / challenge page on page 1 | `[]` + `blocked` |
| Same on page N > 1 | jobs so far + `blocked` (fan-out infers `partial`) |
| Edge tarpit | `[]` + `timeout` after ≤ 20 s (the client retries only 429/5xx) |
| 429 / 5xx | shared retry, then `fetch_error` |
| Non-JSON 200, no challenge | `fetch_error` |
| Empty `jobDetails` | `[]`, no diagnostic (`empty`) |
| One malformed row | skipped with a `warn` |

## 8. Test Plan

- Unit (`__tests__/naukri.parsers.spec.ts`): salary, location, date and block-detection tables,
  plus the coercions and mode parsing.
- Service (`__tests__/naukri.service.spec.ts`): mocked HTTP over a synthetic 7-row fixture —
  registration, mapping, remote/location regressions, description formats, request shape,
  timeout pass-through, offset/paging/`hoursOld`, diagnostics (a)–(j), and both legacy modes.
- E2E (`__tests__/naukri.e2e-spec.ts`): passes only on well-formed jobs, or on zero jobs with
  `blocked`/`timeout`.

## 9. Open Questions

- `ScraperInputDto`'s constructor defaults `requestTimeout` to 60, so the 20 s default applies only
  to plain-object callers; an API/DTO caller still waits 60 s unless it passes a value. Changing
  the DTO default is outside this plugin.

## 10. Decisions

- **D-01 — Detection is plugin-local.** A bare 406 means Not Acceptable elsewhere, so it is not
  mapped to `blocked` globally.
- **D-02 — Old behaviour behind two switches.** Row mapping and failure reporting are independent:
  an operator can keep the `blocked` diagnostic while restoring the old mapping. Unknown values warn
  and use `current`. Both are read on every call.
- **D-03 — Temporary WFH is `Remote`,** staying inside the shared `workFromHomeType` vocabulary.
- **D-04 — A literal country wins.** India is stamped only when the label names no country; exactly
  one named country is folded onto the city entries.
- **D-05 — Offset-consumed rows still dedupe.** A later duplicate of a skipped row was already
  served by the previous call, so it is not returned again.
- **D-06 — A qualifier in parentheses counts** (`Mumbai (Hybrid)`); any other parenthetical is
  dropped (`Mumbai (All Areas)`).
- **D-07 — String bodies that are JSON are parsed** before inspection, so a captcha message served
  as `text/plain` is still recognised.

## 11. References

- `packages/plugins/source-naukri/src/naukri.service.ts`, `naukri.parsers.ts`, `naukri.constants.ts`, `naukri.types.ts`
- `packages/models/src/dtos/scrape-diagnostics.dto.ts` (`classifyScrapeError`, `looksLikeChallenge`)
- `packages/common/src/utils/location-parser.ts` (`parseLocationList`)
- `packages/common/src/http/http-client.ts` (`createHttpClient`)
