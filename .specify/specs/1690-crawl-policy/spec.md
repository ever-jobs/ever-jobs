# Spec: 1690 — Crawl policy: honest identity, per-host pacing, configurable proxies and back-off

| Field | Value |
|---|---|
| Spec ID | 1690 |
| Slug | crawl-policy |
| Status | Implemented |
| Owner | agent |
| Created | 2026-09-24 |
| Last updated | 2026-09-25 |
| Supersedes | — |
| Related specs | 374 (source-ats-softy), 5085 (retry attribution + Retry-After), 5026 (fan-out bounds), 5093 (cookie jar), 1678 (BrowserPool identity), 005 (circuit breaker), 1691 (Softy sitemap discovery), 1688 (Recruitee public board host; the egress guard is Q-092 option B) |
| Plan / tasks | [plan.md](./plan.md) · [tasks.md](./tasks.md) |
| Operator guide | [docs/CRAWL_POLICY.md](../../../docs/CRAWL_POLICY.md) |
| ADR | [docs/adr/0001-crawl-policy.md](../../../docs/adr/0001-crawl-policy.md) |

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

**Back-off floor for throttling answers** (`throttleRetryDelayMs`; polite `5000`,
strict `30000`, legacy `0`). For a **429 or 503** the backoff above is never less than
`throttleRetryDelayMs × 2^attempt`, capped at `max(retryMaxDelayMs,
throttleRetryDelayMs)`: without a usable Retry-After the wait is `max(floor, backoff)`,
with one ≤ `maxRetryAfterMs` it is `max(floor, backoff, retryAfter)`; over
`maxRetryAfterMs` `give-up` is unchanged and `cap` waits `max(floor, backoff,
maxRetryAfterMs)`. Other retryable outcomes (502, 504, network errors) keep the plain
backoff; `0` disables the floor. Without it a jittered first backoff is 0–1 s, i.e. a
429 without Retry-After was retried *faster* instead of backing off (an operator
complaint; a live check saw LinkedIn retried 1.03 s after a 429).

Any 429/503 also calls `recordOutcome('throttled')` and `penalize(bucket, delay)` so
**the whole bucket** backs off, not only the request that got the 429 — for at least
the floor. A request
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
| `EVER_JOBS_CRAWL_THROTTLE_RETRY_DELAY_MS` | int, 0 = no floor (`5000`; `30000` under `strict`, `0` under `legacy`) — §4.5 back-off floor for 429/503 |
| `EVER_JOBS_CRAWL_ROBOTS_TXT` | `off` \| `crawl-delay` \| `respect` (`off`) |
| `EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS` | bool (`true`) |
| `EVER_JOBS_CRAWL_DISCOVERY` | `auto` \| `sitemap` \| `listing` (`auto`) |
| `EVER_JOBS_CRAWL_POLICIES` | JSON `{ "sites": {…}, "hosts": {…} }` |
| `EVER_JOBS_CRAWL_POLICY_FILE` | path to a JSON file of the same shape (env JSON wins per key) |
| `EVER_JOBS_CRAWL_CALLER_OVERRIDES` | `any` \| `stricter` \| `none` (`any`) |
| `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE` | bool (`true`) |
| `EVER_JOBS_CIRCUIT_MAX_SITES` | int (`4096`) |

Added during implementation (see §9.2 — each defaults to the documented behaviour,
so none of them changes the defaults above):

| Variable | Values (default) |
|---|---|
| `EVER_JOBS_CRAWL_BUILTIN_HOSTS` | bool (`true`; `false` under `legacy`) — apply layer 3 |
| `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS` | bool (`true`; `false` under `legacy`) — apply `@SourcePlugin({ crawl })` |
| `EVER_JOBS_CRAWL_CALLER_PROXIES` | `any` \| `none` (`any` when caller overrides are `any`, else `none`) |
| `EVER_JOBS_CRAWL_DEFAULT_PROXIES_FALLBACK` | bool (`true`; `false` under `legacy`) — use `DEFAULT_PROXIES` when `EVER_JOBS_CRAWL_PROXIES` is unset |
| `EVER_JOBS_CRAWL_MAX_BUCKETS` | int (`10000`) — soft LRU cap of the host limiter |
| `EVER_JOBS_CRAWL_MAX_COOLDOWN_MS` | int (`3600000`) — ceiling on any bucket cool-down (Retry-After, Crawl-delay) |
| `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS` | comma list of hosts / `*.suffix` / IP literals exempt from the egress guard (unset) |
| `EVER_JOBS_CRAWL_ROBOTS_MAX_ORIGINS` | int (`5000`) |
| `EVER_JOBS_CRAWL_ROBOTS_TTL_MS` | int (`21600000` = 6 h) |
| `EVER_JOBS_CRAWL_ROBOTS_ERROR_TTL_MS` | int (`300000` = 5 min) — lifetime of an unreachable result |
| `EVER_JOBS_CRAWL_ROBOTS_MAX_BYTES` | int (`524288`) — bytes of robots.txt parsed |
| `EVER_JOBS_CRAWL_ROBOTS_UNREACHABLE` | `allow` \| `disallow` (`allow`) |
| `EVER_JOBS_CRAWL_ROBOTS_MAX_RULES_PER_GROUP` | int (`2000`) |
| `EVER_JOBS_CRAWL_ROBOTS_MAX_PATTERN_CHARS` | int (`512`) |
| `EVER_JOBS_CRAWL_ROBOTS_MAX_MATCH_COST` | int (`5000000`) |
| `EVER_JOBS_LIVENESS_DEADLINE_MS` | int, 0 = none (`60000`) — bound on one liveness-enrichment batch |
| `RETRY_DEFAULT_RETRIES` / `_DELAY_MS` / `_BACKOFF` | pre-1690, still honoured: env-global layer, only when set and the `EVER_JOBS_CRAWL_*` twin is not |
| `RETRY_PER_SOURCE` | pre-1690 JSON, still honoured: operator-site layer, below the policy file and `EVER_JOBS_CRAWL_POLICIES` |

Booleans accept `true/false/1/0/yes/no/on/off`. Invalid values are ignored with a
startup warning, never a crash.

### 5.2 Request (`ScraperInputDto.crawl`, GraphQL `SearchJobsInput.crawl`, MCP `crawl`, CLI flags)

`crawl?: CrawlPolicyDto` — every `CrawlPolicy` field optional, validated with
class-validator (enums, `@Min(0)`, arrays of ints). CLI: `--crawl <json>`,
`--user-agent-mode`, `--proxy-rotation`, `--max-per-host`, `--min-interval-ms`,
`--crawl-retries`, `--robots-txt`, `--discovery`, `--crawl-preset`-style flags.

As built: the `--crawl-preset`-style flags are `--crawl-preset <polite|legacy|strict>`
and `--caller-overrides <any|stricter|none>`; both set the matching
`EVER_JOBS_CRAWL_*` variable for that CLI process (the preset is process-wide, so it
cannot be a per-request field). Convenience flags win over the same field in
`--crawl`; invalid values are warned about and skipped. GraphQL exposes the object as
input type `CrawlPolicyInput` (enum-like fields are `String`s, because `per-request`,
`give-up` and `crawl-delay` are not valid GraphQL enum names). MCP `search_jobs`
accepts `crawl` as an object or a JSON-object string.

### 5.3 Plugin manifest

`IPluginMetadata.crawl?: PluginCrawlPolicy` — e.g. Softy:
`{ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 }`.

### 5.4 API

`GET /api/sources/:site/crawl-policy?host=<host>` → `ResolvedCrawlPolicy` with
provenance (read-only; same auth as other `/api/sources` reads).

As built: an optional `crawl=<json>` query previews a caller override (refused fields
listed in `meta.caller.rejected`). The response is the resolved policy at the top
level plus `site`, `host`, `provenance`, `userAgentReason` (when a plugin opt-in is in
effect), `meta` (`preset`, `callerOverrides`, `abortOnDeadline`, `envProxyCount` —
a count, never the list — `plugin`, `builtinHost`, `operatorSite`,
`operatorHostPatterns`) and `warnings` (env parse warnings + resolution notes,
`user:password@` redacted). 404 for a site that is neither a `Site`, a registered
plugin nor a crawl pseudo-site (`liveness-http`, or a `sites` key of the operator
policy); 400 for an unparseable `host` or `crawl`.

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
- `docs/CRAWL_POLICY.md` — operator guide: [docs/CRAWL_POLICY.md](../../../docs/CRAWL_POLICY.md).
- [plan.md](./plan.md), [tasks.md](./tasks.md); ADR
  [0001 — crawl policy](../../../docs/adr/0001-crawl-policy.md) (constitution amendments).
- Open questions: Q-097 (default UA mode and plugin opt-ins), Q-098 (default pacing
  numbers) in [docs/questions.md](../../../docs/questions.md).
- RFC 9309 (robots.txt), RFC 9110 §10.1.2 (`From`), §10.2.3 (`Retry-After`).

## 9. As built (2026-09-25)

Implemented in six lanes on top of the contract commit (`19384068`): B1 policy core
(`env.ts`, `resolve.ts`, `scrape-context.ts`, new `policy-schema.ts`), B2 mechanisms
(`host-limiter.ts`, `proxy-selector.ts`, `robots.ts`, `egress-guard.ts`), B3
`HttpClient` integration, B4 entry points (REST, GraphQL, MCP, CLI, liveness, the
policy endpoint, circuit breaker), B5 Spec 1691 (Softy + sitemap toolkit), B6
`BrowserPool` identity and the USAJobs/HeadHunter UA opt-ins. §1–§8 above are the
design as agreed; this section records every place the build went further or
differently, and why. Where the design was silent the most flexible option was taken
(owner rule) and is noted.

### 9.1 Where the build differs from §4

- **A plugin-layer `userAgent` is never the configured UA** (§4.2 sharpened). A
  `userAgent` option, a client `crawl.userAgent` or a manifest `userAgent` is always a
  *declared* UA, sent only when the resolved mode lets the plugin choose. Mapping it
  into the configured UA would have let any plugin put its own UA on the wire under
  `identify` and even `strict`.
- **A plugin cannot relax `strict`.** When the layers below the plugin pin
  `userAgentMode: 'strict'`, a plugin's `identify`/`plugin` request is dropped with a
  resolution note (strict means "no exceptions").
- **`legacy` reproduces pre-1690 wire behaviour through a dedicated precedence**, not
  through `strict` alone: the request's own UA header, else the `userAgent` option,
  else the configured Chrome/120 UA; `setHeaders()` UAs never reach the wire — exactly
  what the pre-1690 client did. Under `legacy` the builtin-host layer, plugin
  manifests and the `DEFAULT_PROXIES` fallback are also off (pre-1690 had none of
  them), and `maxRetryAfterMs` follows `retryMaxDelayMs` unless a layer sets it (the
  single pre-1690 ceiling), so the `cap` arithmetic equals the old
  `min(retryMaxDelay, max(backoff, Retry-After))`.
- **Caller layer is not pre-filtered in the scrape context** (§4.6 said "already
  filtered"). At scrape time there is no host, so filtering against a host-less base
  would wrongly drop, e.g., `maxConcurrentPerHost: 8` aimed at Greenhouse (builtin 16).
  `resolveCrawlPolicy` filters it per request against that host's own base.
- **`blockPrivateNetworks` is a security field**: a caller may turn it on under every
  `EVER_JOBS_CRAWL_CALLER_OVERRIDES` mode but may never turn it off, not even under
  `any`. Operators disable it with env or operator policy.
- **`stricter` comparators** are defined per field (table in `filterCallerOverride`,
  mirrored in the operator guide): e.g. `maxConcurrentPerHost` lower (0 = unlimited
  = least strict), intervals higher, `retries` lower, `retryStatuses` a subset,
  identity changes never "stricter", `maxQueueWaitMs`/`discovery` always accepted.
  Unknown mode → treated as `stricter` (fail safe).
- **A caller `userAgent` without `userAgentMode` implies `strict`** in the resolver
  as well as in the legacy DTO mapping, so every entry point behaves the same.
- **Operator host patterns stack.** Every matching pattern applies, least specific
  first (`*` < shorter `*.suffix` < longer `*.suffix` < exact host), so the most
  specific wins field by field; `*` (every host) is accepted in addition to exact and
  `*.suffix`. Policy-file keys starting with `$`, `_` or `//` are comments; a UTF-8 BOM
  is tolerated. Merge order per field: `RETRY_PER_SOURCE` < policy file <
  `EVER_JOBS_CRAWL_POLICIES`.
- **Whole-bucket back-off only for paced buckets.** A 429/503 penalises the bucket
  when it is paced at all (a concurrency cap, an interval, the adaptive throttle or a
  `throttleRetryDelayMs` floor); the completely unpaced `legacy` preset never did, and
  still does not. A `give-up` Retry-After always cools the bucket. A 429/503 the caller
  accepted through `validateStatus` still counts as throttling (it is just not
  retried) and cools the bucket for at least the floor.
- **Cool-downs are bounded**: any `penalize` is capped at `maxCooldownMs` (1 h,
  `EVER_JOBS_CRAWL_MAX_COOLDOWN_MS`) so one hostile `Retry-After` cannot wedge a shared
  bucket for the life of the process; longer timers are armed in chunks (Node's
  `setTimeout` turns anything above 2^31−1 ms into 1 ms). With `maxQueueWaitMs: 0` a
  request still fails fast with `HostCoolingDownError` when the cool-down exceeds
  `maxRetryAfterMs` — it never waits longer for a cool-down than it would wait for the
  server itself.
- **`domain` scope uses the ICANN section of the Public Suffix List only**, so every
  tenant of a hosting platform shares the platform's budget (the point of `domain`);
  `bucketKeyFor(..., { allowPrivateDomains: true })` is available to code that wants
  the private section too.
- **Crawl-delay** (robots `crawl-delay`/`respect`) raises the bucket's
  `minIntervalMs` for that request, capped at the limiter's `maxCooldownMs`. robots.txt
  downloads are capped at 2 MiB and parsed up to 512 KiB (Google's limit); rule
  count, pattern length and matcher cost are bounded (hostile-input hardening); an
  over-budget file falls back to the `unreachable` policy for that URL.
- **Unreachable robots.txt** (5xx, 429, network) → `allow` for 5 minutes, then
  retried; `EVER_JOBS_CRAWL_ROBOTS_UNREACHABLE=disallow` selects the RFC 9309 §2.3.1.4
  reading (complete disallow; matters only in `respect`).
- **Egress guard** blocks more name suffixes than §4.8 listed (`svc`, `localdomain`,
  `home.arpa`), checks every redirect target, and egress-checks any proxy that is not
  one of the operator's env proxies (a caller-supplied proxy is itself checked,
  literally and through a guarded DNS lookup). Requests routed by `HTTP(S)_PROXY`
  keep axios' own agents (a `NO_PROXY`-exempt URL goes direct and is guarded). An
  allow-list exists for local mocks while the guard stays on
  (`EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS`, `HttpClientOptions.egressAllowHosts`).
- **Calls straight through `getAxiosInstance()`** get the identity and the egress
  check from the interceptor but are not paced or retried (they bypass `request()`).
- **Circuit breaker: deadline aborts are neutral.** The brief said "breaker behaviour
  unchanged", but without this a source that starts late in a wide search is aborted
  at the deadline and five of those in a row would open its breaker. A failure after
  our own abort now counts as neither failure nor success, and a half-open probe slot
  is handed back. `EVER_JOBS_CIRCUIT_MAX_SITES=0` means no cap; `250` restores the
  pre-1690 bound.
- **Liveness enrichment** runs in a scrape context under the pseudo-site
  `liveness-http` (tunable through `sites["liveness-http"]`), deliberately without the
  search caller's `crawl` (a caller's `retries` would override the checker's own
  `retries: 0`), and is bounded by `EVER_JOBS_LIVENESS_DEADLINE_MS` (60 s): probes
  queued behind a paced or cooling-down host are aborted and reported `uncertain`.
- **Caller proxies** reach every plugin client through the scrape context unless
  `EVER_JOBS_CRAWL_CALLER_PROXIES=none` (the default whenever caller overrides are not
  `any`); refused proxies reach neither the context nor the DTO.
- **Env parse is cached once per process** (reading ~40 variables per request cost
  ~0.1 ms on Windows); changing the environment needs a restart
  (`resetCrawlPolicyEnvCache()` in tests). Resolved policies are memoised per
  (env parse, plugin manifest, caller override, site, host, explicit options), LRU
  8,192 per leaf; resolution notes are logged once at debug level.

### 9.2 Additions beyond §4–§5

- The environment variables listed under §5.1 "Added during implementation".
- **`throttleRetryDelayMs`** (the 25th field; env `EVER_JOBS_CRAWL_THROTTLE_RETRY_DELAY_MS`;
  polite `5000`, strict `30000`, legacy `0`), added after an operator complaint that
  a 429 was answered by retrying immediately: the §4.5 back-off floor for 429/503 and
  minimum whole-bucket cool-down. Wired like every other field — env, operator and
  plugin layers, `CrawlPolicyDto`, GraphQL `CrawlPolicyInput`, MCP `crawl`,
  `tool_manifest.json` — and under `stricter` a caller may only raise it (0 = no
  floor = least strict). `retryDecision(policy, attempt, retryAfterMs, random,
  status)` takes the answer's status; `throttleRetryFloorMs()` is exported with it.
- `EVER_JOBS_CRAWL_PROXIES` also accepts a JSON array; `none`/`off`/`direct` = no
  proxies and no fallback to `DEFAULT_PROXIES`.
- Value coercion: integers ≥ 0 (fractions floored, values above 2^31−1 clamped);
  case-insensitive enums with `_` accepted for `-`; status lists `"429,503"` or
  `[429,503]`, 100–599, `none` = empty; header-unsafe characters stripped from
  `userAgent`/`from`; the contact loses parentheses (they would unbalance the UA
  comment) and is inserted wherever any layer sets the `default` keyword.
- `HttpClientOptions`: `crawl` (plugin layer, wins over the pre-1690 flat options),
  `site`, `egressAllowHosts`, `hostLimiter`, `robotsTxtCache`;
  `CrawlRequestConfig.crawl` for a per-request override; `crawlPolicyFor(url)` for
  diagnostics; helpers `selectWireUserAgent`, `retryBackoffMs`, `retryDecision`,
  `parseRetryAfter`, `isRetryableNetworkError`, `clientOptionsFromScraperInput`.
- `explainCrawlPolicy()` (policy + preset, caller rejections, builtin host, operator
  site and host patterns, notes) behind the policy endpoint.
- `ScrapeReason` gains `rate_limited` (actionable); crawl error codes map by `code`,
  not message: queue timeout / cooling down → `rate_limited`, robots → `blocked`,
  egress → `bad_input`.
- `RequestContext.requestId` is optional and `runWithRequestContext` exists, so a
  scrape context works outside any HTTP request (CLI).
- `BrowserPool`: `BrowserPageOptions.userAgent` / `host` / `crawl`;
  `resolveBrowserUserAgent()`. In mode `plugin` with no declared UA the pre-1690
  random pool UA stands in (so `EVER_JOBS_CRAWL_USER_AGENT_MODE=plugin` reproduces the
  old pages), and the `legacy` preset reproduces pre-1690 pages byte for byte.
- A compile-time check (`apps/api/src/jobs/crawl-policy.mapping.ts`) fails the build
  if `CrawlPolicyDto` and `CrawlPolicy` drift apart in either direction; the MCP
  schema is kept in step by a test.
- Merge with Specs 1692-1713 (2026-09-26): `HttpClientOptions.minIntervalFloorMs`
  (milliseconds) — a spacing floor per client that no layer shortens, applied like a
  robots.txt `Crawl-delay` (limiter `minIntervalMs` = max(policy, Crawl-delay, floor)).
  `rateDelayMin` stays the plugin layer; the floor is for plugins whose spec promises a
  pace a caller may only lengthen (RemoteOK, Welcome to the Jungle, Simplify). A request
  parked on an identical in-flight one in a Spec 1700 memo scope now honours its own
  abort signal (§4.6) instead of waiting for the first request.

### 9.3 Plugin UA opt-ins (`userAgentMode: 'plugin'`)

| Plugin | Reason (manifest `userAgentReason`) |
|---|---|
| `source-usajobs` | The Search API requires the UA to be the e-mail registered with the API key. |
| `source-headhunter` | hh.ru requires an application-identifying UA (`AppName/Version`) and answers a missing or blacklisted one with `400 bad_user_agent`. |
| `source-simplyhired` | Evidence-based (Q-097 option B): simplyhired.com answers HTTP 403 to search and detail pages with the Ever Jobs UA; live A/B 2026-09-25 — 22/22 requests 200 with the declared browser UA. |

No site was opted in on A/B evidence alone yet; the live A/B (30 plugins, 166
requests) and the candidates it found are recorded in Q-097.

Conditional opt-ins (merge with Specs 1705/1707, 2026-09-26): `source-ats-wttj` and
`source-remoteok` opt their clients in only while the operator's own switch asks for
the old browser UA (`WTTJ_USER_AGENT_MODE=browser`, `EVER_JOBS_REMOTEOK_LEGACY=ua`), with
that switch as the `userAgentReason`; by default both send the configured UA, and
`strict` overrides the switch.

### 9.4 Verification (2026-09-25)

- `tsc --noEmit -p apps/api/tsconfig.build.json` and `-p tsconfig.base.json` (every
  `.ts` in the repo): 0 errors.
- Jest, real config: 55/55 suites, 1,769/1,769 tests (all new crawl suites plus
  `softy.service`, `usajobs.crawl`, `headhunter.crawl`); integration, CLI, MCP,
  `softy.parser`, `softy.policy` and `corpus-signals` 6/6 suites, 88/88;
  `browser-pool.spec.ts` 71/71; `npm run test:scripts` 12/12 suites, 193/193.
  Full plugin sweep (fast config): 1,596/1,596 suites, 15,862/15,862 tests.
- Mutation check (B3): breaking the interceptor, limiter acquire, egress check,
  legacy UA precedence, the DTO-in-context rule and whole-bucket penalize each turned
  specific tests red.
- Default-search simulation (offline, 200 ms mocked latency, real timers): 800
  requests to `api.greenhouse.io` plus a 100-wide fan-out to one ordinary host
  finished in 11.3 s against the 120 s deadline, 0 failures; Greenhouse ≤ 16 in
  flight, the ordinary host ≤ 3. Limiter grants were always ≥ 100 ms apart; the first
  gap between wire starts of a burst measured 86–90 ms (the limiter spaces grants,
  not wire starts — only the first pair of a burst is affected).
- Softy live wire proof: see Spec 1691 §6.

