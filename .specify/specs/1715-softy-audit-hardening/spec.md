# Spec: 1715 — Softy source: stop on push-back, sitemap-first for real

| Field | Value |
|---|---|
| Spec ID | 1715 |
| Slug | softy-audit-hardening |
| Status | in-progress |
| Owner | agent |
| Created | 2026-09-26 |
| Last updated | 2026-09-27 |
| Supersedes | — |
| Related specs | 374 (source-ats-softy), 1690 (crawl policy), 1691 (Softy sitemap discovery), 1714 (caller lock and host policies — the shared-layer half of this work) |
| Plan / tasks | [plan.md](./plan.md) · [tasks.md](./tasks.md) |
| Operator guide | [docs/CRAWL_POLICY.md](../../../docs/CRAWL_POLICY.md) (Softy section) |
| Audit gaps closed | G1 (part), G3, G6, G13, G14, G16, G17, G19, G20, G21, G22, G23, G24 (part), G25, G26, G30, K0, K1 |
| Review round 2 (2026-09-27) | plugin halves of findings A0 (legacy detail URLs), A1 (a caller's budget no longer reads list pages), A3 (`jobUrlListedAt`), A5 + F4 (nested sitemaps), C1 (timing proof), and the F4 wording fix: FR-21..FR-25, tasks T16..T22. Shared-layer halves: [Spec 1714](../1714-crawl-caller-lock-and-host-policies/spec.md) FR-19..FR-27 |

## 1. Problem Statement

Spec 1691 moved `source-ats-softy` to sitemap discovery at one request per second
across `softy.pro`, as Softy's operator asked. The 2026-09-26 audit found that the plugin
still reaches for list pages and keeps asking when the server pushes back:

- **Fallback on any error** (G21, G13, K1): in `auto`, a 5xx, a timeout, a 403 or a
  bot wall on `/sitemap.xml` sends the scrape to `/offers?page=1` (the heavier SSR page
  the operator asked us to avoid) and on to `/offres`. A 503 is a throttle signal for
  `HttpClient` but a plain failure for the plugin: it falls back and keeps fetching detail
  pages.
- **Blocks look like empty boards** (K1, G20): 401/403/407 and challenge pages are
  treated as "missing", no diagnostic reaches the API, so neither the multi-location loop
  nor the circuit breaker stops, and a 403 WAF on detail pages costs up to 100 requests
  for 0 results.
- **Unknown tenants cost three requests** (K0): every company-slug search probes Softy;
  an unknown slug sends sitemap + list page + `/offres` (per location). Unknown tenants
  are NXDOMAIN (no wildcard DNS), so an unknown slug never needs to reach Softy at all.
- **Sitemap path defects**: `offset` counts against the detail budget, so paginated
  `auto` searches crawl list pages (G19); duplicate offer ids are fetched twice (G25); an
  operator cannot enforce sitemap-only — `descriptionDepth: 'board'` beats it and
  `SOFTY_MAX_LIST_PAGES` cannot be 0 (G22); the caller's `crawl.discovery` bypasses the
  resolver outside a scrape context.
- **Pacing gaps inside the plugin**: no interval floor, so a caller's `rateDelayMin: 0`
  removes the 1 s spacing (G3); the manifest has no retry / back-off fields of its own
  (G14); the legacy `/offres` request is a 301 whose second hop is not paced (G6); a
  multi-location search does not see a 429 that follows a 5xx (G17).
- **Caches**: the sitemap is re-read on every search (G23); the detail cache expires
  after 6 h although its key already carries `lastmod` (G24).
- **Tests and CI**: unit tests replace `HttpClient` with a fake, so real retries and
  pacing on these paths are never exercised, and several tests enshrine the fallbacks
  above (G26); the live e2e sends requests to `ensio.softy.pro` on every push and PR
  (G30).

## 2. Goals

- Stop at the first push-back (block, throttle, struggling server) with a diagnostic the
  API recognises; never move to heavier pages because the server is unwell.
- Sitemap first for real: list pages only when the sitemap answered but was empty or
  unparseable (default), or when the operator chooses otherwise.
- Unknown tenants cost one DNS lookup, then nothing for an hour.
- Prove the request sequence and spacing with the real `HttpClient` and limiter against
  a local server, including a control run that shows the old sequence.
- Keep every old behaviour one switch away (owner rule), and every knob configurable.

## 3. Non-Goals

- Shared (cross-replica) caches or pacing — Spec 1714 Q-122.
- Excluding Softy from the implicit all-ATS fan-out: unknown slugs are NXDOMAIN and now
  stop after one DNS lookup with a negative cache (K0 is closed without it).
- A tenant's custom domain served by Softy's server (not knowable from the plugin).

## 4. User / Caller Stories

> As **Softy's operator**, I want Ever Jobs to read my `/sitemap.xml`, then only the
> offer pages it needs, one at a time, and to go away when I say 429, 503 or 403, so that
> my shared server is not loaded by a job aggregator.

> As the **Ever Jobs operator**, I want each of these behaviours to be a setting, with
> the old behaviour available, so that I can match any agreement I make with a site.

> As an **API caller**, I want a Softy result to tell me why it is short (`blocked`,
> `rate_limited`, `partial`, `bad_input` for an unknown tenant) instead of an empty board.

## 5. Functional Requirements

| ID | Requirement | Gaps | Priority |
|---|---|---|---|
| FR-1 | Manifest `SOFTY_CRAWL_POLICY` = `{ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000, minGapMs: 500, callerOverrides: 'stricter', proxyRotation: 'per-host', retries: 1, retryStatuses: [429, 503], throttleRetryDelayMs: 10000, serverErrorCooldownMs: 30000, respectRetryAfter: true, retryAfterOverMax: 'give-up', userAgentMode: 'identify' }`. It agrees with `BUILTIN_SOFTY_HOST_POLICY` (Spec 1714) on every field but `userAgentMode` (parity test). | G3, G14, G0 | must |
| FR-2 | The Softy client is built with `minIntervalFloorMs: 1000` (`SOFTY_LEGACY=no-interval-floor` → none, pre-1715). | G3 | must |
| FR-3 | Discovery is always resolved through the crawl policy **inside** a scrape context (the plugin opens its own, with its manifest and the caller's `crawl`, before resolving when called outside `JobsService`), so the Spec 1714 lock applies to `crawl.discovery` on every path. The fallbacks for an unavailable resolver stay. | G22 | must |
| FR-4 | Sitemap stage per `SOFTY_SITEMAP_FALLBACK` (`empty` default \| `missing` \| `any-error`), table §7.3. `empty`: list pages only when the sitemap answered 2xx with no offer URL or could not be parsed. `missing`: also on 404/410 (the Spec 1691 wording). `any-error`: the shipped (pre-1715) **decisions** of the sitemap stage — not the whole stage: the manifest's crawl policy and the other Spec 1715 changes still apply (round 2, F4; corrected from "the shipped behaviour exactly"). Explicit `discovery: 'sitemap'` never falls back (unchanged). | G13, G21, K0, K1 | must |
| FR-5 | Unknown tenant: `ENOTFOUND` (on the error or its `cause`) on the scrape's first request stops at once — no fallback, diagnostic `bad_input` "unknown Softy tenant …" — and the tenant goes into a negative cache for `SOFTY_UNKNOWN_TENANT_TTL_MS` (default 1 h, at most 24 h, ≤ 1,000 entries, 0 disables); a cached unknown tenant returns the same diagnostic with no request. Not in `any-error` mode. | K0 | must |
| FR-6 | Page-stage push-back, table §7.4: 401/403/407 or a 200 page with bot-wall markers (`looksLikeChallenge`) stops the whole scrape with `blocked`; 429 / 503 stop with `rate_limited`; a 5xx or timeout on a detail page counts as a failure and `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` (default **1**, was 3) failures stop the scrape with the partial result; a 5xx / timeout on a listing page stops pagination and detail fetches (cards read so far are returned board-only); 404/410 on a detail page skips it. | G13, G20, K1 | must |
| FR-7 | Detail GETs (network, not cache hits) are capped at `min(detail budget, wanted + SOFTY_DETAIL_ATTEMPT_SLACK)` (slack default 5); when the cap shortens the result, a `partial` note says so. | G20 | must |
| FR-8 | `run.error` keeps the most telling error: `preferRefusalError(run.error, err)` (a throttle/refusal replaces an earlier plain 5xx); the response diagnostic is `rate_limited` / `blocked` when the scrape stopped for that reason, else `classifyScrapeError(run.error)`, else the `partial` note. | G17 | must |
| FR-9 | In `auto`, the detail budget is compared with `resultsWanted` only (offset entries cost no detail fetch on the sitemap path). | G19 | must |
| FR-10 | The sitemap path keeps one entry per offer id (the newest `lastmod`), then applies `offset`. | G25 | must |
| FR-11 | An explicit operator `discovery: 'sitemap'` (provenance `env-global`, `operator-site` or `operator-host`) wins over `descriptionDepth: 'board'`: the sitemap path runs with the board budget (cache hits only) and a `partial` note explains it. `SOFTY_MAX_LIST_PAGES=0` disables list pages: `auto` never picks the listing, explicit `listing` returns nothing with a `bad_input` note. | G22 | must |
| FR-12 | Per-tenant sitemap cache: offer entries of a successful sitemap (≥ 1 offer) kept `SOFTY_SITEMAP_CACHE_TTL_MS` (default 10 min, ≤ 200 tenants, 0 disables); a hit sends no sitemap request. | G23 | must |
| FR-13 | Detail cache TTL: when `SOFTY_DETAIL_CACHE_TTL_MS` is unset, sitemap entries (key `url\|lastmod`) never expire (the LRU cap `SOFTY_DETAIL_CACHE_MAX` bounds memory) and listing entries (key `url`, no change indicator) keep 6 h; when it is set, it applies to every entry exactly as before (0 = no expiry). The pre-1715 default is `SOFTY_DETAIL_CACHE_TTL_MS=21600000`. | G24 | must |
| FR-14 | The legacy index is requested at `/offers` (the 301 target) instead of `/offres`, so no unpaced redirect hop (`SOFTY_LEGACY=offres` restores `/offres`). Round 2 (FR-23): legacy cards' detail URLs likewise. | G6 | must |
| FR-15 | A post whose detail page this scrape fetched from the network (2xx, parsed, the fetched URL equals `jobUrl`) carries `jobUrlFetchedAt` (ISO time the response arrived), so the API can skip its liveness probe (Spec 1714 FR-16). Cache hits never set it. | G4, G28 | must |
| FR-16 | Nested sitemaps: the plugin relies on `fetchSitemap`'s default `nestedErrors: 'stop-on-throttle'` (Spec 1714 FR-13); a stop there is a scrape stop (`rate_limited` / the crawl-policy reason). Round 2 (FR-22): a struggling nested answer stops too, and a switch restores the pre-1715 skip. | G16 | must |
| FR-17 | `SOFTY_LEGACY` (comma list, table §7.2) restores individual pre-1715 behaviours; unknown tokens are warned once and ignored; `all` = every token. | — | must |
| FR-18 | Integration test with the real `HttpClient` and limiter against a local HTTP server (loopback allowed through `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS`), §8.2, including a control run with the legacy switches that shows the old sequence. | G26 | must |
| FR-19 | The live Softy e2e runs only on `schedule` / `workflow_dispatch` or when `EVER_JOBS_LIVE_SOFTY=1`; on push/PR it is skipped with a visible reason (the spec stays in the repo). When live, it also asserts the first request was `/sitemap.xml`. | G26, G30 | must |
| FR-20 | `README.md` gains a short "For website operators" section, reachable from the UA URL (`https://github.com/ever-jobs/ever-jobs`): what `EverJobs/1.0` means, default pacing, that the code is self-hosted by many people (so traffic may not be ours), how to reach the project (GitHub issues), and how a site can get a site-owner policy like Softy's. | G1 (part) | must |

**Review round 2 (2026-09-27).** Plugin halves of the confirmed review findings; each keeps
the old behaviour behind the switch named.

| ID | Requirement | Finding | Priority |
|---|---|---|---|
| FR-21 | **A caller's budget does not choose list pages.** In `auto`, "detail budget < `resultsWanted`" reads list pages only when the operator allows it: the `auto` came from an operator layer (`EVER_JOBS_CRAWL_DISCOVERY`, `sites.softy` / `hosts[…]` `discovery: 'auto'`), the effective caller-override mode is `any` (the operator lifted the lock), `SOFTY_MAX_DETAIL_FETCHES=0`, or `SOFTY_LEGACY=caller-listing`. Otherwise the sitemap path returns what the budget allows, with a `partial` note naming the mode, the layer that set it and the switches. The mode comes from `resolveCallerOverrides` (inside a scrape context: its site and plugin layer; outside: the Softy manifest) for the Softy host, builtin `*.softy.pro` entry and operator entries included; if the resolver throws, the manifest's `stricter`. `descriptionDepth: 'board'` still reads the listing (D5, kept). | A1 (G22) | must |
| FR-22 | **Nested sitemaps.** `onNestedSitemapError` stops the scrape when a child answers 500/502/504, times out or resets (`isServerStruggling`, the classifier behind the server-error cool-down): diagnostic `fetch_error` / `timeout`, `run.stopped` set, as on the root sitemap. `fetchSitemap` gets `nestedErrors: 'skip'` when `SOFTY_SITEMAP_FALLBACK=any-error` or `SOFTY_LEGACY=nested-skip`; then every nested failure is skipped (429/503, cool-downs, 401/403/407, challenge pages, 5xx), as before Spec 1715. A 404/410, size cap, bad gzip or scope refusal is still skipped by default. | A5, F4 (G16) | must |
| FR-23 | **Legacy detail URLs.** Legacy cards and `buildJobUrl` build `/offers/{ID}` (the target of the `/offre/{ID}-{slug}` 301), so each detail GET is one paced request (with Spec 1714 FR-19 a hop there would be paced anyway, at the cost of a second request). `SOFTY_LEGACY=legacy-detail-url` restores `/offre/{ID}-{slug}`. | A0 (G6) | must |
| FR-24 | **`jobUrlListedAt`.** Every post taken from a sitemap carries `jobUrlListedAt` = when the ROOT sitemap's network answer arrived (for an index, the children answer later, so it never overstates freshness). The sitemap cache stores it (`CachedSitemap.listedAt`), so a cache hit carries the original network time, never the time of the hit. Posts from list pages do not carry it. The API trusts it for `?liveness=true` (Spec 1714 FR-25). | A3 (G28) | must |
| FR-25 | **Timing proof of the 1 s interval** (integration): a fast server (20 ms answers), where the 0.5 s idle gap alone would space starts ~0.5 s apart, shows starts ≥ 1 s apart; a control lowers only the interval (operator `sites.softy {minIntervalMs: 0}` + `SOFTY_LEGACY=no-interval-floor`, `minGapMs` kept) and shows starts < 975 ms apart; a second control keeps the client floor alone and still shows ≥ 1 s. | C1 | must |

## 6. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Requests per scrape, default config, healthy tenant, `resultsWanted` n | 1 sitemap (0 on a cache hit) + ≤ n detail pages (0 for cached offers) |
| NFR-2 | Requests per scrape on push-back | the refused request only (plus `HttpClient`'s own 1 retry on 429/503 without a long `Retry-After`) |
| NFR-3 | Unknown tenant | 1 DNS lookup, 0 HTTP requests; 0 lookups within the negative-cache TTL |
| NFR-4 | Spacing on `softy.pro` | ≥ 1 s start to start, ≥ 0.5 s idle after completion, 1 in flight (× `EVER_JOBS_CRAWL_FLEET_SIZE`) |
| NFR-5 | No unit or integration test touches the network | loopback server or fakes only |
| NFR-6 | Integration suite duration | < 30 s, each test < 10 s |

## 7. Contracts

### 7.1 Plugin surface (`packages/plugins/source-ats-softy/src/`)

```ts
// softy.constants.ts (every existing export kept)
export const SOFTY_CRAWL_POLICY: PluginCrawlPolicy;          // FR-1 values
export const SOFTY_MIN_INTERVAL_FLOOR_MS = 1000;
export type SoftySitemapFallback = 'empty' | 'missing' | 'any-error';
export const SOFTY_SITEMAP_FALLBACK: SoftySitemapFallback = 'empty';
export const SOFTY_UNKNOWN_TENANT_TTL_MS = 3_600_000;
export const SOFTY_UNKNOWN_TENANT_TTL_MAX_MS = 86_400_000;
export const SOFTY_UNKNOWN_TENANT_CACHE_MAX = 1000;
export const SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES = 1;       // was 3
export const SOFTY_LEGACY_MAX_CONSECUTIVE_DETAIL_FAILURES = 3;
export const SOFTY_DETAIL_ATTEMPT_SLACK = 5;
export const SOFTY_SITEMAP_CACHE_TTL_MS = 600_000;
export const SOFTY_SITEMAP_CACHE_MAX = 200;
export const SOFTY_DETAIL_CACHE_TTL_MS = 0;                   // sitemap entries; was 6 h
export const SOFTY_LISTING_DETAIL_CACHE_TTL_MS = 21_600_000;  // listing entries when the env is unset
export const SOFTY_LEGACY_DETAIL_CACHE_TTL_MS = 21_600_000;   // the pre-1715 default for every entry
export const SOFTY_LEGACY_INDEX_PATH = '/offers';             // SOFTY_OFFERS_PATH ('/offres') kept
export const SOFTY_LEGACY_TOKENS = [
  'offset-budget', 'duplicate-ids', 'board-over-sitemap', 'offres',
  'block-as-missing', '503-as-failure', 'listing-failure-details', 'no-interval-floor',
  'caller-listing', 'nested-skip', 'legacy-detail-url',          // review round 2
] as const;
export type SoftyLegacyToken = (typeof SOFTY_LEGACY_TOKENS)[number];
// SOFTY_ENV gains: SITEMAP_FALLBACK, UNKNOWN_TENANT_TTL_MS, DETAIL_ATTEMPT_SLACK,
//                  SITEMAP_CACHE_TTL_MS, LEGACY

// softy.types.ts — SoftyConfig gains
sitemapFallback: SoftySitemapFallback;
unknownTenantTtlMs: number;
detailAttemptSlack: number;
sitemapCacheTtlMs: number;
listingDetailCacheTtlMs: number;          // derived (FR-13)
minIntervalFloorMs: number;               // 1000, or 0 with 'no-interval-floor'
legacy: ReadonlySet<SoftyLegacyToken>;
// (maxListPages now accepts 0)

// softy.parser.ts (new helpers; the tenant-based ones are kept)
export function softyListingPageUrlFrom(origin: string, page: number): string;
export function softyOfferUrlFrom(origin: string, id: string): string;
/** 'sitemap' (has <urlset>/<sitemapindex>), 'challenge' (looksLikeChallenge), else 'unparseable'. */
export function softySitemapBodyKind(text: string): 'sitemap' | 'challenge' | 'unparseable';

// softy.service.ts
/** The tenant's origin, `https://{tenant}.softy.pro`. A test seam only: subclassed by the
 *  integration test to point at a loopback server; never derived from input. */
protected tenantOrigin(tenant: string): string;
/** Clears the detail, sitemap and unknown-tenant caches. `clearDetailCache()` is kept. */
clearCaches(): void;
```

### 7.2 Configuration (read per scrape; invalid values warned once, then the default)

| Variable | Values (default) | Restores pre-1715 with |
|---|---|---|
| `SOFTY_SITEMAP_FALLBACK` | `empty` \| `missing` \| `any-error` (`empty`) | `any-error` |
| `SOFTY_UNKNOWN_TENANT_TTL_MS` | int ms 0..86,400,000 (`3600000`; above the max clamped) | `0` |
| `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` | int ≥ 0 (`1`; 0 = never stop early) | `3` |
| `SOFTY_DETAIL_ATTEMPT_SLACK` | int ≥ 0 (`5`) | any value ≥ `SOFTY_MAX_DETAIL_FETCHES` (e.g. `100`) |
| `SOFTY_SITEMAP_CACHE_TTL_MS` | int ms ≥ 0 (`600000`; 0 disables) | `0` |
| `SOFTY_DETAIL_CACHE_TTL_MS` | int ms ≥ 0 (unset: FR-13; set: every entry, 0 = no expiry) | `21600000` |
| `SOFTY_MAX_LIST_PAGES` | int ≥ **0** (`50`; 0 = no list pages) | — |
| `SOFTY_LEGACY` | comma list of the tokens below, or `all` (empty) | `all` |
| `SOFTY_MAX_DETAIL_FETCHES`, `SOFTY_DETAIL_CACHE_MAX`, `SOFTY_LASTMOD_AS_DATE_POSTED` | unchanged | — |

| `SOFTY_LEGACY` token | Restores | Gap |
|---|---|---|
| `offset-budget` | `offset` counts against the detail budget in `auto` | G19 |
| `duplicate-ids` | no offer-id dedupe on the sitemap path | G25 |
| `board-over-sitemap` | `descriptionDepth: 'board'` beats an operator `sitemap` | G22 |
| `offres` | legacy index requested at `/offres` | G6 |
| `block-as-missing` | 401/403/407 and challenge pages on list/detail pages treated as missing | K1, G20 |
| `503-as-failure` | a 503 on list/detail pages is a plain failure, not a stop | G13 |
| `listing-failure-details` | a failed listing page still lets the collected cards' detail pages be fetched | G13 |
| `no-interval-floor` | no `minIntervalFloorMs` on the Softy client | G3 |
| `caller-listing` (round 2) | under a caller lock, a detail budget shorter than `resultsWanted` still reads list pages in `auto` | G22 (A1) |
| `nested-skip` (round 2) | every nested-sitemap failure is skipped and the walk goes on (429/503, a crawl-policy refusal, 5xx / timeouts, 401/403/407, a challenge page) | G16 (A5, F4) |
| `legacy-detail-url` (round 2) | legacy cards link `/offre/{ID}-{slug}` (a 301 hop) instead of its target `/offers/{ID}` | G6 (A0) |

The crawl policy side (manifest, builtin host entry, lock) is undone by operator policy
(Spec 1714 §7.4): the lock with the `callerOverrides: "any"` JSON plus
`SOFTY_LEGACY=no-interval-floor`, the whole pre-1715 crawl policy with the recipe in
`docs/CRAWL_POLICY.md` §16 (`EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE=*.softy.pro,softy.pro`,
a `sites.softy` entry with the preset's retry / back-off values, `minGapMs: 0`,
`serverErrorCooldownMs: 0`, and `SOFTY_LEGACY=no-interval-floor`).

### 7.3 Sitemap stage (`auto` discovery)

| Sitemap answer | `empty` (default) | `missing` | `any-error` (shipped decisions) |
|---|---|---|---|
| 2xx, ≥ 1 offer URL | sitemap path | sitemap path | sitemap path |
| 2xx sitemap, 0 offer URLs | listing | listing | listing |
| 2xx, not a sitemap, no bot-wall markers (soft-404 HTML, garbage) | listing | listing | listing |
| 2xx with bot-wall markers | stop, `blocked` | stop, `blocked` | listing |
| 404 / 410 | stop, `bad_input` (the detail names `SOFTY_SITEMAP_FALLBACK=missing`) | listing | listing |
| 401 / 403 / 407 | stop, `blocked` | stop, `blocked` | listing |
| other 4xx (not 429) | stop, diagnostic | stop, diagnostic | listing |
| 429 (after `HttpClient`'s retry) | stop, `rate_limited` | stop, `rate_limited` | stop (shipped) |
| 503 | stop, `rate_limited` | stop, `rate_limited` | listing |
| 500 / 502 / 504, timeout, reset, other network error | stop, diagnostic | stop, diagnostic | listing |
| `ENOTFOUND` (first request) | stop, `bad_input` unknown tenant, negative cache | same | listing, no negative cache |
| robots.txt refusal | stop, `blocked` | listing | listing |
| crawl-policy refusal (cool-down, queue timeout, egress), abort | stop | stop | stop (shipped) |

"Stop" means no further request of any kind in this scrape. Explicit `discovery:
'sitemap'` turns every "listing" cell into "stop" with the diagnostic (unchanged from
1691). `discovery: 'listing'` (explicit, board depth, a short budget the operator allows
— FR-21 — or `auto` with list pages disabled) skips this table.

Nested sitemaps (round 2, FR-22), per child: 429/503 or a crawl-policy refusal → stop
(`rate_limited` / the refusal's reason); 401/403/407 or a challenge page → stop,
`blocked`; 500/502/504, timeout, reset → stop, `fetch_error` / `timeout`; anything else
(404/410, size cap, bad gzip, scope refusal) → skipped. Under `any-error` or
`SOFTY_LEGACY=nested-skip`: every nested failure skipped.

### 7.4 Page stage (listing pages, legacy index, detail pages)

| Answer | Default | Pre-1715 via |
|---|---|---|
| 2xx page | parsed | — |
| 2xx page with bot-wall markers | stop the scrape, `blocked` | `block-as-missing` |
| 401 / 403 / 407 | stop the scrape, `blocked` | `block-as-missing` |
| 404 / 410 / other 4xx on a detail page | skip it (attempt cap FR-7) | `SOFTY_DETAIL_ATTEMPT_SLACK` ≥ budget |
| 404 / 410 on listing page 1 | legacy index at `/offers` (FR-14) | `offres` |
| a legacy card's link `/offre/{ID}-{slug}` | the post's URL is `/offers/{ID}` (FR-23) | `legacy-detail-url` |
| 429 (after `HttpClient`'s retry) | stop, `rate_limited` | (pre-1715 also stopped) |
| 503 | stop, `rate_limited` | `503-as-failure` |
| 5xx / timeout on a detail page | failure; `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` (1) in a row stop the scrape, partial result + diagnostic | `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES=3` |
| 5xx / timeout on a listing page | stop pagination and details; cards read so far returned board-only; diagnostic | `listing-failure-details` |
| `ENOTFOUND` on the first request (discovery `listing`) | unknown tenant (FR-5) | `SOFTY_SITEMAP_FALLBACK=any-error` |
| crawl-policy refusal, abort | stop (unchanged) | — |

### 7.5 Diagnostics

| Stop | `ScrapeDiagnostics` |
|---|---|
| 429 / 503 / `HostCoolingDownError` / `CrawlQueueTimeoutError` | `rate_limited`, detail = the error message |
| 401 / 403 / 407 / challenge page / robots refusal | `blocked` |
| unknown tenant | `bad_input`, "unknown Softy tenant "x": x.softy.pro does not resolve (not asked again for 1 h; SOFTY_UNKNOWN_TENANT_TTL_MS)" |
| sitemap 404/410 under `empty` | `bad_input`, names `SOFTY_SITEMAP_FALLBACK=missing` |
| 5xx / timeout | `classifyScrapeError` (`fetch_error` / `timeout`) — `partial` upstream when jobs were returned |
| budget / attempt cap / board with operator sitemap / list pages disabled | the `partial` or `bad_input` note |

## 8. Test Plan

### 8.1 Unit (`__tests__/softy.service.spec.ts`, `softy.policy.spec.ts`, `softy.parser.spec.ts`)

The tests that enshrine the audited behaviour keep their old assertion under the legacy
switch and gain a default-behaviour twin:

| Existing test | New default assertion | Old assertion kept under |
|---|---|---|
| "falls back to the listing on a 404 / 5xx / network error" | 404 → `[SITEMAP]`, `bad_input`; 503 → `[SITEMAP]`, `rate_limited`; `ECONNRESET` → `[SITEMAP]`, `fetch_error`; empty urlset / no offers / soft-404 HTML → listing (unchanged) | `SOFTY_SITEMAP_FALLBACK=any-error` (404 also with `missing`) |
| "board depth reads the listing even when discovery is 'sitemap'" (caller) | unchanged for a caller value; new: operator `EVER_JOBS_CRAWL_DISCOVERY=sitemap` + board → `[SITEMAP]` + `partial` | `SOFTY_LEGACY=board-over-sitemap` |
| "offset counts against the budget too" | offset 20 + 10 wanted, budget 25 → sitemap first | `SOFTY_LEGACY=offset-budget` (round 2: `offset-budget,caller-listing`, since the budget trigger alone no longer reads list pages under the lock) |
| "uses the listing when the detail budget cannot cover every wanted offer (detail-25, resultsWanted 60)" (round 2, FR-21) | under the Softy lock: `[SITEMAP]` + 25 detail pages, 25 posts, `partial` note naming the lock; also for `resultsWanted` above `SOFTY_MAX_DETAIL_FETCHES` | `SOFTY_LEGACY=caller-listing` (the red control); an operator `auto` (env or `sites.softy`) or `sites.softy.callerOverrides: "any"` keep the listing by design |
| "reads the legacy index at /offers when /offers?page=1 is missing" (round 2, FR-23) | detail pages at `/offers/{ID}` | `SOFTY_LEGACY=legacy-detail-url` (`/offre/{ID}-{slug}`; the pre-1715 sequence via `/offres` with `SOFTY_SITEMAP_FALLBACK=any-error` + `SOFTY_LEGACY=offres,legacy-detail-url`) |
| "an unknown tenant (404 everywhere)" | `[SITEMAP]` only, `bad_input` | `SOFTY_SITEMAP_FALLBACK=any-error` + `SOFTY_LEGACY=offres` (3 calls incl. `/offres`) |
| "a host that does not resolve" | `bad_input` unknown tenant, 1 call; a second scrape: 0 calls; after the TTL (fake clock): 1 call | `SOFTY_SITEMAP_FALLBACK=any-error` (empty, no diagnostic) |
| "a 5xx on page 1 is empty with a diagnostic" (503) | `rate_limited` | `SOFTY_LEGACY=503-as-failure` (`fetch_error`) |
| "stops after SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES" | stops after 1 | `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES=3` |
| "a repeat sitemap scrape re-reads only the sitemap" | a repeat scrape within 10 min sends nothing | `SOFTY_SITEMAP_CACHE_TTL_MS=0` |
| "entries expire after SOFTY_DETAIL_CACHE_TTL_MS" | env unset: sitemap entries never expire, listing entries after 6 h | explicit `SOFTY_DETAIL_CACHE_TTL_MS` (every entry) |
| "reads /offres when /offers is missing" | reads `/offers` | `SOFTY_LEGACY=offres` |
| "outside a scrape context the caller's crawl.discovery wins" | the caller value goes through the resolver (the lock refuses `listing`; `sitemap` accepted) | operator `sites.softy.callerOverrides: "any"` |

New unit tests: detail 403 → stop, `blocked`, no further request; challenge page on a
detail / listing page → `blocked`; 5xx then 429 on details → `rate_limited` (FR-8); 404 on
every detail with wanted 2 → 2 + 5 detail GETs then a `partial` note; duplicate ids
(`/offers/1001` and `/en/offers/1001`, different lastmod) → one GET, newest lastmod;
`SOFTY_MAX_LIST_PAGES=0` in `auto` + board → sitemap path + note, in `listing` → no
request + `bad_input`; `jobUrlFetchedAt` set on a network fetch, absent on a cache hit;
`SOFTY_LEGACY` parsing (tokens, `all`, unknown token warned once); config clamps. Each
default test's **red control** is the same test with the switch in the right-hand
column.

Round 2 unit tests (`softy.service.spec.ts`, `softy.config.spec.ts`): the caller lock
MODE is read from the real `resolveCallerOverrides` (Softy manifest + builtin host →
`stricter` on a clean env), so the crawl-policy env keys are reset per test. FR-21: under
the lock (called directly, inside a `JobsService`-like scrape context, with only the
builtin host entry — manifests off —, or with a global `EVER_JOBS_CRAWL_CALLER_OVERRIDES=none`)
a short budget stays on the sitemap; an operator `auto`, a lifted lock or no lock layer
read the listing; `caller-listing` is the red control. FR-22: a nested child answering
500/502/504, a timeout or a reset stops the scrape with `fetch_error` / `timeout` and
nothing after it; a 410 child is still skipped; under `nested-skip` or `any-error` every
nested failure (incl. 429/503 and 403) is skipped. FR-23: legacy cards link
`/offers/{ID}`; `legacy-detail-url` restores `/offre/{ID}-{slug}`. FR-24: `jobUrlListedAt`
set on every sitemap post at the sitemap's answer time (before any detail page); a
sitemap-cache hit keeps the network time; `SOFTY_SITEMAP_CACHE_TTL_MS=0` carries a new
time each scrape; for an index, the root's answer time; never on list-page posts. The
round-2 tokens are read one by one, are part of `all` and are named by the unknown-token
warning.

`softy.policy.spec.ts` (real resolver): the lock refuses a caller `discovery: 'listing'`
outside and inside a scrape context and accepts `sitemap`; operator
`sites.softy.callerOverrides: 'any'` restores it (**red control** for the lock);
`resolveCrawlPolicy({ site: 'softy', host: 'acme.softy.pro', plugin: SOFTY_CRAWL_POLICY })`
equals the FR-1 numbers. **Parity test**: every field of `BUILTIN_SOFTY_HOST_POLICY`
equals the manifest's, and the manifest has no other field than those plus
`userAgentMode` (**red control**: change `minGapMs` in the manifest to 400 → red).

### 8.2 Integration (`__tests__/softy.integration.spec.ts`, new)

Real `SoftyService` subclass (only `tenantOrigin` overridden →
`http://127.0.0.1:<port>`), real `HttpClient`, a fresh process limiter
(`resetHostLimiter()`), env caches reset per test, `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS=127.0.0.1`,
a local `http.createServer` that scripts answers per path and records arrival and finish
time of every request. The plugin opens its own scrape context, so the manifest policy
paces the loopback "domain" exactly as it paces `softy.pro`.

| Scenario | Expected requests (exact) | Also asserts |
|---|---|---|
| S1 healthy, 3 offers, wanted 2 (the server answers every page after 700 ms, so the idle gap, not the interval, decides each next start) | `/sitemap.xml`, `/offers/3`, `/offers/2` | ≤ 1 in flight; starts ≥ 975 ms apart; idle (previous finish → next arrival) ≥ 475 ms; 2 jobs with `jobUrlFetchedAt` |
| S2 sitemap `503`, and separately `429`, each with `Retry-After: 3600` (the give-up path, so no 10 s retry wait) | `/sitemap.xml` | `rate_limited`; no `/offers?page=` |
| S3 sitemap `500` | `/sitemap.xml` | diagnostic `fetch_error`; no list page |
| S4 sitemap `403` | `/sitemap.xml` | `blocked` |
| S5 detail `403` | `/sitemap.xml`, `/offers/3` | `blocked`; nothing after |
| S6 5 offers all `404`, wanted 1, `SOFTY_DETAIL_ATTEMPT_SLACK=2` | `/sitemap.xml` + 3 detail GETs | `partial` note |
| S7 sitemap 2xx empty `<urlset>` | `/sitemap.xml`, `/offers?page=1`, then details | the fallback still exists |
| C1 control: S3 with `SOFTY_SITEMAP_FALLBACK=any-error`, `SOFTY_LEGACY=all` | `/sitemap.xml`, `/offers?page=1`, … (the old sequence) | S3's default assertion fails under these switches (proves S3 can fail) |
| C2 control: S1 with `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false`, `SOFTY_LEGACY=no-interval-floor` | S1's sequence | start gaps < 975 ms (S1's spacing assertion fails, proves it can) |
| S8 fast server (round 2, FR-25): 20 ms answers, 4 offers, wanted 3 | `/sitemap.xml`, `/offers/4`, `/offers/3`, `/offers/2` | ≤ 1 in flight; starts ≥ 1000 ms apart (only the interval and the client floor can hold that: answer + idle gap ≈ 0.5 s); idle ≥ 475 ms |
| S9 repeat search within 10 min (round 2, FR-24) | first scrape `/sitemap.xml`, `/offers/2`, `/offers/1`; the repeat sends nothing | every post of both scrapes carries the same `jobUrlListedAt` (the sitemap's network time); the repeat's posts carry no `jobUrlFetchedAt` |
| S10 sitemap index whose first child answers 502 (round 2, FR-22) | `/sitemap.xml`, `/s1.xml` | the walk and the scrape stop there; no jobs; `fetch_error` |
| C3 control: S8 with ONLY the interval lowered (`sites.softy {minIntervalMs: 0}` + `SOFTY_LEGACY=no-interval-floor`; `minGapMs` kept) | S8's sequence | the smallest start gap < 975 ms (S8's assertion fails, proves the interval is what holds it); idle ≥ 475 ms still |
| C4 control: `sites.softy {minIntervalMs: 0}` with the client floor kept | `/sitemap.xml`, `/offers/3`, `/offers/2` | starts ≥ 1000 ms apart: the floor alone holds 1 s (G3) |
| C5 control: S10 under `SOFTY_LEGACY=nested-skip` (and `sites.softy {serverErrorCooldownMs: 0}`) | `/sitemap.xml`, `/s1.xml`, `/s2.xml`, `/offers/1` | the 502 child is skipped, 1 job (pre-1715) |

Limiter cool-downs set by S2/S3 are cleared by the per-test limiter reset. S1's spacing
alone does not prove the 1 s interval (700 ms answers + 500 ms idle ≥ 1 s without it —
review finding C1); S8 with C3 does.

### 8.3 Live e2e (`__tests__/softy.e2e-spec.ts`)

`EVER_JOBS_LIVE_SOFTY=1` runs it (at most 5 requests as today) and asserts, with a spy on
`HttpClient.prototype.request`, that the first request is `/sitemap.xml`; otherwise the
two live tests are `describe.skip`ped with a title that names the variable and the CI
triggers, and the offline test (no slug → no request) still runs.

## 9. Open Questions

Shared with Spec 1714 (`docs/questions.md`): **Q-120** (the `SOFTY_LEGACY` tokens are
design additions beyond the brief — default: keep), **Q-123** (weekly scheduled CI run of
the live e2e — default: weekly, Monday 04:23 UTC, plus `workflow_dispatch`), and, added in
the docs pass, **Q-128** (Softy's retry and back-off numbers — default: keep the FR-1
values).

## 10. Decisions

- D1 **Challenge vs unparseable** (the brief lists "no sitemap XML where XML was
  expected" and "bot-wall markers" as challenge signals, and also allows fallback on an
  unparseable 2xx): a 2xx body that is not sitemap XML is `blocked` only when it carries
  bot-wall markers (`looksLikeChallenge`); without markers it is "could not be parsed" and
  the `empty` mode falls back. This keeps a soft-404 page from being reported as a block.
- D2 **`any-error` means the shipped decisions of the sitemap stage**, including 403 and
  503 falling back, `ENOTFOUND` falling back without a negative cache and (round 2, F4)
  every nested-sitemap failure skipped; later stages have their own switches
  (`SOFTY_LEGACY`, `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES`, `SOFTY_DETAIL_ATTEMPT_SLACK`).
  *Corrected in round 2:* it is not "the shipped stage exactly" — the manifest's crawl
  policy (one retry on 429/503 only, the 30 s server-error cool-down that holds a
  fallback list page back after a 5xx, the 1 s client floor) and the other Spec 1715
  plugin changes still apply; the pre-1715 crawl policy is an operator recipe
  (`docs/CRAWL_POLICY.md` §16).
- D3 **Listing entries keep a 6 h TTL** when `SOFTY_DETAIL_CACHE_TTL_MS` is unset: their
  key is the URL only, so "no expiry" would never pick up an edit; an explicit value keeps
  its pre-1715 meaning for every entry.
- D4 **One `SOFTY_LEGACY` list** (precedent: `EVER_JOBS_REMOTEOK_LEGACY`) instead of one
  variable per correction.
- D5 **Operator vs caller `sitemap`**: only an operator-level `discovery: 'sitemap'`
  (env or operator site/host, read from `provenance.discovery`) beats `board`; a caller's
  `sitemap` with `board` keeps the 1691 behaviour (listing), so a caller cannot trade one
  list page for a sitemap of detail fetches the budget does not cover. **Kept in review
  round 2** (finding A1 narrowed): for `board` the listing is the cheaper path — one list
  page per 21 offers, against the sitemap plus one detail page per offer — and the only
  source of card data. Documented in the `readSoftyConfig` table and `CRAWL_POLICY.md` §21.3.
- D6 **Test seam**: a protected `tenantOrigin(tenant)` is the only way to point the
  plugin at a loopback server; it is never derived from input, so it opens no SSRF path.
- D7 **The legacy index stays** (no removal) at `/offers`; with FR-4 it is reached only
  when the listing path is taken and page 1 is missing or unrecognised.
- D8 **Which lock keeps a caller's budget on the sitemap** (round 2, FR-21): any effective
  caller-override mode other than `any` — the Softy manifest or builtin host lock, and also
  a global or operator `stricter` / `none` — not only a site owner's lock
  (`isSiteOwnerCallerLock`). An operator who restricts callers does not want them to steer
  Softy to list pages either; an operator who wants the listing says so with an operator
  `auto`, `callerOverrides: "any"`, or `SOFTY_LEGACY=caller-listing`.
  `SOFTY_MAX_DETAIL_FETCHES=0` keeps the listing too: with detail pages off, the sitemap
  path could return only cached offers.
- D9 **`jobUrlListedAt` is the root sitemap's answer time** (round 2, FR-24), stored with
  the sitemap cache: the earliest instant of the walk, so it never overstates how recently
  an offer was listed, and a cache hit never looks fresher than the network answer.
- D10 **Legacy detail URLs point at the redirect target** (round 2, FR-23) rather than
  relying on Spec 1714's redirect pacing alone: pacing would make the `/offre/` hop a
  second, separately paced request; linking `/offers/{ID}` makes it no request at all.

## 11. References

- Audit gaps G0..G30, K0..K3 (2026-09-26); live facts checked 2026-09-26: tenant
  `robots.txt` allows all with a `Sitemap:` line, `/sitemap.xml` is a `<urlset>` generated
  per request (`Last-Modified` = now, no `ETag`, so conditional GETs save nothing and a TTL
  cache does), unknown tenants are NXDOMAIN.
- [Spec 1691](../1691-softy-sitemap-discovery/spec.md), [Spec 1714](../1714-crawl-caller-lock-and-host-policies/spec.md),
  [Spec 1690](../1690-crawl-policy/spec.md).
