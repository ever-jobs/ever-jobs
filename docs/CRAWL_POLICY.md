# Crawl Policy — Operator Guide

> How Ever Jobs identifies itself, paces its requests, uses proxies, backs off, and
> which of it you can change — globally, per site, per host, per plugin and per search.
> Design: [Spec 1690](../.specify/specs/1690-crawl-policy/spec.md) (crawl policy) and
> [Spec 1691](../.specify/specs/1691-softy-sitemap-discovery/spec.md) (Softy sitemap
> discovery). Decision record: [ADR 0001](./adr/0001-crawl-policy.md).

## Contents

1. [Why this exists](#1-why-this-exists)
2. [Defaults at a glance](#2-defaults-at-a-glance)
3. [Presets](#3-presets)
4. [Layers and precedence](#4-layers-and-precedence)
5. [Environment variables](#5-environment-variables)
6. [Per-site and per-host policies (operators)](#6-per-site-and-per-host-policies-operators)
7. [Per-request `crawl` (callers)](#7-per-request-crawl-callers)
8. [Identity: User-Agent, contact, `From`](#8-identity-user-agent-contact-from)
9. [Pacing](#9-pacing)
10. [Proxies](#10-proxies)
11. [Retries and `Retry-After`](#11-retries-and-retry-after)
12. [robots.txt](#12-robotstxt)
13. [Egress guard](#13-egress-guard)
14. [Discovery modes](#14-discovery-modes)
15. [Search deadline, circuit breaker, liveness](#15-search-deadline-circuit-breaker-liveness)
16. [Reproducing the pre-1690 behaviour](#16-reproducing-the-pre-1690-behaviour)
17. [Inspecting the effective policy: `GET /api/sources/:site/crawl-policy`](#17-inspecting-the-effective-policy)
18. [Troubleshooting](#18-troubleshooting)
19. [For plugin authors](#19-for-plugin-authors)

---

## 1. Why this exists

In September 2026 the operator of a hosted careers-site platform (the Softy ATS, which
serves each customer's board on `<tenant>.softy.pro`) told us that our crawler was
impolite toward their servers:

- after reading a job list it fired up to 100 detail-page requests at once, with no delay;
- it rotated proxies on every request, so each request came from a different IP, which
  looks like an attempt to evade rate limits;
- it claimed to be a desktop Chrome browser, so they could not tell who was calling or
  whom to contact;
- when their server answered `429 Too Many Requests` or a `5xx`, we retried instead of
  backing off.

They asked for an honest User-Agent that names the project, one request at a time per
site at about one per second, a stable and identifiable origin, respect for `429` and
`Retry-After`, and — ideally — discovery through `/sitemap.xml` instead of list pages.

The audit that followed found the problems were not Softy-specific. The shared
`HttpClient` pinned a browser User-Agent that silently overrode every UA a plugin
declared (266 plugins), nothing bounded how many requests the ~1,850 plugins sent to
one host at once, rotation was per request, and a long `Retry-After` was cut to 30 s.
Spec 1690 fixes this once, in the shared HTTP layer, for every plugin; Spec 1691
reworks the Softy plugin itself.

Two principles shaped the result:

- **Polite by default.** Out of the box Ever Jobs names itself, paces requests per host,
  keeps one stable origin per site, and never retries earlier than a server asks.
- **Everything configurable, nothing removed.** Every knob can be set by a preset, an
  environment variable, a plugin's manifest, an operator's per-site or per-host policy,
  and — unless the operator forbids it — the search request. The exact pre-1690
  behaviour is one setting away: `EVER_JOBS_CRAWL_PRESET=legacy`.

---

## 2. Defaults at a glance

With no configuration at all (preset `polite`):

| Topic | Default |
|---|---|
| User-Agent | `Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)` on every request, except plugins that opt in with a stated reason (USAJobs and HeadHunter: their API requires its own UA; SimplyHired: 403s our UA, live A/B 2026-09-25) |
| Client hints | `sec-ch-ua*` headers removed whenever our own UA is sent |
| Pacing | per exact hostname: at most **4** requests in flight, at least **100 ms** between request starts; adaptive slow-down after `429`/`503` |
| Bulk ATS APIs | `api.greenhouse.io` / `boards-api.greenhouse.io` 16 in flight, `api.lever.co` / `api.ashbyhq.com` / `api.smartrecruiters.com` 12, no gap |
| Softy (plugin manifest) | one bucket for all of `softy.pro`, **1** in flight, **1 s** between requests |
| Proxies | none, unless configured; when a list is configured, one stable proxy per host bucket (`per-host`) |
| Retries | 2, on `429, 502, 503, 504`, exponential back-off from 1 s (cap 30 s) with full jitter |
| `Retry-After` | honoured; never retried earlier than asked; over **60 s** → give up and cool the whole bucket for the full period |
| robots.txt | not fetched (`off`) |
| Private networks | refused (loopback, RFC 1918, link-local, CGNAT, cluster names…) |
| Discovery (Softy) | `auto`: sitemap first, list pages as fallback |
| Search deadline | abandoned sources have their queued and in-flight requests cancelled |

These defaults were sized so a default search still finishes inside its 120 s deadline:
an offline simulation of 800 Greenhouse requests plus a 100-wide fan-out to one ordinary
host (200 ms latency) finished in 11.3 s. See [Q-098](./questions.md) for the numbers and
[Q-097](./questions.md) for the identity default.

---

## 3. Presets

`EVER_JOBS_CRAWL_PRESET` selects the bottom layer. Every field can still be overridden
above it.

| Field | `polite` (default) | `legacy` (pre-1690) | `strict` |
|---|---|---|---|
| `userAgent` | Ever Jobs UA | Chrome/120 desktop UA | Ever Jobs UA |
| `userAgentMode` | `identify` | `strict` (+ pre-1690 precedence, §16) | `strict` |
| `stripClientHints` | `true` | `false` | `true` |
| `proxyRotation` | `per-host` | `per-request` | `per-host` |
| `rateLimitScope` | `host` | `host` | `domain` |
| `maxConcurrentPerHost` | `4` | `0` (unlimited) | `1` |
| `minIntervalMs` | `100` | `0` | `1000` |
| `jitterMs` | `0` | `0` | `250` |
| `maxQueueWaitMs` | `0` (no limit) | `0` | `0` |
| `adaptiveThrottle` | `true` | `false` | `true` |
| `retries` | `2` | `3` | `1` |
| `retryStatuses` | `429,502,503,504` | `429,500,502,503,504` | `429,503` |
| `retryBackoff` | `exponential` | `linear` | `exponential` |
| `retryBaseDelayMs` / `retryMaxDelayMs` | `1000` / `30000` | `1000` / `30000` | `1000` / `30000` |
| `retryJitter` | `true` | `false` | `true` |
| `retryOnNetworkError` | `false` | `false` | `false` |
| `respectRetryAfter` | `true` | `true` | `true` |
| `maxRetryAfterMs` | `60000` | `30000` (follows `retryMaxDelayMs`) | `60000` |
| `retryAfterOverMax` | `give-up` | `cap` | `give-up` |
| `robotsTxt` | `off` | `off` | `respect` |
| `blockPrivateNetworks` | `true` | `false` | `true` |
| `discovery` | `auto` | `auto` | `auto` |
| builtin bulk-host limits | on | **off** | on |
| plugin manifests (`@SourcePlugin({ crawl })`) | on | **off** | on |
| `DEFAULT_PROXIES` as fallback list | on | **off** | on |

> **`strict` still applies the builtin bulk-host limits and plugin manifests** (layers 3
> and 4 sit above the preset). For "one request per domain per second, everywhere,
> no exceptions" also set `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`, or use an operator host
> policy for `*` (§6.3), which sits above both.

---

## 4. Layers and precedence

The policy is resolved **per request** from these layers, lowest precedence first. A
layer only overrides the fields it sets.

| # | Layer | Where it comes from |
|---|---|---|
| 1 | preset | `EVER_JOBS_CRAWL_PRESET` |
| 2 | env-global | `EVER_JOBS_CRAWL_*` variables (and the pre-1690 `RETRY_DEFAULT_*`, when set) |
| 3 | builtin-host | the bulk-API limits in §2 (exact hostname match; off under `legacy` or with `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`) |
| 4 | plugin | the plugin's `@SourcePlugin({ crawl })` manifest, then the options it passes to `createHttpClient` |
| 5a | operator-site | `sites["<site>"]` of `EVER_JOBS_CRAWL_POLICIES` / `EVER_JOBS_CRAWL_POLICY_FILE` (and the pre-1690 `RETRY_PER_SOURCE`) |
| 5b | operator-host | every matching `hosts["<pattern>"]` entry, least specific first |
| 6 | caller | the search request's `crawl` object and legacy flat fields, filtered by `EVER_JOBS_CRAWL_CALLER_OVERRIDES` |

Things to remember:

- **An env-global value is below builtin hosts and plugin manifests.** Setting
  `EVER_JOBS_CRAWL_MAX_CONCURRENT_PER_HOST=1` does not lower Greenhouse (builtin 16) or
  change Softy (manifest 1/s). To force a value over everything except the caller, use
  an operator policy (§6); a `hosts["*"]` entry matches every host.
- **Operator host patterns stack**: `*` < shorter `*.suffix` < longer `*.suffix` <
  exact host; the most specific wins field by field. Site entries apply before host
  entries, so a host entry wins over a site entry.
- **The caller is filtered against the policy resolved without it**, for that host.

### Worked example

A search reads `https://acme.softy.pro/offers/123` with:

- env: `EVER_JOBS_CRAWL_MIN_INTERVAL_MS=250`, `EVER_JOBS_CRAWL_JITTER_MS=100`,
  `EVER_JOBS_CRAWL_CALLER_OVERRIDES=stricter`
- Softy's manifest: `{ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 }`
- operator: `{"hosts": {"*.softy.pro": {"minIntervalMs": 2000}}}`
- caller: `"crawl": {"maxConcurrentPerHost": 2, "minIntervalMs": 3000}`

| Field | Value | Set by (`provenance`) | Why |
|---|---|---|---|
| `userAgent` | Ever Jobs UA | `preset` | nothing overrides it |
| `rateLimitScope` | `domain` | `plugin` | manifest |
| `maxConcurrentPerHost` | `1` | `plugin` | caller's `2` is less strict than `1` → rejected under `stricter` |
| `minIntervalMs` | `3000` | `caller` | env 250 < manifest 1000 < operator 2000 < caller 3000 (higher is stricter → accepted) |
| `jitterMs` | `100` | `env-global` | nobody above sets it |
| `retries` | `2` | `preset` | |

`GET /api/sources/softy/crawl-policy?host=acme.softy.pro&crawl={"maxConcurrentPerHost":2,"minIntervalMs":3000}`
shows exactly this, with `maxConcurrentPerHost` listed in `meta.caller.rejected`.

---

## 5. Environment variables

All variables are optional. Booleans accept `true/false/1/0/yes/no/on/off`. Integers
must be ≥ 0 (fractions are rounded down; values above 2,147,483,647 are clamped).
Enums are case-insensitive and accept `_` for `-`. **An invalid value is ignored with a
warning** (logged once at startup by the `CrawlPolicy` logger, and listed under
`warnings` of the policy endpoint) — never a crash.

The `EVER_JOBS_CRAWL_*` environment is read **once per process**: restart the API (or
the CLI run) after changing it. The `SOFTY_*` variables are read per scrape.

### 5.1 Policy fields (layer 2)

| Variable | Values | Default (`polite`) |
|---|---|---|
| `EVER_JOBS_CRAWL_PRESET` | `polite` \| `legacy` \| `strict` | `polite` |
| `EVER_JOBS_CRAWL_USER_AGENT` | any string, or `default`/`everjobs` (Ever Jobs UA) / `browser`/`legacy` (pre-1690 Chrome/120 UA) | `default` |
| `EVER_JOBS_CRAWL_USER_AGENT_MODE` | `identify` \| `strict` \| `plugin` (§8) | `identify` |
| `EVER_JOBS_CRAWL_CONTACT` | text inserted into the default UA's comment (e-mail or URL) | unset |
| `EVER_JOBS_CRAWL_FROM` | value of a `From:` request header (an e-mail address) | unset |
| `EVER_JOBS_CRAWL_STRIP_CLIENT_HINTS` | bool | `true` |
| `EVER_JOBS_CRAWL_PROXY_ROTATION` | `per-request` \| `per-scrape` \| `per-host` \| `off` | `per-host` |
| `EVER_JOBS_CRAWL_PROXIES` | comma/space list or JSON array of proxy URLs; `none`/`off`/`direct` = none | unset → `DEFAULT_PROXIES` |
| `EVER_JOBS_CRAWL_RATE_SCOPE` | `host` \| `domain` \| `site` | `host` |
| `EVER_JOBS_CRAWL_MAX_CONCURRENT_PER_HOST` | int, `0` = unlimited | `4` |
| `EVER_JOBS_CRAWL_MIN_INTERVAL_MS` | int | `100` |
| `EVER_JOBS_CRAWL_JITTER_MS` | int | `0` |
| `EVER_JOBS_CRAWL_MAX_QUEUE_WAIT_MS` | int, `0` = no limit | `0` |
| `EVER_JOBS_CRAWL_ADAPTIVE` | bool | `true` |
| `EVER_JOBS_CRAWL_RETRIES` | int | `2` |
| `EVER_JOBS_CRAWL_RETRY_STATUSES` | comma list or JSON array of 100–599; `none` = no status retried | `429,502,503,504` |
| `EVER_JOBS_CRAWL_RETRY_BACKOFF` | `exponential` \| `linear` \| `constant` | `exponential` |
| `EVER_JOBS_CRAWL_RETRY_BASE_DELAY_MS` | int | `1000` |
| `EVER_JOBS_CRAWL_RETRY_MAX_DELAY_MS` | int | `30000` |
| `EVER_JOBS_CRAWL_RETRY_JITTER` | bool | `true` |
| `EVER_JOBS_CRAWL_RETRY_ON_NETWORK_ERROR` | bool (connection resets/timeouts; never `ENOTFOUND` or cancellations) | `false` |
| `EVER_JOBS_CRAWL_RESPECT_RETRY_AFTER` | bool | `true` |
| `EVER_JOBS_CRAWL_MAX_RETRY_AFTER_MS` | int | `60000` |
| `EVER_JOBS_CRAWL_RETRY_AFTER_OVER_MAX` | `give-up` \| `cap` | `give-up` |
| `EVER_JOBS_CRAWL_ROBOTS_TXT` | `off` \| `crawl-delay` \| `respect` | `off` |
| `EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS` | bool | `true` |
| `EVER_JOBS_CRAWL_DISCOVERY` | `auto` \| `sitemap` \| `listing` | `auto` |

### 5.2 Operator policy, caller rules, switches

| Variable | Values | Default |
|---|---|---|
| `EVER_JOBS_CRAWL_POLICIES` | JSON `{ "sites": {…}, "hosts": {…} }` (§6) | unset |
| `EVER_JOBS_CRAWL_POLICY_FILE` | path to a JSON file of the same shape; `EVER_JOBS_CRAWL_POLICIES` wins per field | unset |
| `EVER_JOBS_CRAWL_CALLER_OVERRIDES` | `any` \| `stricter` \| `none` (§7.2) | `any` |
| `EVER_JOBS_CRAWL_CALLER_PROXIES` | `any` \| `none` — may a search request supply `proxies`? | `any` if caller overrides are `any`, else `none` |
| `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE` | bool — cancel an abandoned source's requests | `true` |
| `EVER_JOBS_CRAWL_BUILTIN_HOSTS` | bool — apply the builtin bulk-host limits | `true` (`false` under `legacy`) |
| `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS` | bool — apply `@SourcePlugin({ crawl })` | `true` (`false` under `legacy`) |
| `EVER_JOBS_CRAWL_DEFAULT_PROXIES_FALLBACK` | bool — use `DEFAULT_PROXIES` when `EVER_JOBS_CRAWL_PROXIES` is unset | `true` (`false` under `legacy`) |

### 5.3 Mechanism tunables

| Variable | Meaning | Default |
|---|---|---|
| `EVER_JOBS_CRAWL_MAX_BUCKETS` | soft LRU cap on remembered rate-limit buckets (busy or cooling buckets are never evicted) | `10000` |
| `EVER_JOBS_CRAWL_MAX_COOLDOWN_MS` | ceiling on any bucket cool-down (`Retry-After`, `Crawl-delay`) | `3600000` (1 h) |
| `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS` | comma list of exact hosts, `*.suffix` patterns or IP literals exempt from the egress guard | unset |
| `EVER_JOBS_CRAWL_ROBOTS_MAX_ORIGINS` | robots.txt cache size (origins, LRU) | `5000` |
| `EVER_JOBS_CRAWL_ROBOTS_TTL_MS` | lifetime of a fetched or missing robots.txt | `21600000` (6 h) |
| `EVER_JOBS_CRAWL_ROBOTS_ERROR_TTL_MS` | lifetime of an unreachable (5xx/429/network) result | `300000` (5 min) |
| `EVER_JOBS_CRAWL_ROBOTS_MAX_BYTES` | bytes of robots.txt parsed | `524288` (512 KiB) |
| `EVER_JOBS_CRAWL_ROBOTS_UNREACHABLE` | `allow` \| `disallow` (RFC 9309 §2.3.1.4 reading; only matters in `respect`) | `allow` |
| `EVER_JOBS_CRAWL_ROBOTS_MAX_RULES_PER_GROUP` | Allow/Disallow rules kept per user-agent group | `2000` |
| `EVER_JOBS_CRAWL_ROBOTS_MAX_PATTERN_CHARS` | characters kept per rule pattern | `512` |
| `EVER_JOBS_CRAWL_ROBOTS_MAX_MATCH_COST` | matcher work budget per decision | `5000000` |

### 5.4 Related variables

| Variable | Meaning | Default |
|---|---|---|
| `DEFAULT_PROXIES` | pre-1690 proxy list; now the fallback when `EVER_JOBS_CRAWL_PROXIES` is unset | unset |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | still honoured by axios when no proxy list applies | unset |
| `RETRY_DEFAULT_RETRIES` / `RETRY_DEFAULT_DELAY_MS` / `RETRY_DEFAULT_BACKOFF` | pre-1690; mapped to `retries` / `retryBaseDelayMs` / `retryBackoff` in layer 2 **only when set** and the `EVER_JOBS_CRAWL_*` twin is not | unset |
| `RETRY_PER_SOURCE` | pre-1690 JSON `{ "<site>": { retries, delayMs, backoff, maxDelayMs } }`; mapped into layer 5a, below the policy file and `EVER_JOBS_CRAWL_POLICIES` | unset |
| `EVER_JOBS_SEARCH_DEADLINE_MS` | search deadline | `120000` |
| `EVER_JOBS_LIVENESS_DEADLINE_MS` | bound on one liveness-enrichment batch; `0` = none | `60000` |
| `EVER_JOBS_CIRCUIT_MAX_SITES` | sites the circuit breaker tracks; `0` = no cap; `250` = pre-1690 | `4096` |
| `SOFTY_MAX_LIST_PAGES` | listing pages per scrape (≥ 1) | `50` |
| `SOFTY_MAX_DETAIL_FETCHES` | detail pages per scrape (cache hits do not count) | `100` |
| `SOFTY_DETAIL_CACHE_MAX` | detail cache entries; `0` disables | `500` |
| `SOFTY_DETAIL_CACHE_TTL_MS` | detail cache TTL; `0` = no expiry | `21600000` (6 h) |
| `SOFTY_LASTMOD_AS_DATE_POSTED` | use the sitemap `lastmod` as `datePosted` when the page has no date | `true` |
| `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` | stop fetching details after this many consecutive failures; `0` = never | `3` |

---

## 6. Per-site and per-host policies (operators)

`EVER_JOBS_CRAWL_POLICIES` (inline JSON) and/or `EVER_JOBS_CRAWL_POLICY_FILE` (a path)
hold:

```json
{
  "sites": { "<site key>": { "<policy field>": "<value>" } },
  "hosts": { "<host pattern>": { "<policy field>": "<value>" } }
}
```

- **Site keys** are `Site` values (`softy`, `greenhouse`, …) or the pseudo-site
  `liveness-http` (§15); case-insensitive.
- **Host patterns** are an exact host (`api.lever.co`), `*.suffix` (any subdomain, not
  the apex), or `*` (every host). A trailing dot and a `:port` are ignored.
- **Values** are any `CrawlPolicy` field; same coercions as env (`"429,503"` or
  `[429,503]`, `"true"` or `true`…). Unknown fields and bad values are dropped with a
  warning. Keys starting with `$`, `_` or `//` are comments.
- Merge order per field: `RETRY_PER_SOURCE` < the file < `EVER_JOBS_CRAWL_POLICIES`.

### 6.1 Example — Softy, the way its operator asked for it (plus some margin)

```json
{
  "hosts": {
    "*.softy.pro": {
      "rateLimitScope": "domain",
      "maxConcurrentPerHost": 1,
      "minIntervalMs": 1500,
      "jitterMs": 500,
      "discovery": "sitemap",
      "retries": 1,
      "retryStatuses": [429, 503]
    }
  }
}
```

The plugin already declares domain scope, 1 in flight and 1 s; this slows it further,
forces sitemap discovery and allows a single retry. The same could be written as
`"sites": { "softy": { … } }` — a site entry follows the plugin wherever it goes, a
host entry follows the server.

### 6.2 Example — a bulk API you trust with more

```json
{
  "hosts": {
    "api.greenhouse.io": { "maxConcurrentPerHost": 24 },
    "boards-api.greenhouse.io": { "maxConcurrentPerHost": 24 },
    "*.myworkdayjobs.com": { "rateLimitScope": "domain", "maxConcurrentPerHost": 8, "minIntervalMs": 50 }
  }
}
```

Operator host entries sit above the builtin limits, so this raises Greenhouse from 16
to 24, and puts every Workday tenant into one `myworkdayjobs.com` budget.

### 6.3 Example — strict everywhere, with one exception

```bash
EVER_JOBS_CRAWL_PRESET=strict
EVER_JOBS_CRAWL_BUILTIN_HOSTS=false
EVER_JOBS_CRAWL_CALLER_OVERRIDES=stricter
EVER_JOBS_CRAWL_CONTACT=crawler-ops@example.com
EVER_JOBS_CRAWL_POLICIES='{"hosts":{"*":{"maxConcurrentPerHost":1,"minIntervalMs":1000},"data.usajobs.gov":{"minIntervalMs":250}}}'
```

`strict` gives the honest UA, domain scope, 1 in flight, 1 s + jitter and robots.txt
`respect`; turning the builtin hosts off and adding `hosts["*"]` also overrides every
plugin manifest; the exact-host entry is more specific than `*`, so it wins for that
one API. Callers may only make things stricter.

> Under the `strict` UA mode a plugin's UA opt-in is ignored, so USAJobs and HeadHunter
> will send the Ever Jobs UA and may be refused. Keep them working with
> `"sites": {"usajobs": {"userAgentMode": "plugin"}, "headhunter": {"userAgentMode": "plugin"}}`
> (operator layers may relax what the plugin layer may not).

---

## 7. Per-request `crawl` (callers)

Every search entry point accepts a `crawl` object with any subset of the policy fields.
It is the highest-precedence layer, subject to `EVER_JOBS_CRAWL_CALLER_OVERRIDES`. The
**preset is process-wide** and cannot be chosen per request.

### 7.1 Examples

**REST** — `POST /api/jobs/search` (also `/api/jobs/analyze`):

```bash
curl -X POST http://localhost:3001/api/jobs/search \
  -H 'Content-Type: application/json' \
  -d '{
    "siteType": ["softy"],
    "companySlug": "acme",
    "resultsWanted": 10,
    "crawl": { "discovery": "sitemap", "minIntervalMs": 2000, "retries": 1 }
  }'
```

**GraphQL** — `SearchJobsInput.crawl` (input type `CrawlPolicyInput`; enum-like fields
are strings):

```graphql
query {
  searchJobs(input: {
    searchTerm: "engineer"
    siteType: [GREENHOUSE]
    companySlug: "stripe"
    crawl: { maxConcurrentPerHost: 2, proxyRotation: "off", robotsTxt: "crawl-delay" }
  }) {
    count
    jobs { title jobUrl }
  }
}
```

**MCP** — `search_jobs` takes `crawl` as an object (or a JSON-object string):

```json
{
  "name": "search_jobs",
  "arguments": {
    "query": "data engineer",
    "source": "softy",
    "company": "acme",
    "crawl": { "discovery": "listing", "maxConcurrentPerHost": 1 }
  }
}
```

**CLI** — `search` and `compare` accept `--crawl <json>` plus convenience flags that
win over the same field in `--crawl`:

```bash
npm run cli -- search -s softy --company-slug acme \
  --crawl '{"retries":1,"jitterMs":500}' \
  --discovery sitemap --max-per-host 1 --min-interval-ms 2000

# Process-wide for this CLI run only:
npm run cli -- search -q engineer --crawl-preset strict --caller-overrides stricter
```

| CLI flag | Field |
|---|---|
| `--crawl <json>` | any field |
| `--user-agent-mode <identify\|strict\|plugin>` | `userAgentMode` |
| `--proxy-rotation <per-host\|per-scrape\|per-request\|off>` | `proxyRotation` |
| `--max-per-host <n>` | `maxConcurrentPerHost` |
| `--min-interval-ms <ms>` | `minIntervalMs` |
| `--crawl-retries <n>` | `retries` |
| `--robots-txt <off\|crawl-delay\|respect>` | `robotsTxt` |
| `--discovery <auto\|sitemap\|listing>` | `discovery` |
| `--crawl-preset <polite\|legacy\|strict>` | sets `EVER_JOBS_CRAWL_PRESET` for the run |
| `--caller-overrides <any\|stricter\|none>` | sets `EVER_JOBS_CRAWL_CALLER_OVERRIDES` for the run |

Invalid flag values are printed as warnings and skipped.

### 7.2 What a caller may change — `EVER_JOBS_CRAWL_CALLER_OVERRIDES`

- `any` (default) — every field, except that **`blockPrivateNetworks` can only be
  turned on** by a caller, never off (it is a security boundary; operators disable it).
- `stricter` — only values at least as polite as the policy the request would get
  without the caller:

| Field | Accepted when |
|---|---|
| `userAgent`, `from` | unchanged (an identity change is never "stricter") |
| `userAgentMode` | `strict` > `identify` > `plugin` |
| `stripClientHints`, `adaptiveThrottle`, `retryJitter`, `respectRetryAfter`, `blockPrivateNetworks` | `true` |
| `retryOnNetworkError` | `false` |
| `proxyRotation` | `off` = `per-host` > `per-scrape` > `per-request` |
| `rateLimitScope` | `domain` = `site` > `host` |
| `maxConcurrentPerHost` | lower (`0` = unlimited = least strict) |
| `minIntervalMs`, `jitterMs`, `retryBaseDelayMs`, `retryMaxDelayMs` | higher |
| `retries` | lower |
| `retryStatuses` | a subset |
| `retryBackoff` | `exponential` > `linear` > `constant` |
| `retryAfterOverMax` | `give-up` > `cap` |
| `maxRetryAfterMs` | anything under `give-up`; higher under `cap` |
| `robotsTxt` | `respect` > `crawl-delay` > `off` |
| `maxQueueWaitMs`, `discovery` | always (not politeness knobs) |

- `none` — the caller's `crawl` and legacy fields are ignored.

Refused fields are reported by the policy endpoint's `crawl=` preview (§17).
`EVER_JOBS_CRAWL_CALLER_PROXIES` separately decides whether the request's `proxies`
are used.

### 7.3 The pre-1690 flat fields

Still accepted, mapped into the caller layer **only when the caller sent them**
(defaults that `JobsService` fills in for plugins never become caller overrides). A
field in `crawl` wins over its flat equivalent.

| Flat field | Maps to |
|---|---|
| `userAgent` | `userAgent`, plus `userAgentMode: 'strict'` unless `crawl.userAgentMode` is set — your UA is what goes out |
| `rateDelayMin` (s) | `minIntervalMs = rateDelayMin × 1000` (now enforced per bucket, across concurrent requests) |
| `rateDelayMax` (s) | `jitterMs = (rateDelayMax − rateDelayMin) × 1000` |
| `retries` / `retryDelay` / `retryBackoff` / `retryMaxDelay` | `retries` / `retryBaseDelayMs` / `retryBackoff` / `retryMaxDelayMs` |
| `proxies` | the proxy list (§10), unless `EVER_JOBS_CRAWL_CALLER_PROXIES=none` |

---

## 8. Identity: User-Agent, contact, `From`

The default UA follows the crawler convention used by Googlebot and bingbot: it names
the project, links to it, and does not pretend to be a browser.

```
Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)
```

**Let site operators reach you.** `EVER_JOBS_CRAWL_CONTACT=crawler-ops@example.com`
turns it into

```
Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs; crawler-ops@example.com)
```

(parentheses are stripped from the contact; it is inserted wherever any layer uses the
`default` keyword). `EVER_JOBS_CRAWL_FROM=crawler-ops@example.com` also sends
`From: crawler-ops@example.com` (RFC 9110 §10.1.2). A custom
`EVER_JOBS_CRAWL_USER_AGENT` string is sent as-is (the contact is not inserted into it;
a startup warning says so).

**Which UA goes on the wire** — the *configured* UA (above) or one a plugin
*declared* (`setHeaders({'User-Agent': …})`, a per-request header, or the `userAgent`
client option):

| `userAgentMode` | Wire UA |
|---|---|
| `identify` (default) | the configured UA — unless the plugin's manifest opts into `plugin` with a reason, then the plugin's declared UA |
| `strict` | the configured UA, always (a plugin opt-in is ignored) |
| `plugin` | the declared UA if the plugin has one, else the configured UA |

Plugins that opt in today (each must state why):

| Plugin | Why |
|---|---|
| `usajobs` | the Search API requires the UA to be the e-mail registered with the API key |
| `headhunter` | hh.ru requires an application-identifying UA and answers others with `400 bad_user_agent` |
| `simplyhired` | simplyhired.com answers HTTP 403 to search and detail pages requested with the Ever Jobs UA (live A/B 2026-09-25: 22/22 requests 200 with the declared browser UA) |

When the configured UA is sent and `stripClientHints` is on, `sec-ch-ua*` headers are
removed (a bot UA with Chrome client hints is an inconsistent fingerprint).

**Browser pages** (`BrowserPool`) follow the same rules: `identify`/`strict` use the
configured UA (stealth or not); `plugin` uses the page's declared UA, else the
pre-1690 random browser UA pool.

**Send a browser UA to one site only:**

```json
{ "sites": { "somesite": { "userAgent": "browser", "userAgentMode": "strict" } } }
```

(`browser` expands to the pre-1690 Chrome/120 UA; any literal string works too.) The
live A/B behind these defaults is in [Q-097](./questions.md).

---

## 9. Pacing

One process-wide limiter counts every request made through `HttpClient`, whichever
plugin makes it, against a **bucket**:

| `rateLimitScope` | Bucket | Use when |
|---|---|---|
| `host` (default) | exact hostname, e.g. `acme.softy.pro` | most sites |
| `domain` | registrable domain (Public Suffix List), e.g. `softy.pro` | multi-tenant platforms where every tenant is one server |
| `site` | the plugin's `Site`, whatever hosts it touches | a source spread over several hosts |

A request starts when fewer than `maxConcurrentPerHost` are in flight (0 = unlimited),
at least `minIntervalMs` (× the adaptive slow-down) plus `random(0..jitterMs)` after the
previous start in the bucket, and the bucket is not cooling down. Waiters are served
first-in first-out. **Every attempt, retries included, holds a slot.**

- **Adaptive throttle** (`adaptiveThrottle`): each `429`/`503` doubles the bucket's
  slow-down (up to ×16; a bucket with no interval gets a 500 ms × slow-down floor);
  each success decays it by ×0.8 back toward 1.
- **Queue wait** (`maxQueueWaitMs`): 0 waits as long as it takes (until the search
  deadline aborts the scrape); a positive value fails the request with
  `CrawlQueueTimeoutError` instead.
- A plugin's own delays and concurrency limits still apply on top — they are upper
  bounds, the limiter is the floor of politeness.
- **The limiter is per process.** With several API replicas (or an API plus CLI runs)
  each has its own buckets, so a site sees up to *replicas × `maxConcurrentPerHost`*
  requests in flight. Size per-host limits for the replica count you run.
- The limiter spaces *grants*: under a burst, the first gap between wire starts can be
  a few ms shorter than `minIntervalMs` (measured 86–90 ms for 100 ms).

---

## 10. Proxies

The proxy list for a request is the first non-empty of: the search request's `proxies`
(unless `EVER_JOBS_CRAWL_CALLER_PROXIES=none`), `EVER_JOBS_CRAWL_PROXIES`,
`DEFAULT_PROXIES` (unless `EVER_JOBS_CRAWL_DEFAULT_PROXIES_FALLBACK=false`), else none —
in which case axios still honours `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`. An entry of
`localhost` (or an empty entry) means "direct".

| `proxyRotation` | Behaviour |
|---|---|
| `per-host` (default) | the same proxy for the same bucket, process-wide and across restarts (stable hash) — each site sees one origin |
| `per-scrape` | one proxy per client (one scrape), spread across scrapes |
| `per-request` | round-robin on every request (pre-1690) |
| `off` | never use a proxy, even when a list is supplied |

A proxy that is not one of the operator's env proxies (e.g. a caller's) is itself
egress-checked (§13). The policy endpoint shows only how many env proxies exist, never
the list (it may carry credentials).

---

## 11. Retries and `Retry-After`

A response whose status is in `retryStatuses` (or a network error, when
`retryOnNetworkError`) is retried up to `retries` times. The wait is the back-off —
`exponential` base × 2^n, `linear` base × (n+1), or `constant` base — capped at
`retryMaxDelayMs`, with full jitter when `retryJitter`.

When `respectRetryAfter` and the response carries `Retry-After` (seconds or an
HTTP-date):

- **≤ `maxRetryAfterMs`** → wait `max(back-off, Retry-After)`: never earlier than asked.
- **> `maxRetryAfterMs`**, `retryAfterOverMax: give-up` (default) → no retry; the whole
  bucket cools down for the full `Retry-After` (capped at
  `EVER_JOBS_CRAWL_MAX_COOLDOWN_MS`, 1 h), and the request fails with
  `HostCoolingDownError`.
- **> `maxRetryAfterMs`**, `cap` → wait `maxRetryAfterMs`, then retry (pre-1690).

Any `429`/`503` in a paced bucket also cools **the whole bucket** — not just the request
that got it — and feeds the adaptive throttle. This includes a `429` your code accepted
through `validateStatus` (it is not retried, but it still counts).

---

## 12. robots.txt

| `robotsTxt` | Behaviour |
|---|---|
| `off` (default) | robots.txt is never fetched |
| `crawl-delay` | the `Crawl-delay` for our product token `EverJobs` (else `*`) becomes a floor on that bucket's `minIntervalMs` (capped at 1 h) |
| `respect` | as `crawl-delay`, and a disallowed URL fails with `RobotsDisallowedError` |

The file is fetched once per origin through the limiter, with the configured UA, and
cached (5,000 origins, 6 h). Missing (4xx) → everything allowed. Unreachable (5xx, 429,
network) → allowed for 5 minutes, then retried (`EVER_JOBS_CRAWL_ROBOTS_UNREACHABLE=disallow`
for the strict RFC 9309 reading). Downloads are capped at 2 MiB and parsing at
512 KiB, and rule count, pattern length and matcher work are bounded, so a hostile
robots.txt cannot stall the process.

Why off by default: fetching robots.txt for ~1,800 hosts per search is itself load, and
some `Crawl-delay` values would push sources past the search deadline. Turn it on per
site, per host or per request where it matters, or globally with the `strict` preset.

---

## 13. Egress guard

With `blockPrivateNetworks` (default `true`) Ever Jobs refuses to connect to:

- loopback, RFC 1918, link-local (cloud metadata), CGNAT, benchmarking, multicast and
  reserved IPv4 ranges, their IPv6 equivalents, and IPv4 addresses hidden inside IPv6
  or written in decimal/hex;
- `localhost`, `*.local`, `*.internal`, `*.svc`, `*.cluster.local`, `*.localdomain`,
  `*.home.arpa`, and dotless names.

The literal check runs before anything is sent (also through proxies, and on every
redirect); direct connections additionally use keep-alive agents whose DNS lookup
refuses private answers, which defeats DNS rebinding. A refusal is an
`EgressBlockedError`. This closes, for every plugin at once, the class of SSRF found in
fork syncs (Specs 1687/1688, [Q-092](./questions.md) option B).

**Local mock servers and e2e tests:**

```bash
# Allow-list just what you need (the guard stays on for everything else):
EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS=localhost,127.0.0.1,*.test

# Or turn the guard off for the process:
EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS=false
```

A single client can also be given `egressAllowHosts` (see §19). A search caller cannot
turn the guard off (§7.2).

**Redirect pinning (Spec 1689) is a separate, stricter check.** A plugin that fetches only
its own company's hosts passes `allowedRedirectHosts` to `createHttpClient`; every redirect
hop must then be an https URL on those hosts (or their subdomains) — whatever
`blockPrivateNetworks` says. When both apply, a hop is checked by the pin first, then by
the egress guard, then by any `beforeRedirect` the request brought itself; neither can be
replaced or skipped by a request (through `request()` or straight through
`getAxiosInstance()`, egress guard on or off). `EVER_JOBS_HTTP_PIN_REDIRECTS=false` turns only the pin
off (the escape hatch should a pinned site start redirecting somewhere legitimate).

---

## 14. Discovery modes

`discovery` selects the strategy of plugins that have more than one. Today that is
Softy ([Spec 1691](../.specify/specs/1691-softy-sitemap-discovery/spec.md)):

| Mode | Softy behaviour |
|---|---|
| `sitemap` | GET `/sitemap.xml`, take the `/offers/{ID}` entries newest `lastmod` first, fetch just enough detail pages, **one after another** |
| `listing` | GET `/offers?page=1..N` (21 cards per page) and parse the cards; the legacy `/offres` markup is still understood; detail pages per `descriptionDepth` |
| `auto` (default) | `sitemap`, falling back to `listing` when the sitemap is missing, empty or unparseable; `listing` straight away when no detail pages are wanted (`descriptionDepth: board`) or the detail budget is smaller than `offset + resultsWanted` |

Detail pages are cached by `url|lastmod`, so a repeat search only re-reads offers that
changed. Set per request (`crawl.discovery`), per operator site/host, or globally
(`EVER_JOBS_CRAWL_DISCOVERY`). Plugins with one strategy ignore it.

---

## 15. Search deadline, circuit breaker, liveness

- **Deadline abort.** When the search deadline (`EVER_JOBS_SEARCH_DEADLINE_MS`, 120 s)
  abandons a slow source, its queued requests leave the queue and its in-flight requests
  are cancelled — no orphan traffic after we stopped listening.
  `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false` restores the old detached behaviour.
- **Circuit breaker.** A scrape we aborted at the deadline counts as neither a failure
  nor a success (it says nothing about the source's health). The breaker now tracks up
  to `EVER_JOBS_CIRCUIT_MAX_SITES` sites (4,096; was a hard 250, so most of the ~1,850
  sources could never trip).
- **Liveness enrichment** runs its probes under the pseudo-site `liveness-http`, with
  the global policy but not the search caller's `crawl` (a caller's `retries` would
  override the checker's one-shot probes). Tune it with
  `EVER_JOBS_CRAWL_POLICIES='{"sites":{"liveness-http":{…}}}'`; a batch is bounded by
  `EVER_JOBS_LIVENESS_DEADLINE_MS` (60 s), after which unfinished probes are
  `uncertain`.

---

## 16. Reproducing the pre-1690 behaviour

**All of it:** `EVER_JOBS_CRAWL_PRESET=legacy`. That restores the Chrome/120 UA with the
pre-1690 precedence (a request's own UA header, else the client's `userAgent` option,
else Chrome/120; UAs set through `setHeaders()` never reach the wire — exactly the old
client), per-request proxy rotation with `DEFAULT_PROXIES` ignored, no pacing (the
builtin host limits and plugin manifests are off too), 3 linear retries on
`429,500,502,503,504` without jitter, `Retry-After` capped at the retry ceiling and
retried, no whole-bucket back-off, no egress guard; `BrowserPool` pages get the
pre-1690 UA pool (a random entry for stealth pages, the first entry otherwise). Combine with `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false` and
`EVER_JOBS_CIRCUIT_MAX_SITES=250` for the old deadline and breaker behaviour.

**One piece at a time** (on top of `polite`):

| Old behaviour | Setting |
|---|---|
| browser UA | `EVER_JOBS_CRAWL_USER_AGENT=browser` (+ `EVER_JOBS_CRAWL_USER_AGENT_MODE=strict` to also override plugin opt-ins) |
| plugins' own UAs sent, pool UA for browser pages | `EVER_JOBS_CRAWL_USER_AGENT_MODE=plugin` |
| no pacing | `EVER_JOBS_CRAWL_MAX_CONCURRENT_PER_HOST=0`, `EVER_JOBS_CRAWL_MIN_INTERVAL_MS=0`, `EVER_JOBS_CRAWL_ADAPTIVE=false`, `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`, `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false` |
| round-robin proxies | `EVER_JOBS_CRAWL_PROXY_ROTATION=per-request` |
| `DEFAULT_PROXIES` unused | `EVER_JOBS_CRAWL_DEFAULT_PROXIES_FALLBACK=false` |
| old retries | `EVER_JOBS_CRAWL_RETRIES=3`, `EVER_JOBS_CRAWL_RETRY_STATUSES=429,500,502,503,504`, `EVER_JOBS_CRAWL_RETRY_BACKOFF=linear`, `EVER_JOBS_CRAWL_RETRY_JITTER=false`, `EVER_JOBS_CRAWL_MAX_RETRY_AFTER_MS=30000`, `EVER_JOBS_CRAWL_RETRY_AFTER_OVER_MAX=cap` |
| no egress guard | `EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS=false` |
| requests keep running after the deadline | `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false` |
| breaker tracks 250 sites | `EVER_JOBS_CIRCUIT_MAX_SITES=250` |
| Softy's old browser UA | `"sites": {"softy": {"userAgentMode": "plugin"}}` |
| Softy list pages only | `"sites": {"softy": {"discovery": "listing"}}` |

---

## 17. Inspecting the effective policy

`GET /api/sources/:site/crawl-policy` returns the policy a request of that source would
get right now, and which layer set each field. Read-only; same auth as the other
`/api/sources` reads.

| Query | Meaning |
|---|---|
| `host` | a hostname or URL — selects the builtin-host and operator-host layers; without it, the site-level policy |
| `crawl` | a JSON caller override to preview; refused fields are listed in `meta.caller.rejected` |

```bash
curl 'http://localhost:3001/api/sources/softy/crawl-policy?host=acme.softy.pro'
```

```json
{
  "site": "softy",
  "host": "acme.softy.pro",
  "userAgent": "Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)",
  "userAgentMode": "identify",
  "stripClientHints": true,
  "proxyRotation": "per-host",
  "rateLimitScope": "domain",
  "maxConcurrentPerHost": 1,
  "minIntervalMs": 1000,
  "retries": 2,
  "discovery": "auto",
  "provenance": {
    "userAgent": "preset",
    "rateLimitScope": "plugin",
    "maxConcurrentPerHost": "plugin",
    "minIntervalMs": "plugin",
    "retries": "preset"
  },
  "meta": {
    "preset": "polite",
    "callerOverrides": "any",
    "abortOnDeadline": true,
    "envProxyCount": 0,
    "plugin": { "rateLimitScope": "domain", "maxConcurrentPerHost": 1, "minIntervalMs": 1000 },
    "operatorHostPatterns": []
  },
  "warnings": []
}
```

(Abridged: the real response lists every one of the 24 fields and its provenance.)
`userAgentReason` appears when a plugin's UA opt-in is in effect (try
`/api/sources/usajobs/crawl-policy`). `warnings` carries env parse warnings and
resolution notes, with any `user:password@` redacted. 404 for an unknown site, 400
for an unparseable `host` or `crawl`.

---

## 18. Troubleshooting

Crawl-policy refusals carry a stable `code`, and search diagnostics
(`POST /api/jobs/search?diagnostics=true`) report them per source:

| Error (`code`) | Diagnostic reason | Meaning | What to do |
|---|---|---|---|
| `HostCoolingDownError` (`ERR_CRAWL_HOST_COOLING_DOWN`) | `rate_limited` | the host sent a `Retry-After` longer than `maxRetryAfterMs` (60 s), or its bucket is still cooling down from one for longer than the request may wait | Usually: wait — the server asked for it. The message names the bucket and the time. To wait longer instead of failing: raise `maxRetryAfterMs` (and/or `maxQueueWaitMs`) for that host; to retry after the maximum anyway: `retryAfterOverMax: "cap"`. If it keeps happening, lower `maxConcurrentPerHost` / raise `minIntervalMs` for that host. |
| `CrawlQueueTimeoutError` (`ERR_CRAWL_QUEUE_TIMEOUT`) | `rate_limited` | no slot within `maxQueueWaitMs` (only when it is > 0) | raise `maxQueueWaitMs`, or the host's `maxConcurrentPerHost`, or lower the number of sources searched at once |
| `RobotsDisallowedError` (`ERR_CRAWL_ROBOTS_DISALLOWED`) | `blocked` | `robotsTxt: respect` and the site's robots.txt disallows the URL for `EverJobs` | respect it, or use `crawl-delay`/`off` for that site if you have permission |
| `EgressBlockedError` (`ERR_CRAWL_EGRESS_BLOCKED`) | `bad_input` | the URL, a redirect or a caller proxy points at a private/internal address | fix the input; for local mocks see §13; for split-horizon DNS allow-list the host |

Common symptoms:

- **A search is slower than before / sources hit the deadline.** Check the policy of the
  slow source's host (§17). Raise its limits with an operator host entry (§6.2), raise
  `EVER_JOBS_SEARCH_DEADLINE_MS`, or search fewer sources. `EVER_JOBS_CRAWL_PRESET=legacy`
  confirms whether pacing is the cause.
- **A site returns 403/406 or a captcha since the upgrade.** It may refuse non-browser
  clients. Per site: `{"sites": {"<site>": {"userAgentMode": "plugin"}}}` if the plugin
  declares a UA, or `{"userAgent": "browser", "userAgentMode": "strict"}`. Evidence for
  individual plugins is in [Q-097](./questions.md) — some sites refuse the *browser* UA
  and accept ours, so test both.
- **USAJobs 401 / HeadHunter `400 bad_user_agent`.** Something forces the configured UA:
  `EVER_JOBS_CRAWL_USER_AGENT_MODE=strict`, the `strict`/`legacy` preset, or a caller
  `userAgentMode`. Allow the opt-in with an operator site entry
  (`"usajobs": {"userAgentMode": "plugin"}`).
- **Requests to a local mock server fail.** §13.
- **An env change has no effect.** The environment is read once per process — restart.
  Then check `warnings` in §17 (a misspelt value is ignored with a warning).
- **Still getting 429s.** Lower concurrency or raise the interval for that host
  (the adaptive throttle helps within a process, not across replicas — each replica
  has its own limiter), or switch the bucket to `domain` scope.
- **A proxy is not used.** Check `proxyRotation` is not `off`, `EVER_JOBS_CRAWL_PROXIES`
  is not `none`, `EVER_JOBS_CRAWL_CALLER_PROXIES` for request proxies, and that
  `legacy` ignores `DEFAULT_PROXIES`. `envProxyCount` in §17 shows what the env gave.

---

## 19. For plugin authors

- **Declare site-specific needs in the manifest**, not in code:

  ```ts
  @SourcePlugin({
    site: Site.ACME,
    name: 'Acme',
    category: 'ats',
    isAts: true,
    // One server behind every tenant: one budget, one request at a time, ~1/s.
    crawl: { rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 },
  })
  ```

  Operators and callers can still override it. Any `CrawlPolicy` field is allowed.
- **Fetch detail pages of fragile sites sequentially** (`for (const url of urls) { await … }`),
  never an unbounded `Promise.allSettled` over hundreds of URLs. The limiter bounds
  concurrency per host, but a sequential loop also stops early on the first
  `HostCoolingDownError` or abort, and keeps partial results.
- **Do not set a browser UA.** It is recorded as *declared* and only sent in UA mode
  `plugin`. If an API genuinely requires a specific UA, declare it with `setHeaders`
  and opt in: `crawl: { userAgentMode: 'plugin', userAgentReason: '<why>' }` (the reason
  is shown by the policy endpoint; an opt-in without one is flagged in its `warnings`).
- **Do not hand-roll politeness.** No `sleep` between requests for pacing, no custom
  retry loops on 429 — `HttpClient` does both per the policy. Keep existing plugin
  constants as upper bounds.
- **Handle crawl-policy errors deliberately.** `isCrawlPolicyError(err)`: stop the
  scrape on `ERR_CRAWL_HOST_COOLING_DOWN` / `ERR_CRAWL_QUEUE_TIMEOUT` / abort and return
  what you have with its diagnostic; treat `ERR_CRAWL_ROBOTS_DISALLOWED` as "not
  available"; never report them as "no jobs".
- **Per-request overrides:** pass a `CrawlRequestConfig` with `crawl` to
  `get`/`post`/`request`; per-client ones via `createHttpClient({ …, crawl, site })`.
  `client.crawlPolicyFor(url)` shows what a request would get.
- **Sitemaps:** use `fetchSitemap(http, url, options)` from `@ever-jobs/common` (gzip,
  indexes, lastmod sorting, size bounds) and `BoundedTtlCache` for detail caches keyed
  by `url|lastmod`.
- **Browser pages:** pass `host` (and a declared `userAgent`, if any) in the
  `BrowserPool.getPage()` options so the right policy applies.
- **`createHttpClient(input)`** with the search DTO keeps working: inside a search the
  DTO's caller fields are ignored (the scrape context already carries them) and your
  own `timeout` is no longer dropped when proxies are set.
- **Calls straight through `getAxiosInstance()`** get the identity and the egress check
  but are **not** paced or retried — use `get`/`post`/`request`.
- **Mocks for local tests:** `egressAllowHosts: ['localhost']` on the client, or
  `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS`.
- Plugin unit tests that stub `createHttpClient` are unaffected; there is nothing to
  mock for the policy.
