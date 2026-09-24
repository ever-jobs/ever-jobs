# Spec: 1690 — Crawl policy: honest identity, per-host pacing, configurable proxies and back-off

| Field | Value |
|---|---|
| Spec ID | 1690 |
| Slug | crawl-policy |
| Status | Implemented |
| Owner | agent |
| Created | 2026-09-24 |
| Last updated | 2026-09-24 |
| Supersedes | — |
| Related specs | 374 (source-ats-softy), 5085 (retry attribution + Retry-After), 5026 (fan-out bounds), 5093 (cookie jar), 1678 (BrowserPool identity), 005 (circuit breaker), 1691 (Softy sitemap discovery) |

## 1. Problem Statement

A site operator (the CTO of Altagile, who builds the Softy ATS and hosts career
sites on `*.softy.pro`) reported that our `source-ats-softy` plugin is impolite:

1. **No rate limiting.** After the list page it fires up to 100 detail requests at
   once (`Promise.allSettled`), no delay.
2. **Rotating proxies.** Round-robin rotation sends each request from a different
   IP, which looks like rate-limit evasion.
3. **A spoofed browser User-Agent.** The traffic claims to be Chrome without being
   it, so they cannot tell who we are or whom to contact.
4. **Retries on 429/5xx.** When their server pushes back or struggles, we try
   again instead of backing off.

They asked for: an honest UA naming the project; one request at a time per site at
~1 req/s; no proxy rotation (a stable, identifiable origin); respect for 429 and
`Retry-After`; and ideally `/sitemap.xml` for discovery instead of list pages.

The audit (2026-09-24) found the defects are **global**, not Softy-specific:

- `HttpClient`'s constructor pins `User-Agent` at the top level of the axios
  defaults, which beats `defaults.headers.common`, so **every UA a plugin sets
  through `setHeaders()` is silently discarded** (266 plugins). Softy declared
  Chrome/129 but actually sent `Chrome/120.0.0.0` — the client's hard-coded default.
  USAJobs' *required* e-mail UA was discarded the same way.
- 79 plugin fan-outs, 23 unbounded (DigitalRecruiters/Oorwin up to 300 requests at
  once to one host); ~1,090 plugins send requests back to back with no gap.
- `rateDelayMin` does not space concurrent calls (all read the same timestamp).
- Rotation is per request; `DEFAULT_PROXIES` is parsed and never used.
- Retries: 3 × linear on 429/500/502/503/504 with no jitter; `Retry-After` capped
  at 30 s (so a 120 s request is retried after 30 s); one 429 does not slow the
  rest of a burst.
- `createHttpClient`'s DTO branch drops a plugin's own `timeout` whenever proxies
  are set, and ~1,100 plugins never forward `userAgent`/`retries`/`rateDelay*`.
- Search deadline abandons a slow source but lets its requests keep running.

## 2. Goals

- G1 Honest, configurable identity by default; the previous behaviour one setting away.
- G2 Process-wide pacing per host (or registrable domain, or site) that bounds every
  plugin's fan-out without editing plugins.
- G3 Proxy rotation fully configurable, default a stable origin per site.
- G4 Retries that back off and honour `Retry-After`; never retry earlier than asked.
- G5 **Maximum flexibility**: every knob settable by preset, env, plugin manifest,
  operator per-site/per-host policy, and per search request.
- G6 Nothing removed (owner rule): old behaviour = `EVER_JOBS_CRAWL_PRESET=legacy`.
- G7 Softy: sitemap discovery + fixed listing discovery, caller-selectable (Spec 1691).

## 3. Non-Goals

- Rewriting individual plugins' pacing constants (they remain as upper bounds).
- CAPTCHA / bot-challenge handling of any kind.
- Changing production env in `k8s-gitops` (defaults are chosen to need none).

## 4. Design

### 4.1 The policy object and its layers

`CrawlPolicy` (`packages/common/src/http/crawl/types.ts`) holds every knob. It is
resolved per request from six layers, lowest precedence first:

| # | Layer | Source |
|---|---|---|
| 1 | preset | `EVER_JOBS_CRAWL_PRESET` = `polite` (default) \| `legacy` \| `strict` |
| 2 | env-global | `EVER_JOBS_CRAWL_*` (table in §5) |
| 3 | builtin-host | `BUILTIN_HOST_POLICIES` (bulk ATS APIs: Greenhouse, Lever, Ashby, SmartRecruiters) |
| 4 | plugin | `@SourcePlugin({ crawl })`, plus options the plugin passes to `createHttpClient` and a UA it declares via `setHeaders`/per-request headers |
| 5 | operator-site / operator-host | `EVER_JOBS_CRAWL_POLICIES` JSON and/or `EVER_JOBS_CRAWL_POLICY_FILE` (`{ "sites": {...}, "hosts": {"*.softy.pro": {...}} }`); sites first, then hosts (host wins) |
| 6 | caller | the search request's `crawl` object + legacy flat fields, filtered by `EVER_JOBS_CRAWL_CALLER_OVERRIDES` (`any` default \| `stricter` \| `none`) |

`resolveCrawlPolicy` returns the merged policy plus a `provenance` map (which layer
set each field) — surfaced by `GET /api/sources/:site/crawl-policy`.

Presets are complete policies (`defaults.ts`): **polite** (default), **legacy**
(exact pre-1690 behaviour: Chrome/120 UA in `strict` mode, per-request rotation, no
pacing, 3 linear retries on 429/5xx with Retry-After capped at 30 s, no egress
guard), **strict** (honest UA everywhere, 1 in flight per registrable domain, 1 s
gap + jitter, robots.txt obeyed).

**Legacy DTO fields.** `JobsService.scrapeOne` still fills `retries`/`retryDelay`/
`retryBackoff`/`retryMaxDelay` into the per-site DTO for backward compatibility, but
those *filled* values must not reach the caller layer. Only values the caller
actually sent are mapped: `userAgent` → `userAgent` (and, unless the caller also set
`crawl.userAgentMode`, mode `strict` so their UA is what goes out); `rateDelayMin`/
`rateDelayMax` (seconds) → `minIntervalMs` = min×1000, `jitterMs` = (max−min)×1000;
`retries`/`retryDelay`/`retryBackoff`/`retryMaxDelay` → `retries`/
`retryBaseDelayMs`/`retryBackoff`/`retryMaxDelayMs`. `RETRY_PER_SOURCE[site]` maps
into the operator-site layer; `RETRY_DEFAULT_*` into env-global **only when the env
var is explicitly set**. Inside a scrape context, `createHttpClient(dto)` ignores the
DTO's retry/rate/UA fields (the context already carries them); outside any context
(standalone use) they are treated as the plugin/explicit layer as before.

### 4.2 Identity (User-Agent)

Default UA: `Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)`
— the crawler convention used by Googlebot/bingbot: names the project, links to it,
does not claim to be a browser. `EVER_JOBS_CRAWL_CONTACT` inserts an operator
contact into that comment; `EVER_JOBS_CRAWL_FROM` adds a `From:` header.
`EVER_JOBS_CRAWL_USER_AGENT` replaces the string (keywords: `default`/`everjobs`,
`browser`/`legacy` = the exact pre-1690 Chrome/120 string).

The UA is applied by a **request interceptor** (the only point that beats per-request
headers in axios' merge order). `HttpClient` records the UA a plugin *declared* —
`userAgent` option, `setHeaders({'User-Agent'})` (case-insensitive), or a per-request
header — separately from the configured one. Then:

| Resolved mode | Wire UA |
|---|---|
| `identify` (default) | configured UA, unless the **plugin layer** set `userAgentMode: 'plugin'` (with `userAgentReason`), in which case the declared UA (falling back to configured) |
| `strict` | configured UA always |
| `plugin` | declared UA if any, else configured |

When the configured UA is sent and `stripClientHints` is on, `sec-ch-ua*` headers
are removed (a bot UA with Chrome client hints is an inconsistent fingerprint).
Plugin opt-ins to `plugin` mode are limited to sources whose API *requires* a
specific UA (USAJobs: registered e-mail; HeadHunter: app identity) or where a live
A/B check showed the site refuses non-browser clients — each with a reason string.

`BrowserPool` follows the same rules: `BrowserPageOptions.userAgent` (new, optional)
is the declared UA; the context UA is resolved from the policy in scope (stealth
pages keep their random pool UA only when the resolved mode lets the plugin choose).

### 4.3 Pacing — `HostLimiter`

One process-wide limiter (`getHostLimiter()`), LRU-bounded (default 10,000 buckets;
idle buckets evicted). Bucket key = `bucketKeyFor(url, rateLimitScope, site)`:
`host:<hostname>`, `domain:<registrable domain via tldts>`, or `site:<site>`.

`acquire(key, opts)` grants a slot when (a) fewer than `maxConcurrent` are in flight
(0 = unlimited), (b) `now ≥ nextStartAt` where each grant sets
`nextStartAt = now + minIntervalMs × slowdown + random(0..jitterMs)`, and (c) the
bucket is not cooling down. FIFO within a bucket; a timer pumps the queue. It
rejects with `CrawlQueueTimeoutError` after `maxWaitMs` (0 = never) and honours
`AbortSignal` (the waiter is removed). `release()` is idempotent-safe.

`penalize(key, ms)` sets `coolingDownUntil = max(current, now+ms)`.
`recordOutcome(key, 'throttled')` (429/503) doubles `slowdown` (cap 16) and, if the
bucket's interval is 0, applies an adaptive floor of 500 ms × slowdown; `'ok'`
decays it (×0.8, floor 1). Adaptive is per bucket and only when `adaptiveThrottle`.

Every attempt — including retries — holds a slot for its duration.

### 4.4 Proxies

`selectProxy(proxies, rotation, state, bucketKey)`: `per-request` round-robin
(pre-1690), `per-scrape` one proxy per client (first pick, then pinned), `per-host`
stable hash of the bucket key (default), `off` → direct. The proxy list is the
caller's `proxies`, else `EVER_JOBS_CRAWL_PROXIES`, else `DEFAULT_PROXIES`, else none
(axios still honours `HTTP(S)_PROXY`/`NO_PROXY` as before). `'localhost'` = direct.

### 4.5 Retries and back-off

A status in `retryStatuses` (or a network error when `retryOnNetworkError`) is
retried up to `retries` times. Delay = backoff(`retryBackoff`, base, attempt)
capped at `retryMaxDelayMs`, with full jitter if `retryJitter`. If
`respectRetryAfter` and the response has `Retry-After` (seconds or HTTP-date):

- ≤ `maxRetryAfterMs` → wait `max(backoff, retryAfter)` (never earlier than asked);
- > `maxRetryAfterMs` → `give-up` (default): no retry, `penalize` the bucket for the
  full Retry-After, throw `HostCoolingDownError`; `cap`: wait `maxRetryAfterMs` then
  retry (pre-1690 behaviour).

Any 429/503 also calls `recordOutcome('throttled')` and `penalize(bucket, delay)` so
**the whole bucket** backs off, not only the request that got the 429. A request
that arrives while its bucket cools down longer than `maxQueueWaitMs` (when set)
fails fast with `HostCoolingDownError`.

### 4.6 Scrape context, deadline abort

`JobsService.scrapeOne` wraps `scraper.scrape()` in `runWithScrapeContext({ site,
plugin: meta.crawl, caller, signal, proxies })`. `HttpClient`/`BrowserPool` read it
per request. When the search deadline abandons a source and
`EVER_JOBS_CRAWL_ABORT_ON_DEADLINE` (default true), the scrape's `AbortController`
fires: queued requests leave the queue and in-flight requests are cancelled — no
orphan traffic after we stopped listening.

### 4.7 robots.txt (opt-in)

`robotsTxt`: `off` (default), `crawl-delay` (use `Crawl-delay` for our product
token `EverJobs` or `*` as a floor on `minIntervalMs` for that bucket), `respect`
(also refuse disallowed URLs with `RobotsDisallowedError`). Cached per origin
(LRU 5,000, TTL 6 h); missing/4xx/unreachable → allow; 5xx → allow and retry later.
The robots.txt fetch itself goes through the limiter with the configured UA.

### 4.8 Egress guard

`blockPrivateNetworks` (default true): literal private IPs / `localhost` /
`*.local` / `*.internal` / `*.svc.cluster.local` / dotless names are refused before
the request, and direct connections use shared keep-alive agents whose DNS
`lookup` refuses private answers (defeats DNS rebinding). Through a proxy only the
literal check applies. Error: `EgressBlockedError`. Closes the class of SSRF found
in fork syncs (Specs 1688/1689) for every plugin at once.

### 4.9 Other fixes folded in

- `createHttpClient` duck-typing no longer drops a plugin's `timeout`.
- `rateDelayMin/Max` spacing is enforced through the limiter (no burst).
- `classifyScrapeError` maps the new error codes (`rate_limited`, `blocked`,
  `bad_input`) so diagnostics say *why*.
- `CircuitBreakerService` `MAX_SITES` 250 → configurable (`EVER_JOBS_CIRCUIT_MAX_SITES`,
  default 4096) so all ~1,850 sources can trip.
- MCP search posts camelCase keys the API accepts (it posted snake_case, which the
  validation whitelist stripped, turning MCP searches into whole-catalogue fan-outs).

## 5. Contracts

### 5.1 Environment

| Variable | Values (default) |
|---|---|
| `EVER_JOBS_CRAWL_PRESET` | `polite` \| `legacy` \| `strict` (`polite`) |
| `EVER_JOBS_CRAWL_USER_AGENT` | string or `default`/`browser` (`default`) |
| `EVER_JOBS_CRAWL_USER_AGENT_MODE` | `identify` \| `strict` \| `plugin` (`identify`) |
| `EVER_JOBS_CRAWL_CONTACT` | text inserted into the default UA comment (unset) |
| `EVER_JOBS_CRAWL_FROM` | `From:` header (unset) |
| `EVER_JOBS_CRAWL_STRIP_CLIENT_HINTS` | bool (`true`) |
| `EVER_JOBS_CRAWL_PROXY_ROTATION` | `per-request` \| `per-scrape` \| `per-host` \| `off` (`per-host`) |
| `EVER_JOBS_CRAWL_PROXIES` | comma list (falls back to `DEFAULT_PROXIES`) |
| `EVER_JOBS_CRAWL_RATE_SCOPE` | `host` \| `domain` \| `site` (`host`) |
| `EVER_JOBS_CRAWL_MAX_CONCURRENT_PER_HOST` | int, 0 = unlimited (`4`) |
| `EVER_JOBS_CRAWL_MIN_INTERVAL_MS` | int (`100`) |
| `EVER_JOBS_CRAWL_JITTER_MS` | int (`0`) |
| `EVER_JOBS_CRAWL_MAX_QUEUE_WAIT_MS` | int, 0 = no limit (`0`) |
| `EVER_JOBS_CRAWL_ADAPTIVE` | bool (`true`) |
| `EVER_JOBS_CRAWL_RETRIES` | int (`2`) |
| `EVER_JOBS_CRAWL_RETRY_STATUSES` | comma list (`429,502,503,504`) |
| `EVER_JOBS_CRAWL_RETRY_BACKOFF` | `exponential` \| `linear` \| `constant` (`exponential`) |
| `EVER_JOBS_CRAWL_RETRY_BASE_DELAY_MS` / `_MAX_DELAY_MS` | int (`1000` / `30000`) |
| `EVER_JOBS_CRAWL_RETRY_JITTER` | bool (`true`) |
| `EVER_JOBS_CRAWL_RETRY_ON_NETWORK_ERROR` | bool (`false`) |
| `EVER_JOBS_CRAWL_RESPECT_RETRY_AFTER` | bool (`true`) |
| `EVER_JOBS_CRAWL_MAX_RETRY_AFTER_MS` | int (`60000`) |
| `EVER_JOBS_CRAWL_RETRY_AFTER_OVER_MAX` | `give-up` \| `cap` (`give-up`) |
| `EVER_JOBS_CRAWL_ROBOTS_TXT` | `off` \| `crawl-delay` \| `respect` (`off`) |
| `EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS` | bool (`true`) |
| `EVER_JOBS_CRAWL_DISCOVERY` | `auto` \| `sitemap` \| `listing` (`auto`) |
| `EVER_JOBS_CRAWL_POLICIES` | JSON `{ "sites": {…}, "hosts": {…} }` |
| `EVER_JOBS_CRAWL_POLICY_FILE` | path to a JSON file of the same shape (env JSON wins per key) |
| `EVER_JOBS_CRAWL_CALLER_OVERRIDES` | `any` \| `stricter` \| `none` (`any`) |
| `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE` | bool (`true`) |
| `EVER_JOBS_CIRCUIT_MAX_SITES` | int (`4096`) |

Booleans accept `true/false/1/0/yes/no/on/off`. Invalid values are ignored with a
startup warning, never a crash.

### 5.2 Request (`ScraperInputDto.crawl`, GraphQL `SearchJobsInput.crawl`, MCP `crawl`, CLI flags)

`crawl?: CrawlPolicyDto` — every `CrawlPolicy` field optional, validated with
class-validator (enums, `@Min(0)`, arrays of ints). CLI: `--crawl <json>`,
`--user-agent-mode`, `--proxy-rotation`, `--max-per-host`, `--min-interval-ms`,
`--crawl-retries`, `--robots-txt`, `--discovery`, `--crawl-preset`-style flags.

### 5.3 Plugin manifest

`IPluginMetadata.crawl?: PluginCrawlPolicy` — e.g. Softy:
`{ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 }`.

### 5.4 API

`GET /api/sources/:site/crawl-policy?host=<host>` → `ResolvedCrawlPolicy` with
provenance (read-only; same auth as other `/api/sources` reads).

### 5.5 Errors

`CrawlQueueTimeoutError`, `HostCoolingDownError`, `RobotsDisallowedError`,
`EgressBlockedError` (`errors.ts`), each with a stable `code`.

## 6. Test Plan

- Unit: env parsing (every var, invalid values), layer precedence + provenance,
  caller `stricter`/`none`, host patterns; limiter (concurrency, spacing under a
  100-wide burst, jitter bounds, cool-down, adaptive up/down, abort, max wait, LRU
  eviction) with fake clocks; proxy selection per mode; robots parsing/caching;
  egress guard (IPv4/IPv6/mapped/decimal forms, DNS lookup); sitemap parsing.
- `HttpClient`: wire UA per mode incl. `setHeaders` and per-request headers;
  client-hint stripping; `From`; retries (statuses, backoff, jitter bounds,
  Retry-After both formats, over-max give-up vs cap, bucket penalized); abort;
  `timeout` survives the DTO branch; legacy preset reproduces pre-1690 wire
  behaviour; a 100-request `Promise.allSettled` fan-out never exceeds the bucket's
  concurrency and respects the interval.
- `JobsService`: context carries site/plugin/caller policy; filled DTO retry values
  do not become caller overrides; deadline aborts outstanding requests.
- Softy (Spec 1691): see that spec.

## 7. Decisions

- D1 Default identity is honest (`identify`); legacy is a preset, not deleted.
- D2 Defaults sized to keep a default search inside its 120 s deadline (bulk ATS
  APIs get builtin host limits).
- D3 Default rotation `per-host`: each site sees one stable origin.
- D4 `Retry-After` beyond 60 s → give up and cool the bucket, never retry early.
- D5 robots.txt is opt-in (fetching it for ~1,800 hosts per search is itself load,
  and `Crawl-delay` values would push sources past the deadline).
- D6 Egress guard on by default; `EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS=false` for
  local mock servers.

## 8. References

- Softy CTO e-mail, 2026-09-24 (summarised in §1).
- `docs/CRAWL_POLICY.md` — operator guide.
