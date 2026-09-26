# Spec: 1708 — Wellfound search reads the server-rendered landing pages

| Field          | Value                                        |
| -------------- | -------------------------------------------- |
| Spec ID        | 1708                                         |
| Slug           | wellfound-landing-page-search                |
| Status         | done                                         |
| Owner          | agent                                        |
| Created        | 2026-09-25                                   |
| Last updated   | 2026-09-25                                   |
| Supersedes     | (none)                                       |
| Related specs  | 5082, 1695, 1696, 1698, 1699, 1700           |

## 1. Problem Statement

`source-wellfound` (`Site.WELLFOUND`) is registered and runs, but it **always returns zero jobs,
and it returns them without diagnostics**, so the fan-out reports an outage as an empty board.

A live probe on 2026-09-24 (three requests, honest user agent) found every step of the old path
wrong:

| Old behaviour | What the site actually does | Effect |
| --- | --- | --- |
| Navigates to `/jobs?q=<term>` in a browser | `q` is ignored: the feed is identical with or without it | The search term never filtered anything |
| Looks for **arrays** of `{title, company}` up to 3 levels deep | The payload is a normalized Apollo cache, an **object map** at `props.pageProps.apolloState.data` (4 levels deep), keyed `"Type:id"` | Every scrape yielded `[]` |
| A missing payload or zero listings returns `[]` with no diagnostics | — | The outage was invisible |
| `listing.company` | The company is a separate `StartupResult` node that links back through `highlightedJobListings[].__ref` | `companyName` would be null |
| `jobUrl = /jobs/{slug}` | The listing lives at `/jobs/{id}-{slug}` | Broken links |
| Description treated as HTML | It is Markdown (0 of 87 sampled listings contain tags) | Markdown output double-escaped (`\*\*`), plain text kept `**` and `#` |
| `listing.locations`, `createdAt`, `{min,max,currency}` compensation | `locationNames`, `liveStartAt` in **epoch seconds**, a preformatted string (`"$126k – $187k CAD"`) | Wrong or empty fields; dates would land in 1970 |
| `isRemote` from `remote` only | `remoteConfig.kind` (inline or by reference) also says `REMOTE` / `ONSITE_OR_REMOTE` / `ONSITE` + `wfhFlexible` | Hybrid work inexpressible |
| One page, always through a browser (`proxies[0]`, fixed 6 s sleep) | The landing pages answer plain HTTP with an honest user agent (200, SSR, `?page=N` served) | Heavy, slow, `resultsWanted` ignored |

Plain HTTP also exposed a detector pitfall: a normal 200 page carries the CDN's passive detection
beacon (`/cdn-cgi/challenge-platform/scripts/jsd/main.js`), which the shared `looksLikeChallenge()`
matches on the bare substring `challenge-platform`. Checking for markers before the payload would
label a page full of data `blocked`.

## 2. Goals

- Return startup jobs for `searchTerm`, `location` and `isRemote` from the robots-allowed,
  server-rendered role and location landing pages over plain HTTP.
- Parse the Apollo cache correctly: company linkage, remote config (inline or by reference),
  compensation strings, epoch-second dates, Markdown descriptions.
- Paginate with `?page=N` up to the declared page count (capped), sequentially, de-duplicating by id.
- Degrade to `partial`, `blocked`, `empty` or `unknown` diagnostics instead of a silent zero.
- Keep every pre-existing behaviour reachable behind an operator option.

## 3. Non-Goals

- Complete per-company coverage: a landing page shows at most three listings per company.
  `source-ats-wellfound` (`Site.WELLFOUND_ATS`) covers full company boards.
- Working around a bot challenge. A challenge is reported as `blocked`; nothing is solved or evaded.
- The shared `looksLikeChallenge()` fix and the company-board plugin's ordering fix (outside this
  lane; see §9).
- A crawl manifest: `IPluginMetadata` has no `crawl` field yet (see §9).

## 4. User / Caller Stories

> As an **API caller**, I want `siteType: ["wellfound"], searchTerm: "software engineer", location: "San Francisco, CA"`
> to return real San Francisco startup roles, so that the source is useful at all.

> As an **operator**, I want a zero from Wellfound to say whether the site blocked us, changed its
> payload, or simply had nothing, so that I can act on it.

> As an **operator**, I want the old browser transport, feed route, description reading and URL
> shape available behind a switch, so that no behaviour is lost if a site change makes one of them
> right again.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | Route per input: term + remote → `/role/r/{role}`; term + location → `/role/l/{role}/{loc}`; term → `/role/{role}`; location → `/location/{loc}`; nothing → `/jobs`. Page N ≥ 2 appends `?page=N`. | must |
| FR-2  | Never request `/search`, a `role=`/`jobId=` query, or `q=`; never build `/role/l/{role}` without a location. | must |
| FR-3  | Fallback chain on a 404/410, a `/_error` page, a page with neither a results connection nor any listing, or a role page whose `SeoRoleKeyword` (else `query.role`) is not the requested role: `/role/l` → `/role` (+ local location filter) → `/location` (+ local term filter); `/role/r` → `/jobs` (+ term, location, remote filters); `/role` → `/jobs` (+ term); `/location` → `/jobs` (+ location, remote). | must |
| FR-4  | Role slug: alias map, then NFKD-folded lowercase slug (`&` → `and`). Location slug: text before the first comma. `Remote`, `Anywhere`, `Worldwide` as a location mean `isRemote`. | must |
| FR-5  | Local term filter (fallback routes only): every token of the term must occur at a word start in title, role title, company name, tagline or description; tokens of 1-2 characters must be whole words; `c++`/`c#` survive tokenisation; single letters other than `c` are dropped. | must |
| FR-6  | Read listings in site order: `connection.startups[i].highlightedJobListings[j]`; without a connection, company nodes then any listing not reached, its company from `listing.startup`. De-duplicate by id across pages. | must |
| FR-7  | Map per the table in §7.1, keeping every pre-existing output field and reading the pre-Spec-1708 input fields (`company`, `locations`, `skills`, `createdAt`, object compensation) as fallbacks. | must |
| FR-8  | `parseWellfoundCompensation`: part before the bullet; per-bound `k`/`m`; a trailing ISO code wins over the sign; sign map otherwise; default USD; `/hr` → hourly, `/mo` → monthly, else yearly; empty, equity-only and unparseable → null. | must |
| FR-9  | Descriptions: Markdown returned unchanged; PLAIN via a local Markdown stripper; HTML via a local escape-first renderer that only links `http(s)` URLs. Feed nodes' HTML snippets use the shared HTML converters. | must |
| FR-10 | Pagination: sequential, `randomSleep(3000, 7000)` between pages, stop at `offset + resultsWanted` matches, the declared `pageCount`, 10 pages, or a page adding no new id. | must |
| FR-11 | Classification order per page: 404/410 → not found; payload present → ok / `/_error` → not found / no `apolloState.data` → drift; then 401/403/407 or a challenge marker (beacon path excluded) → blocked; other 4xx → classified error; else no payload. | must |
| FR-12 | Local input filters: `hoursOld` (undated listings kept, never an early stop), `jobType` (via `getJobTypeFromString`), `offset` in site order. | must |
| FR-13 | Plain HTTP via `createHttpClient(input)` (all proxies rotate), honest user agent unless the caller sets one, redirects pinned to `wellfound.com`. | must |
| FR-14 | No per-run state on the singleton service. | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Requests per scrape | 1 for a first page that satisfies `resultsWanted`; ≤ 3 route probes + ≤ 9 more pages worst case |
| NFR-2  | Concurrency per scrape | 1 request in flight, 3-7 s between pages |
| NFR-3  | Parser safety | Pure functions; all regexes bounded or linear; refs resolve own keys only |

## 7. Contracts

### 7.1 Output mapping (`JobListingSearchResult` + `StartupResult` → `JobPostDto`)

| Field | Source |
| --- | --- |
| `id` | `wellfound-{id}` |
| `title` | `title` (listing skipped when empty) |
| `jobUrl` | `https://wellfound.com/jobs/{id}-{slug}` (`/jobs/{id}` without a slug) |
| `companyName`, `companyUrl`, `companyLogo`, `companyDescription` | `startup.name`, `/company/{startup.slug}`, `startup.logoUrl`, `startup.highConcept` |
| `companyNumEmployees` | `SIZE_A_B` → `"A-B"`, `SIZE_A_PLUS` → `"A+"` |
| `location`, `locations` | `parseLocationList(locationNames)`; `locations` only when non-empty |
| `isRemote` | `remote === true` or `kind ∈ {REMOTE, REMOTE_ONLY}` or a remote location label |
| `workFromHomeType` | `REMOTE*` → `Remote`; `ONSITE_OR_REMOTE` → `Hybrid or Remote`; `ONSITE` + `wfhFlexible` → `Hybrid`; else the location parser's |
| `description` | §5 FR-9 |
| `compensation` | `parseWellfoundCompensation` |
| `datePosted` (+ `datePostedAt`, precision `exact`, basis `timestamp`) | `liveStartAt × 1000` through the Spec 1696 helpers |
| `jobType` / `employmentType` | `[getJobTypeFromString(jobType)]` / raw `jobType` |
| `department` | `primaryRoleTitle` |
| `experienceRange` | `"3-5 years"`, `"3+ years"`, `"up to 5 years"` |
| `emails`, `skills`, `site` | `extractEmails(description)`, legacy `skills`, `Site.WELLFOUND` |

`atsSource` is **not** mapped to `atsType`/`atsId`: it names the upstream ATS while the id is the
site's own, so the pair would mislead.

### 7.2 Operator options (environment, read on every scrape)

| Env var | Values (default first) | Non-default restores |
| --- | --- | --- |
| `WELLFOUND_FETCH_MODE` | `http`, `browser` | Every page through `BrowserPool.getPage({ proxy: proxies[0] })`, as before (no stealth, no fixed sleep) |
| `WELLFOUND_ROUTE_MODE` | `landing`, `feed` | Only `/jobs`, filtered locally (no `q=`, which the site ignores) |
| `WELLFOUND_DESCRIPTION_SOURCE` | `markdown`, `html` | `description` read as HTML: HTML verbatim, Markdown via `markdownConverter`, plain via `htmlToPlainText` |
| `WELLFOUND_JOB_URL_STYLE` | `id-slug`, `slug` | `jobUrl = /jobs/{slug ?? id}` |

An unrecognised value logs a warning and uses the default. `EVER_JOBS_POSTED_TIME_DETAIL=false`
(Spec 1696) drops the three posted-time detail keys.

### 7.3 Diagnostics

| Situation | Result |
| --- | --- |
| Every route missing | `[]` + `empty`, `no landing page for role/location` |
| No route carries a payload | `[]` + `empty`, `no __NEXT_DATA__ payload on the landing pages` |
| Page 1 blocked | `[]` + `blocked`, `bot challenge (http 403)` |
| Browser mode, browser missing | `[]` + `browser_unavailable` |
| Payload without `apolloState.data` | `[]` + `unknown`, `payload shape changed: no apolloState.data` |
| Listings read, none match | `[]` + `empty`, `N listings fetched, 0 matched filters` |
| `offset` past the matches | `[]` + `empty`, `offset N is past the M matching listings` |
| A later page fails after jobs were collected | jobs + `partial`, `stopped at page N: <reason> (<detail>)` |
| A later page fails with nothing matched | `[]` + that failure's own reason |
| Page-1 network error | `[]` + `classifyScrapeError(err)` |
| Success | jobs, no diagnostics |

## 8. Test Plan

- Unit (`wellfound.parser.spec.ts`, 88 cases): payload extraction (attribute order, broken JSON),
  the zero-listings regression with exact counts, site ordering, connection lookup across argument
  orders, own-key ref resolution, every mapping row, remote kinds (inline and by reference),
  a compensation table (CAD, EUR, equity, hourly, monthly, single bound, equity-only), the three
  description formats and the legacy reading, routing table, no `q=`/`/search`, slugs, local
  filters, beacon vs interstitial, role confirmation.
- Service (`wellfound.service.spec.ts`, 33 cases, HTTP client / browser pool / sleep mocked):
  one-GET happy path without browser, honest UA and redirect pinning, full proxy list,
  sequential pagination with pauses, stop rules (no new ids, page cap at 45 declared pages,
  enough matches), partial on page-2 error and page-2 challenge, beacon false-positive
  regression, 403 blocked without browser, fallback chain (404, `/_error`, wrong role, all
  missing), remote route and filter, drift, filter-empty, input filters, every option, browser
  mode (one page, no stealth, closed; blocked; unavailable), two concurrent scrapes.
- E2E (`wellfound.e2e-spec.ts`, `RUN_NETWORK_E2E=1`): a term search and a remote search; jobs or
  an explicit `blocked`, never a silent empty.
- Mutation control: moving the challenge check before the payload check and dropping the beacon
  exclusion turns the beacon regressions red (3 failures), then restored.

## 9. Open Questions

- **Shared challenge detector.** `looksLikeChallenge()` in `packages/models` still matches the
  bare `challenge-platform` beacon path. This plugin works around it locally; the shared fix
  (match `challenge-platform/(?:h/|orchestrate)` only) benefits every caller and belongs to a
  core lane. (default — proceeding with the local wrapper)
- **Company-board plugin.** `source-ats-wellfound` checks challenge markers before the payload
  and parses `$…CAD` as USD. Both follow-ups reuse this plugin's helpers; out of this lane.
- **Crawl manifest.** Once `IPluginMetadata.crawl` exists, declare
  `{ host: 'wellfound.com', maxConcurrentPerHost: 1, minIntervalMs: 3000 }` on both Wellfound
  plugins, which share one host budget.
- **Role-slug catalogue.** A slug list built offline from the robots-listed sitemap would make
  the local-filter fallback rarer.

## 10. Decisions

- **D-01 — Plain HTTP by default, no automatic browser escalation.** The design proposed
  retrying a challenged page in a stealth browser. The crawl policy forbids challenge solving and
  fingerprint spoofing, so a challenge is reported as `blocked` and nothing else happens. The
  browser transport stays available as `WELLFOUND_FETCH_MODE=browser`, exactly as before
  (non-stealth `BrowserPool.getPage({ proxy })`), minus the fixed 6 s sleep: the payload is
  server-rendered and read as soon as the document is.
- **D-02 — Payload before markers, beacon excluded locally.** The shared detector is outside this
  lane, so `looksLikeWellfoundChallenge` removes the passive beacon path before asking it, and
  classification looks for the payload first.
- **D-03 — Old behaviours behind options, not deleted.** Four env switches (§7.2). The legacy
  input fields are read as fallbacks, so no option is needed for them.
- **D-04 — Honest identification.** `Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)`
  unless the caller passes `userAgent`; the probe verified it is served.
- **D-05 — Posted-time detail.** `liveStartAt` is a real timestamp, so the Spec 1696 helpers add
  `datePostedAt` (`exact`/`timestamp`). `datePosted` is unchanged (`toDateOnly(ms)`).
- **D-06 — Undated listings survive `hoursOld`.** A filter must not drop what it cannot judge.
- **D-07 — Local compensation parser.** The shared `extractSalary` knows eight currencies and not
  CAD, while the site writes `$126k – $187k CAD`; a small pure parser with its own sign and ISO
  tables reads the site's one fixed format.
- **D-08 — A later page that is not found is the end of an open-ended feed, not a failure,** when
  the site declared no page count; with a declared count it is `partial`.

## 11. References

- `packages/plugins/source-wellfound/src/wellfound.parser.ts` — pure helpers
- `packages/plugins/source-wellfound/src/wellfound.service.ts` — fetch, pagination, diagnostics
- `packages/plugins/source-wellfound/src/wellfound.constants.ts` — routes, caps, options
- `packages/models/src/dtos/scrape-diagnostics.dto.ts` — `ScrapeDiagnostics`, `classifyScrapeError`
- `packages/common/src/converters/posted-time.ts` — Spec 1696 helpers
