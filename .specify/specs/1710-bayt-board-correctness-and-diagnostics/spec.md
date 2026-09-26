# Spec: 1710 — Bayt: correct search URLs and card mapping, and a challenge is never an empty board

| Field          | Value                                        |
| -------------- | -------------------------------------------- |
| Spec ID        | 1710                                         |
| Slug           | bayt-board-correctness-and-diagnostics       |
| Status         | done                                         |
| Owner          | agent                                        |
| Created        | 2026-09-25                                   |
| Last updated   | 2026-09-25                                   |
| Supersedes     | (none)                                       |
| Related specs  | 5082, 1696, 1699                             |

## 1. Problem Statement

`source-bayt` scrapes the server-rendered Bayt search listing. On 2026-09-24 three honest
requests (robots.txt, then two listing pages, 2 s or more apart) showed:

- robots.txt is served normally. For `User-agent: *` it disallows the **country-less**
  search path (`/en/jobs/?`, `/en/jobs/*-jobs/`, and the `/ar/`, `/fr/` twins) and any
  `filters[` / `options[` query parameter in either spelling. The **country-scoped** path
  `/en/<market>/jobs/<slug>-jobs/` — including `/en/international/...` — is allowed.
- Both listing pages answered **HTTP 403** from the CDN with `cf-mitigated: challenge`
  and a "Just a moment..." interstitial. An earlier probe with a desktop-browser identity
  got the same answer, so the block is not about the User-Agent string.

Reading the plugin against that evidence found these defects:

| Where | Defect | Effect |
| ----- | ------ | ------ |
| client | `createHttpClient({ proxies, caCert, timeout })`: the factory reads `requestTimeout`, not `timeout`, whenever `proxies` is present; `userAgent` was never forwarded | a caller's timeout is silently replaced by 60 s when proxies are set; a per-request UA is ignored |
| client | no `Accept` / `Accept-Language` | the HTML page is requested with a JSON-first `Accept` |
| slug | `searchTerm.replace(/\s+/g, '-')` only | `C++-developer`, raw accents in the path, `/jobs/-jobs/` for an empty term |
| path | `/en/international/` hard-coded | `country` / `location` ignored |
| page loop | a 200 with zero cards is "end of results" | a challenge served with 200 is reported as an **empty board** |
| page loop | no cross-page id set; any parsed card counts as "new" | duplicate rows; pagination continues over repeat pages; no page cap |
| page loop | per-card failures only logged | markup drift (cards present, none parsed) looks like an empty board |
| card | `h2.text().trim()` | titles keep inner newlines and runs of spaces |
| card | `` `${baseUrl}${href}` `` | an absolute `href` becomes `https://www.bayt.comhttps://...`; tracking query strings kept |
| card | raw location text into `city`, `country: WORLDWIDE` | `"Dubai · United Arab Emirates"` is a city |
| card | `id = bayt-<hash(jobUrl)>` | the id changes with the query string; the site's numeric id ignored |
| e2e | ungated, asserts only `Array.isArray(jobs)` | hits the network on every `jest` run and **passes while the source is blocked** |

## 2. Goals

- Build robots-compliant search URLs: a normalised ASCII slug and a market path segment.
- Map cards to `JobPostDto` with a stable numeric id, a canonical `jobUrl`, a collapsed
  title, a city/country split through the shared parser, remote flags and a posted date.
- Page defensively: sequential, deduped, stop on a page that adds nothing, capped, `offset`.
- Never return a silent empty result: challenge → `blocked` with a precise detail, markup
  drift → `unknown` with an actionable detail, an unusable term → `bad_input` with no request.
- Keep every pre-1710 behaviour reachable behind an option / env var.

## 3. Non-Goals

- **No challenge evasion.** No browser path, no fingerprint headers, no UA change, no
  retry-until-pass. The plugin reports `blocked` and stops.
- No detail-page fetches (descriptions at board depth are a follow-up, only worth doing
  once the source is reachable).
- No server-side filter parameters — robots.txt forbids them. `hoursOld` is client-side;
  `jobType` and `isRemote` are not filters here.
- No change to `createHttpClient` (the factory's dropped-`timeout` issue affects many
  plugins; this spec only stops Bayt from tripping it).
- No new `Country` enum values (the Levant/North-Africa countries are promoted locally).

## 4. User / Caller Stories

> As an **API caller**, I want a Bayt search that the site blocks to come back as
> `blocked`, so that I do not mistake a challenge for "no jobs".

> As an **operator**, I want a markup change to surface as a diagnostic that names the
> page and card count, so that I know the parser needs attention.

> As a **caller searching the Gulf**, I want `country: UNITEDARABEMIRATES` (or
> `location: 'Dubai, UAE'`) to search `/en/uae/`, so that results are scoped.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `createHttpClient` receives `{ proxies, caCert, requestTimeout, userAgent }`; the client gets `Accept` (HTML first) and `Accept-Language: en-US,en;q=0.9`, and no User-Agent or `sec-*` header of the plugin's own. | must |
| FR-2  | `toBaytSlug`: transliterate letters NFKD leaves whole (`ß ẞ æ ø œ ł đ ð þ ı`), NFKD, strip marks, lower-case, whitespace → `-`, drop `[^a-z0-9-]`, collapse `-`, trim `-`. | must |
| FR-3  | A non-empty term whose slug is `''` returns `[]` + `bad_input` ("search term has no ASCII letters or digits after slug normalisation") and makes **no** request. An empty term browses `/en/<market>/jobs/`. | must |
| FR-4  | Market path: `country` when it is a Bayt market (`uae`, `saudi-arabia`, `qatar`, `kuwait`, `bahrain`, `oman`, `egypt`, `morocco`); otherwise the market the shared parser reads from `location`; otherwise `international`. | must |
| FR-5  | `buildSearchUrl` never emits `/en|ar|fr/jobs/...` nor `filters[`, `filters%5`, `options[`, `options%5`; `page` is the only query parameter; a refused path is `bad_input` with no request. | must |
| FR-6  | Pages are fetched one at a time from page 1 with a 2–5 s random pause between them; ids are deduped across pages; the loop stops on a page with no cards, a page that adds no unseen id, `resultsWanted` rows, or the page cap (10). | must |
| FR-7  | `offset` skips that many unique (post-`hoursOld`) jobs before rows are collected; `resultsWanted` defaults to 15. | must |
| FR-8  | Card id: `bayt-<data-job-id>`, else `bayt-<trailing 5+ URL digits>`, else `bayt-<abs(hash(canonical URL))>`. | must |
| FR-9  | `jobUrl` = `new URL(href, https://www.bayt.com)` with query and fragment removed; non-http(s) hrefs make the card unparseable. `companyUrl` from a `/company/` anchor, canonicalised the same way. | must |
| FR-10 | Title whitespace collapsed; location cell: two or more anchors joined with `', '`, else the cell text; `·`, `•`, `|` become commas; `parseLocationList`; a regional country reported as a state (Jordan, Lebanon, Algeria, Tunisia, Iraq, Palestine, Libya, Sudan, Syria, Yemen) is promoted to `country`; nothing parsed → `location: null` (never a fabricated `WORLDWIDE`). | must |
| FR-11 | `isRemote = remoteMentioned \|\| null`, `workFromHomeType` from the parser. | must |
| FR-12 | Posted label (`Today`, `Yesterday`, `N <unit>s ago`, `30+ days ago`, also inside longer text) → `datePosted` plus the Spec 1696 precision/basis fields via `postedFromRelativeLabel` / `postedTimeFields`. | must |
| FR-13 | `hoursOld` drops a card only when its label's age (a lower bound) exceeds the window; undated cards are kept. | must |
| FR-14 | Diagnostics: a fetch error with `cf-mitigated: challenge` → `blocked` "bayt.com served a Cloudflare managed challenge (HTTP 403, cf-mitigated: challenge)"; an error body that is a challenge page → `blocked`; any other error → `classifyScrapeError`; HTTP 200 with no cards and a challenge body → `blocked` "bayt.com served a bot challenge page with HTTP 200"; cards present but none parsed → `unknown` "N cards on page P, none parsed: listing markup changed?"; a genuinely empty page → no diagnostic. Jobs collected before a failure are returned with it. | must |
| FR-15 | The live e2e runs only with `RUN_NETWORK_E2E`; it passes on well-formed jobs **or** `blocked`, and fails on zero jobs with no diagnostic. | must |
| FR-16 | Pre-1710 behaviour stays reachable: legacy card mapping, legacy slug, international-only path, page cap (see §7.1). | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Concurrency against bayt.com | 1 request in flight |
| NFR-2  | Requests per scrape | ≤ page cap (10 by default, 50 hard ceiling) |
| NFR-3  | Parsing helpers | pure, never throw on page input, linear in input size (location text capped at 300 chars, posted text at 200) |
| NFR-4  | Tests | offline, synthetic fixtures < 3 KB each |

## 7. Contracts

### 7.1 API / Interface

```ts
// packages/plugins/source-bayt/src/bayt.constants.ts
export interface BaytScrapeOptions {
  legacyMapping: boolean; // EVER_JOBS_BAYT_LEGACY_MAPPING, default false
  legacySlug: boolean;    // EVER_JOBS_BAYT_LEGACY_SLUG, default false
  countryScope: boolean;  // EVER_JOBS_BAYT_COUNTRY_SCOPE, default true
  maxPages: number;       // EVER_JOBS_BAYT_MAX_PAGES, default 10, clamped 1..50
}
export function resolveBaytOptions(
  overrides?: Partial<BaytScrapeOptions>,
  env?: NodeJS.ProcessEnv,
): BaytScrapeOptions;

// packages/plugins/source-bayt/src/bayt.service.ts
class BaytService {
  scrape(input: ScraperInputDto, overrides?: Partial<BaytScrapeOptions>): Promise<JobResponseDto>;
}

// packages/plugins/source-bayt/src/bayt.parse.ts (pure)
toBaytSlug(term): string;
legacyBaytSlug(term): string;
resolveCountryPath(input: Pick<ScraperInputDto, 'country' | 'location'>): string;
buildSearchUrl(countryPath: string, slug: string, page: number): string; // throws on a refused path
parseListing(html: string, options?: ParseLocationOptions): { cards: number; jobs: BaytCard[]; failed: number };
parseBaytLocation($, el, options?): BaytLocation | null;
extractJobId(dataJobId, canonicalUrl): { id: string; source: 'data-job-id' | 'url' | 'hash' };
canonicalJobUrl(href): string | null;
parseRelativePosted(text, now: Date | number): Date | null;
toJobPost(card: BaytCard, nowMs: number, options?: { legacyMapping?: boolean }): JobPostDto;
baytFetchDiagnostics(err: unknown): ScrapeDiagnostics;
```

Env switches are read on every scrape; an explicit override wins; an unrecognised value
keeps the default. `legacyMapping` reproduces the pre-1710 `id`, `title`, `jobUrl` and
`location` verbatim (and none of the new fields); pagination, dedup and diagnostics stay on.
`legacySlug` reproduces the pre-1710 slug for ordinary terms, percent-encoding only `/`,
`?`, `#` and `\` so a term cannot add a path segment or a query parameter.

### 7.2 Errors

| Reason       | Meaning |
| ------------ | ------- |
| `blocked`    | the CDN challenged the request (403 `cf-mitigated`, a challenge body, or a 200 challenge page) |
| `bad_input`  | unusable search term, a refused search path, or a 4xx such as a wrong market path (404) |
| `unknown`    | cards present on a page but none parsed (markup drift) |
| (others)     | from `classifyScrapeError` unchanged |

## 8. Acceptance

- `'Ingénieur  Logiciel'` requests `/en/international/jobs/ingenieur-logiciel-jobs/?page=1`;
  `country: UNITEDARABEMIRATES` requests `/en/uae/jobs/...`.
- `'مهندس'` → `[]` + `bad_input`, zero requests.
- Page 1 fixture → ids `bayt-5123456`, `bayt-5123457`, `bayt-5123458`; no `?` in any
  `jobUrl`, one scheme per URL, collapsed titles, split city/country, broken card skipped.
- Page 1 + repeat page + repeat page → 4 unique jobs, exactly 3 requests.
- `offset: 2, resultsWanted: 2` → the 3rd and 4th unique jobs.
- Always-fresh pages → exactly 10 requests.
- 200 challenge → `blocked`; 403 `cf-mitigated` → `blocked` naming the managed challenge;
  page 1 ok then 403 → page-1 jobs + `blocked`; empty page → no diagnostic; all-broken page
  → `unknown` "2 cards on page 1, none parsed: listing markup changed?".
- `hoursOld: 48` keeps `Today` and the undated card, drops `3 days ago`.
- Live (2026-09-25, `RUN_NETWORK_E2E=1`, one request): `blocked`, detail
  "bayt.com served a Cloudflare managed challenge (HTTP 403, cf-mitigated: challenge)".

## 9. Open Questions

- **Q1** — how the site slugs symbol-bearing skills (`C++`, `C#`). Both become
  `c-developer` today; pinned by a test so a change is deliberate.
- **Q2** — `li[data-job-id]` and `[data-automation-id="job-active-date"]` are unverified
  (the listing is challenge-gated). Both are optional; a miss degrades to the URL-digits id
  and `datePosted: null`.
- **Q3** — market paths beyond `uae` / `saudi-arabia`. A wrong one answers 404 → `bad_input`.
- **Q4** — the page size, which would allow starting at a later page for a large `offset`.
