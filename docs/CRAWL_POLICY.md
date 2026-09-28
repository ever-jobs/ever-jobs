# Crawl Policy — Operator Guide

> How Ever Jobs identifies itself, paces its requests, uses proxies, backs off, and
> which of it you can change — globally, per site, per host, per plugin and per search.
> Design: [Spec 1690](../.specify/specs/1690-crawl-policy/spec.md) (crawl policy),
> [Spec 1691](../.specify/specs/1691-softy-sitemap-discovery/spec.md) (Softy sitemap
> discovery), [Spec 1714](../.specify/specs/1714-crawl-caller-lock-and-host-policies/spec.md)
> (site-owner caller lock, host-owned policies, gentler pacing knobs) and
> [Spec 1715](../.specify/specs/1715-softy-audit-hardening/spec.md) (Softy: stop on
> push-back, sitemap-first for real). Decision record: [ADR 0001](./adr/0001-crawl-policy.md).

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
20. [Browser pages (`BrowserPool`)](#20-browser-pages-browserpool)
21. [Softy — a site-owner policy](#21-softy--a-site-owner-policy)

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

A follow-up audit (2026-09-26, 35 gaps) found paths that still broke the five asks: an
anonymous API caller could undo them on a default install (browser UA, no interval,
per-request proxies, `Retry-After` off, list pages), liveness probes and other plugins
reached `*.softy.pro` under the generic defaults, a slow server got back-to-back
requests, and a `5xx` caused no back-off. Spec 1714 closes the shared-layer paths — a
**site owner's lock** on what callers may change (§7.2), **host-owned policies** that
apply whichever plugin reaches a host (§6.4), an **idle gap** after each answer and a
**server-error cool-down** (§9, §11), a **fleet-size** multiplier (§9) — and Spec 1715
closes the Softy plugin's own (§21). A review of both (2026-09-27) closed the rest:
redirect hops are paced by the target host's policy (§9), a caller's timeout is gated
per request host and never cools a bucket (§7.2, §11), a caller's `resultsWanted` no
longer steers Softy to list pages (§21.3), a recent sitemap listing spares a liveness
probe (§15), and the `legacy` preset and the restore recipes now bring back exactly the
old behaviour (§16).

Two principles shaped the result:

- **Polite by default.** Out of the box Ever Jobs names itself, paces requests per host,
  keeps one stable origin per site, and never retries earlier than a server asks.
- **Everything configurable, nothing removed.** Every knob can be set by a preset, an
  environment variable, a plugin's manifest, an operator's per-site or per-host policy,
  and — unless the operator forbids it — the search request. The pre-1690 crawl
  behaviour is one setting away: `EVER_JOBS_CRAWL_PRESET=legacy` (§16 lists exactly
  what it restores, and the few plugin settings it leaves alone).

---

## 2. Defaults at a glance

With no configuration at all (preset `polite`):

| Topic | Default |
|---|---|
| User-Agent | `Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)` on every request, except plugins that opt in with a stated reason (USAJobs and HeadHunter: their API requires its own UA; SimplyHired: 403s our UA, live A/B 2026-09-25) |
| Client hints | `sec-ch-ua*` headers removed whenever our own UA is sent |
| Pacing | per exact hostname: at most **4** requests in flight, at least **100 ms** between request starts; adaptive slow-down after `429`/`503`; no idle gap after an answer (`minGapMs` 0) and no cool-down after a `5xx` (`serverErrorCooldownMs` 0) — both on for Softy |
| Bulk ATS APIs | `api.greenhouse.io` / `boards-api.greenhouse.io` 16 in flight, `api.lever.co` / `api.ashbyhq.com` / `api.smartrecruiters.com` 12, no gap |
| Softy (`*.softy.pro` builtin host policy + plugin manifest) | for **every** request to `softy.pro` and its tenants, whichever plugin makes it: one bucket for all of `softy.pro`, **1** in flight, **1 s** between starts, **0.5 s** idle after each answer, one stable proxy, 1 retry on `429`/`503` only (≥ 10 s back-off), a **30 s** whole-bucket cool-down after a `500`/`502`/`504` or a timeout — and **locked**: a search caller may only make it more polite (§6.4, §7.2, §21) |
| Proxies | none, unless configured; when a list is configured, one stable proxy per host bucket (`per-host`) |
| Retries | 2 (**at most 10** at any layer), on `429, 502, 503, 504`, exponential back-off from 1 s (cap 30 s) with full jitter; a `429`/`503` waits **at least 5 s**, then 10 s (`throttleRetryDelayMs`); no retry follows its failure in under 100 ms |
| `Retry-After` | honoured; never retried earlier than asked; over **60 s** → give up and cool the whole bucket for the full period |
| robots.txt | not fetched (`off`) |
| Private networks | refused (loopback, RFC 1918, link-local, CGNAT, cluster names…) |
| Discovery (Softy) | `auto`: sitemap first; list pages only when the sitemap answered but held no offer (§21) |
| Caller overrides | `any` globally (`EVER_JOBS_CRAWL_CALLER_OVERRIDES`), tightened to `stricter` for sources and hosts whose owner asked (Softy; §7.2) |
| Replicas | each process paces on its own; `EVER_JOBS_CRAWL_FLEET_SIZE` (default 1) spreads one policy over N processes (§9) |
| Redirects | a hop to a host with a host-owned policy (`*.softy.pro`), or to another rate-limit bucket while a caller lock applies, is sent as a request of its own under that host's policy; other hops — every hop of a source without a lock that stays off host-owned policies — are followed in the same slot, as before (§9; `EVER_JOBS_CRAWL_PACE_REDIRECTS`) |
| Search deadline | abandoned sources have their queued and in-flight requests cancelled |
| Browser pages | navigations through `BrowserPool.navigate` get the same egress guard, robots.txt, per-host pacing, deadline abort and `429`/`503` back-off (§20) |

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
| `minGapMs` (Spec 1714) | `0` | `0` | `0` |
| `serverErrorCooldownMs` (Spec 1714) | `0` | `0` | `0` |
| `retries` | `2` | `3` | `1` |
| `retryStatuses` | `429,502,503,504` | `429,500,502,503,504` | `429,503` |
| `retryBackoff` | `exponential` | `linear` | `exponential` |
| `retryBaseDelayMs` / `retryMaxDelayMs` | `1000` / `30000` | `1000` / `30000` | `1000` / `30000` |
| `retryJitter` | `true` | `false` | `true` |
| `retryOnNetworkError` | `false` | `false` | `false` |
| `respectRetryAfter` | `true` | `true` | `true` |
| `maxRetryAfterMs` | `60000` | `30000` (follows `retryMaxDelayMs`) | `60000` |
| `retryAfterOverMax` | `give-up` | `cap` | `give-up` |
| `throttleRetryDelayMs` | `5000` | `0` (no floor) | `30000` |
| `robotsTxt` | `off` | `off` | `respect` |
| `blockPrivateNetworks` | `true` | `false` | `true` |
| `discovery` | `auto` | `auto` | `auto` |
| builtin host policies (bulk APIs, `*.softy.pro`) | on | **off** | on |
| plugin manifests (`@SourcePlugin({ crawl })`) | on | **off** | on |
| `DEFAULT_PROXIES` as fallback list | on | **off** | on |
| browser navigations under the policy (§20) | on | **off** (plain `page.goto`) | on |
| `stricter` comparators, `EVER_JOBS_CRAWL_STRICTER_RULES` (§7.2) | `1714` | **`1690`** (and `requestTimeout` ungated) | `1714` |
| `per-host` proxy pick, `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE` (§10) | `base` | **`bucket`** | `base` |
| robots.txt answers feed the limiter, `EVER_JOBS_CRAWL_ROBOTS_BACKOFF` (§12) | on | **off** | on |
| redirect hops paced on their own, `EVER_JOBS_CRAWL_PACE_REDIRECTS` (§9) | on | **off** | on |
| a `stricter` caller's `proxyRotation`, `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION` (§7.2) | `base` | **`ranked`** | `base` |
| a failed request's cool-down recorded before its slot is freed, `EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE` (§11) | `locked` | **`off`** | `locked` |
| API: breaker counts refusals, a `503` stops locations, liveness trusts a fresh fetch or a recent listing (§15) | on | **off** | on |

> **The Spec 1714 / 1715 switches follow the preset** (Spec 1715 review F7). The last
> seven rows are switches of their own (§5.2, §5.4; the API row stands for four); left
> unset, each takes the value in the preset's column, so `legacy` restores its pre-1714
> behaviour too. An explicit value always wins over the preset.

> **`strict` still applies the builtin bulk-host limits and plugin manifests** (layers 3
> and 4 sit above the preset). For "one request per domain per second, everywhere,
> no exceptions" also set `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`, or use an operator host
> policy for `*` (§6.3), which sits above both. One consequence ([Q-121](./questions.md)):
> under `strict` the builtin `*.softy.pro` entry sets Softy's throttle floor to 10 s
> (strict's own is 30 s) — an operator `hosts["*.softy.pro"]` entry restores any value.

---

## 4. Layers and precedence

The policy is resolved **per request** from these layers, lowest precedence first. A
layer only overrides the fields it sets.

| # | Layer | Where it comes from |
|---|---|---|
| 1 | preset | `EVER_JOBS_CRAWL_PRESET` |
| 2 | env-global | `EVER_JOBS_CRAWL_*` variables (and the pre-1690 `RETRY_DEFAULT_*`, when set) |
| 3 | builtin-host | `BUILTIN_HOST_POLICIES`: the bulk-API limits in §2 and site-owner policies such as `*.softy.pro` (exact hosts and `*.suffix` patterns, every match applies, least specific first; off under `legacy` or with `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`; single patterns off with `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE`; §6.4) |
| 4 | plugin | the plugin's `@SourcePlugin({ crawl })` manifest, then the options it passes to `createHttpClient` |
| 5a | operator-site | `sites["<site>"]` of `EVER_JOBS_CRAWL_POLICIES` / `EVER_JOBS_CRAWL_POLICY_FILE` (and the pre-1690 `RETRY_PER_SOURCE`) |
| 5b | operator-host | every matching `hosts["<pattern>"]` entry, least specific first |
| 6 | caller | the search request's `crawl` object and legacy flat fields, filtered by the **effective** caller-override mode: `EVER_JOBS_CRAWL_CALLER_OVERRIDES` tightened by any site owner's lock, or an operator's per-site / per-host value (§7.2) |

Things to remember:

- **An env-global value is below builtin hosts and plugin manifests.** Setting
  `EVER_JOBS_CRAWL_MAX_CONCURRENT_PER_HOST=1` does not lower Greenhouse (builtin 16) or
  change Softy (manifest and builtin host 1/s) — and a *slower* global value does not
  reach them either: with `EVER_JOBS_CRAWL_MIN_INTERVAL_MS=2000`, every request to
  `*.softy.pro` still runs 1 s apart (§6.4). To force a value over everything except the
  caller, use an operator policy (§6); a `hosts["*"]` entry matches every host.
- **Operator host patterns stack**: `*` < shorter `*.suffix` < longer `*.suffix` <
  exact host; the most specific wins field by field. Site entries apply before host
  entries, so a host entry wins over a site entry.
- **The caller is filtered against the policy resolved without it**, for that host.
- **A layer can carry a lock, `callerOverrides`** (Spec 1714): a plugin manifest, a
  builtin host policy, or an operator `sites` / `hosts` entry. It is not a policy field
  (it never appears in the resolved policy); it decides how the caller layer is
  filtered for the requests that layer covers (§7.2).

### Worked example

A search reads `https://acme.softy.pro/offers/123` with:

- env: `EVER_JOBS_CRAWL_MIN_INTERVAL_MS=250`, `EVER_JOBS_CRAWL_JITTER_MS=100`,
  `EVER_JOBS_CRAWL_CALLER_OVERRIDES=stricter`
- the builtin host policy `*.softy.pro` (§6.4) and Softy's manifest (§21): domain scope,
  1 in flight, 1 s, a 0.5 s idle gap, 1 retry, lock `stricter`
- operator: `{"hosts": {"*.softy.pro": {"minIntervalMs": 2000}}}`
- caller: `"crawl": {"maxConcurrentPerHost": 2, "minIntervalMs": 3000}`

| Field | Value | Set by (`provenance`) | Why |
|---|---|---|---|
| `userAgent` | Ever Jobs UA | `preset` | nothing overrides it |
| `rateLimitScope` | `domain` | `plugin` | builtin host and manifest agree; the manifest (layer 4) is the higher layer |
| `maxConcurrentPerHost` | `1` | `plugin` | caller's `2` is less strict than `1` → rejected under `stricter` |
| `minIntervalMs` | `3000` | `caller` | env 250 < builtin/manifest 1000 < operator 2000 < caller 3000 (higher is stricter → accepted) |
| `minGapMs` | `500` | `plugin` | |
| `jitterMs` | `100` | `env-global` | nobody above sets it |
| `retries` | `1` | `plugin` | |

The effective caller-override mode is `stricter`: the global value, the builtin host lock
and the manifest lock all ask for it, and the policy endpoint names the highest layer
that did (`meta.callerOverridesProvenance: "plugin"`). Without the environment variable
the result is the same — the lock makes Softy `stricter` on a default install.

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
| `EVER_JOBS_CRAWL_MIN_GAP_MS` | int — idle time after an answer before the bucket's next start, on top of `minIntervalMs` (§9; Spec 1714) | `0` (none) |
| `EVER_JOBS_CRAWL_SERVER_ERROR_COOLDOWN_MS` | int — whole-bucket cool-down after a `500`/`502`/`504`, a timeout or a reset (§11; Spec 1714) | `0` (off) |
| `EVER_JOBS_CRAWL_RETRIES` | int `0`–`10` (a larger value is clamped to `10`, with a warning; §11) | `2` |
| `EVER_JOBS_CRAWL_RETRY_STATUSES` | comma list or JSON array of 100–599; `none` = no status retried | `429,502,503,504` |
| `EVER_JOBS_CRAWL_RETRY_BACKOFF` | `exponential` \| `linear` \| `constant` | `exponential` |
| `EVER_JOBS_CRAWL_RETRY_BASE_DELAY_MS` | int | `1000` |
| `EVER_JOBS_CRAWL_RETRY_MAX_DELAY_MS` | int | `30000` |
| `EVER_JOBS_CRAWL_RETRY_JITTER` | bool | `true` |
| `EVER_JOBS_CRAWL_RETRY_ON_NETWORK_ERROR` | bool (connection resets/timeouts; never `ENOTFOUND` or cancellations) | `false` |
| `EVER_JOBS_CRAWL_RESPECT_RETRY_AFTER` | bool | `true` |
| `EVER_JOBS_CRAWL_MAX_RETRY_AFTER_MS` | int | `60000` |
| `EVER_JOBS_CRAWL_RETRY_AFTER_OVER_MAX` | `give-up` \| `cap` | `give-up` |
| `EVER_JOBS_CRAWL_THROTTLE_RETRY_DELAY_MS` | int, back-off floor after a `429`/`503` (§11); `0` = no floor | `5000` |
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
| `EVER_JOBS_CRAWL_BUILTIN_HOSTS` | bool — apply the builtin host policies (§6.4): the bulk-API limits **and** the site-owner entries (`*.softy.pro`, `softy.pro`: Softy's pacing and lock). To drop only some entries, use `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE` | `true` (`false` under `legacy`) |
| `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE` | comma / space list of builtin host patterns to skip, e.g. `*.softy.pro,softy.pro` (§6.4; Spec 1715 review F3). The other entries keep applying; a pattern that is not a builtin key is ignored with a warning. Shown as `meta.builtinHostsDisabled` (§17) | empty (every entry applies) |
| `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS` | bool — apply `@SourcePlugin({ crawl })` | `true` (`false` under `legacy`) |
| `EVER_JOBS_CRAWL_DEFAULT_PROXIES_FALLBACK` | bool — use `DEFAULT_PROXIES` when `EVER_JOBS_CRAWL_PROXIES` is unset | `true` (`false` under `legacy`) |
| `EVER_JOBS_CRAWL_BROWSER_NAVIGATION` | bool — put browser navigations (`BrowserPool.navigate`) under the policy (§20); `false` = a plain `page.goto` | `true` (`false` under `legacy`) |
| `EVER_JOBS_CRAWL_FLEET_SIZE` | int `1`–`1000` — processes sharing one egress IP; each multiplies its start-to-start spacing and `minGapMs` by it (§9; Spec 1714). Out of range → clamped with a warning | `1` (= pre-1714) |
| `EVER_JOBS_CRAWL_STRICTER_RULES` | `1714` \| `1690` — which `stricter` comparators judge a caller (§7.2); `1690` restores the pre-1714 ones and leaves `requestTimeout` ungated everywhere (in `JobsService` and, since Spec 1715, per host in `HttpClient`) | `1714` (`1690` under `legacy`) |
| `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE` | `base` \| `bucket` — what a `per-host` proxy pick keys on under a lock (§10); `bucket` = pre-1714 | `base` (`bucket` under `legacy`) |
| `EVER_JOBS_CRAWL_ROBOTS_BACKOFF` | bool — robots.txt answers feed the limiter like any request (§12); `false` = pre-1714 | `true` (`false` under `legacy`) |
| `EVER_JOBS_CRAWL_PACE_REDIRECTS` | bool — a redirect hop to a host with a host-owned policy, or to another rate-limit bucket while a caller lock applies, is re-issued under its own policy instead of being followed in the request's slot; a source without a lock keeps the in-slot follow (§9; Spec 1715 review A0, round 2); `false` = pre-fix | `true` (`false` under `legacy`) |
| `EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE` | `locked` \| `all` \| `off` — when a FAILED attempt frees its limiter slot (§11; review of PR #105): `locked` records the failure's outcome and cool-down first for a request under a lock (a caller lock, or a site owner's builtin host lock: every request to `*.softy.pro`), so no queued request is granted inside that cool-down; every other request frees the slot first, as before; `all` = every request records first; `off` = the pre-fix order | `locked` (`off` under `legacy`) |
| `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION` | `base` \| `ranked` — under `stricter` (rules `1714`), `base` accepts a caller's `proxyRotation` only when it equals the resolved value, or is `off` while no proxy list is configured; `ranked` = the round-1 order `off` < `per-host` < `per-scrape` < `per-request` (§7.2; Spec 1715 review round 2) | `base` (`ranked` under `legacy`) |

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
| `EVER_JOBS_SEARCH_STOP_ON_503` | a `503` (thrown, or a `fetch_error` naming it) stops the remaining locations of a multi-location search for that source, like `rate_limited` / `blocked` (§15; Spec 1714); `false` = pre-1714 | `true` (`false` under `legacy`) |
| `EVER_JOBS_BREAKER_COUNT_REFUSALS` | a scrape that resolves with 0 jobs and a `rate_limited` / `blocked` diagnostic counts as a circuit-breaker failure (§15; Spec 1714); `false` = pre-1714 | `true` (`false` under `legacy`) |
| `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH` | `?liveness=true` does not re-probe a job whose plugin fetched its page during this request (`jobUrlFetchedAt`; §15; Spec 1714); `false` = pre-1714 for this evidence | `true` (`false` under `legacy`) |
| `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` | int ms — `?liveness=true` does not probe a job whose source listed it in an index fetched at most this long ago (`jobUrlListedAt`, e.g. a Softy sitemap; also on a search-cache hit; §15; Spec 1715 review A3); `0` = off (pre-fix). Every URL is probed only with this at `0` **and** the switch above `false` | `600000` (10 min; `0` under `legacy`) |
| `SOFTY_*` | the Softy plugin's own knobs — sitemap fallback, unknown-tenant cache, detail budget and caches, push-back handling, `SOFTY_LEGACY` restore tokens: see §21 | — |

The four API switches above (`EVER_JOBS_SEARCH_STOP_ON_503`,
`EVER_JOBS_BREAKER_COUNT_REFUSALS`, `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH`,
`EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS`) read the preset through the same parse as
the crawl layer, so `LEGACY` or ` legacy ` counts and an invalid preset (read as
`polite`) does not. An invalid value keeps the default and is **logged once per
variable and value**, naming the value used instead (`SearchSwitches` logger; the
breaker's own warning for `EVER_JOBS_BREAKER_COUNT_REFUSALS`) — Spec 1715 review F8.
The search and liveness switches are read per search, the breaker's once when it is
built; the configuration mirrors them read-only (`searchSwitches.*`,
`circuit.countRefusals`).

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
- **`callerOverrides`** (`any` \| `stricter` \| `none`, Spec 1714) is also accepted in a
  site or host entry: it sets what a search caller may change for that site or host,
  looser or tighter than a site owner's lock and than the global
  `EVER_JOBS_CRAWL_CALLER_OVERRIDES` (§7.2).
- Merge order per field: `RETRY_PER_SOURCE` < the file < `EVER_JOBS_CRAWL_POLICIES`.

### 6.1 Example — Softy, with more margin than its operator asked for

```json
{
  "hosts": {
    "*.softy.pro": {
      "minIntervalMs": 1500,
      "jitterMs": 500,
      "discovery": "sitemap"
    }
  }
}
```

Since Spec 1714 every request to `*.softy.pro` already runs under the builtin Softy
policy (§6.4: domain scope, 1 in flight, 1 s, 0.5 s idle, one retry on `429`/`503`,
cool-downs, the `stricter` lock); this slows it further and forces sitemap discovery.
The same could be written as `"sites": { "softy": { … } }` — a site entry follows the
plugin wherever it goes, a host entry follows the server (and so also covers liveness
probes and any other plugin that reaches it).

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

### 6.4 Builtin host policies (host-owned; Spec 1714)

A site's pace belongs to its **server**, not to the plugin that happens to call it:
liveness probes (`?liveness=true`), the JSON-LD plugin, or any other code path that
reaches `acme.softy.pro` must be as polite as the Softy plugin. So the builtin-host
layer (layer 3) is keyed by host pattern with exactly the operator `hosts` semantics —
an exact host, or `*.suffix` for any subdomain (not the apex) — and is resolved **per
request host, whichever site makes the request**. Every matching pattern applies,
least specific first.

| Pattern | Policy |
|---|---|
| `api.greenhouse.io`, `boards-api.greenhouse.io` | `maxConcurrentPerHost: 16`, `minIntervalMs: 0` |
| `api.lever.co`, `api.ashbyhq.com`, `api.smartrecruiters.com` | `maxConcurrentPerHost: 12`, `minIntervalMs: 0` |
| `*.softy.pro`, `softy.pro` | `BUILTIN_SOFTY_HOST_POLICY`: `rateLimitScope: domain`, `maxConcurrentPerHost: 1`, `minIntervalMs: 1000`, `minGapMs: 500`, `proxyRotation: per-host`, `retries: 1`, `retryStatuses: [429, 503]`, `throttleRetryDelayMs: 10000`, `serverErrorCooldownMs: 30000`, `respectRetryAfter: true`, `retryAfterOverMax: give-up`, **`callerOverrides: stricter`** |

The Softy entry equals the Softy manifest on every pacing, retry and lock field (a
parity test in the Softy suite guards it); it has no identity field on purpose — a
builtin `userAgentMode` could loosen an operator's env `strict`, so the manifest
carries `identify` instead. A tenant's own custom domain served by Softy cannot be
known in advance; cover it with an operator `hosts` entry.

**The lock keeps one origin** (Spec 1715 review round 2). Under it a caller cannot change
`proxyRotation` at all while the operator configured proxies — not even to `off`, which
would send that caller's Softy requests from the server's own IP while every other
request to `*.softy.pro` (the Softy plugin, liveness probes, JSON-LD) goes through the one
proxy pinned on `domain:softy.pro`. `off` is still accepted when no proxy list is
configured (nothing changes on the wire). `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=ranked`
restores the round-1 order (§7.2).

**A builtin host entry beats env-global values** (and the preset) for every plugin that
reaches that host, because layer 3 sits above layer 2 (§4). That cuts both ways: an
operator's *slower* global setting does not reach the host either. With
`EVER_JOBS_CRAWL_MIN_INTERVAL_MS=2000` and `EVER_JOBS_CRAWL_RETRIES=4`, JSON-LD requests
to `acme.softy.pro` still run 1 s apart with 1 retry, and liveness probes 1 s apart
(provenance `builtin-host`); under `strict` the entry lowers Softy's throttle floor from 30 s to 10 s
([Q-121](./questions.md)). To make a global value hold there too, repeat it in an operator
`hosts` entry (`"*.softy.pro"`, `"softy.pro"`, or `"*"` for every host), which sits above
the builtin layer.

**Operators stay in charge.** Operator `sites` / `hosts` entries sit above the builtin
layer and override any field of it, the lock included:

```json
{
  "sites": { "softy": { "callerOverrides": "any" } },
  "hosts": {
    "*.softy.pro": { "callerOverrides": "any" },
    "softy.pro": { "callerOverrides": "any" }
  }
}
```

together with **`SOFTY_LEGACY=no-interval-floor`** gives search callers back every Softy
field they could change before Spec 1714 (use it only with the site's agreement). The
JSON alone lifts the lock, but the Softy plugin's own client keeps its 1 s spacing floor
(§9, §21), which no policy layer shortens — so a caller's `minIntervalMs: 0` or
`rateDelayMin: 0` would still leave Softy's own requests 1 s apart. The policy endpoint
shows the floor in force as `meta.clientMinIntervalFloorMs` (`1000`; `null` once
`SOFTY_LEGACY=no-interval-floor` removed it, so the step can be confirmed) and the switch
that removes it as `meta.clientMinIntervalFloorSwitch` (§17).

Narrower and broader switches:

- `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE=*.softy.pro,softy.pro` (Spec 1715 review F3)
  skips just those builtin entries: other plugins and liveness probes reach Softy's hosts
  under the generic defaults again (the pre-1714 treatment), while Greenhouse, Lever,
  Ashby and SmartRecruiters keep their builtin limits. The Softy plugin keeps its own
  manifest (a plugin layer, not a builtin entry). The skipped patterns are listed in
  `meta.builtinHostsDisabled` and in `warnings` (§17).
- `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` switches the whole builtin layer off — the
  bulk-API limits too, so Greenhouse drops from 16 in flight to the generic 4.
- `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false` switches off every manifest.

The complete pre-1715 Softy crawl policy (retries, back-off, idle gap, client floor, lock)
is an operator recipe in §16. `GET /api/sources/liveness-http/crawl-policy?host=acme.softy.pro`
shows the builtin entry at work (`meta.builtinHostPatterns: ["*.softy.pro"]`, §17).

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
    "crawl": { "discovery": "sitemap", "maxConcurrentPerHost": 1 }
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

### 7.2 What a caller may change — `EVER_JOBS_CRAWL_CALLER_OVERRIDES` and site-owner locks

- `any` (default) — every field, except that **`blockPrivateNetworks` can only be
  turned on** by a caller, never off (it is a security boundary; operators disable it).
- `stricter` — only values at least as polite as the policy the request would get
  without the caller (table below).
- `none` — the caller's `crawl` and legacy fields are ignored.

**The effective mode of a request** (Spec 1714). The API caller is not the operator:
a site owner's request must survive an anonymous caller on a default install, and the
operator must still be able to undo it. So the mode the caller layer is filtered with
is:

1. the **most restrictive** (`none` > `stricter` > `any`) of the global
   `EVER_JOBS_CRAWL_CALLER_OVERRIDES`, the plugin layer's `callerOverrides` (its
   `@SourcePlugin({ crawl })` manifest when manifests are on, and the options it passes
   to `createHttpClient`) and every matching builtin host pattern's (§6.4) — a lock can
   only tighten the global mode;
2. **unless an operator `sites` / `hosts` entry sets `callerOverrides`** for that site or
   host: then the operator's value wins outright, looser or tighter (a host entry beats
   a site entry; among host patterns the most specific one that sets it wins).

A caller can never send a lock: `callerOverrides` in a request's `crawl` is always
refused. Softy ships locked (`stricter`, from its manifest and from the builtin
`*.softy.pro` entry), so on a default install a caller may slow Softy traffic down,
send the honest UA in `strict` mode or pick the sitemap, and nothing else. The policy
endpoint shows the effective mode and who set it (`meta.callerOverrides`,
`meta.callerOverridesProvenance`: `default`, `env-global`, `builtin-host`, `plugin`,
`operator-site` or `operator-host`; §17). For every source without a lock the effective
mode is the global one and resolution is byte-for-byte what it was (a golden test pins
it) — and so is its `per-host` proxy pick (§10; a second golden test, Spec 1715 review C3).

**`stricter` comparators.** A value is accepted when it is at least as polite as the
policy resolved without the caller (an equal value is always accepted).
`EVER_JOBS_CRAWL_STRICTER_RULES=1690` restores the Spec 1690 column — strictly looser —
for operators who relied on it:

| Field | Rules `1714` (default) | Rules `1690` |
|---|---|---|
| `userAgent`, `from` | never (an identity change is never "stricter") | same |
| `userAgentMode` | `strict` > `identify` > `plugin` | same |
| `stripClientHints`, `adaptiveThrottle`, `retryJitter`, `respectRetryAfter`, `blockPrivateNetworks` | `true` | same |
| `retryOnNetworkError` | `false` | same |
| `proxyRotation` | equal only — or `off` while no proxy list is configured (`EVER_JOBS_CRAWL_PROXIES` / `DEFAULT_PROXIES` empty: `off` then changes nothing on the wire). A different rotation is a different origin for the host, and under a site owner's lock the origin is not the caller's to change (below). `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=ranked`: `off` < `per-host` < `per-scrape` < `per-request`, accept ≤ base (round 1) | `off` = `per-host` > `per-scrape` > `per-request` |
| `rateLimitScope` | equal, or `host` → `domain` only (the new bucket must contain the base one; `site` next to `domain` would be a second, parallel bucket) | `domain` = `site` > `host` |
| `maxConcurrentPerHost` | lower (`0` = unlimited = refused unless the base is `0`) | same |
| `minIntervalMs`, `jitterMs`, `retryBaseDelayMs`, `retryMaxDelayMs`, `minGapMs`, `serverErrorCooldownMs` | higher | same |
| `throttleRetryDelayMs` | higher (`0` = no floor = least strict) | same |
| `retries` | lower | same |
| `retryStatuses` | keeps every `429`/`503` of the base; may drop other statuses; may add only `429`/`503` | a subset |
| `retryBackoff` | `exponential` > `linear` > `constant` | same |
| `retryAfterOverMax` | `give-up` > `cap` | same |
| `maxRetryAfterMs` | anything under `give-up`; higher under `cap` | same |
| `robotsTxt` | `respect` > `crawl-delay` > `off` | same |
| `maxQueueWaitMs` | always (not a politeness knob) | same |
| `discovery` | equal, or `sitemap` (list pages cost a shared server more) | always |
| `callerOverrides` | never (a lock is not a caller's to set) | same |

**`proxyRotation` never moves a locked host to another origin** (Spec 1715 review round 2).
The round-1 order called `off` the strictest rotation, so under the Softy lock a caller
could send `crawl: {"proxyRotation":"off"}` (directly, or through JSON-LD on a Softy page)
and, with `EVER_JOBS_CRAWL_PROXIES` set, its Softy requests left from the server's own
IP while every other Softy request used the operator's pinned proxy — two origins, against
Softy's ask for a stable one. By default (`EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=base`)
a `stricter` caller may only repeat the resolved rotation; `off` is accepted only while
no proxy list is configured (then every rotation is the same direct connection). `ranked`
restores the round-1 order; `EVER_JOBS_CRAWL_STRICTER_RULES=1690` keeps the Spec 1690
order whatever this says. A plugin's own proxy list is not seen by the resolver: only the
operator's list counts as "configured".

**Beyond the policy fields**, two request values follow the same effective mode:

- **`requestTimeout`** (the flat DTO field, seconds). A tiny timeout abandons a request
  client-side while the server still renders it, so the next paced request overlaps it.
  Under `stricter` only a value ≥ the default (60 s) is accepted, otherwise the default
  is used; under `none` it is ignored; under `any` it passes unchanged. The helper is
  `gateCallerRequestTimeout` (`@ever-jobs/common`); rules `1690` leave it ungated.
  `JobsService` applies it once per source, with the source's mode. Since Spec 1715
  (review C0) `HttpClient` also applies it **per request host**: a caller's timeout on a
  request to a locked host such as `acme.softy.pro` goes out as 60 s even when an
  unlocked plugin makes the request, while requests to other hosts keep the caller's
  value, unchanged. And a caller's timeout shorter than 60 s that fires never counts as
  a struggling server — it cools no bucket (`serverErrorCooldownMs`, §11), so a caller
  cannot put a host into a cool-down by asking for a tiny timeout. `HttpClient` treats a
  timeout as the caller's when a client took it from the search DTO
  (`createHttpClient(input)`), or when it equals the scrape context's
  `callerRequestTimeout` (seconds); a plugin's own timeout is never touched. Rules
  `1690` (the `legacy` default) switch both parts off. `JobsService` fills
  `callerRequestTimeout` with the site-gated value for every scrape (Spec 1714 T26), so
  a plugin that copies `requestTimeout` into its own `timeout` option (JSON-LD does) is
  covered too: `jsonld` pointed at a `*.softy.pro` page with `requestTimeout: 0.001`
  sends the 60 s default.
- **The request's `proxies`.** For a source or host whose effective mode comes from a
  site owner's lock, caller proxies are used only when that mode is `any` **and**
  `EVER_JOBS_CRAWL_CALLER_PROXIES` allows them; for one where the operator set
  `callerOverrides`, exactly when that value is `any`; otherwise
  `EVER_JOBS_CRAWL_CALLER_PROXIES` decides, as before. Refused caller proxies are
  dropped for that plugin (in `JobsService`) and for requests to that host by any plugin
  (in `HttpClient`, `crawlCallerProxiesAllowedFor`); the operator's env proxies still
  apply.

Under every mode, a client's `minIntervalFloorMs` (§9, §19) is a spacing no caller
value shortens: a plugin that must keep a site's `Crawl-delay` or a designed pace sets it.

Refused fields are reported by the policy endpoint's `crawl=` preview (§17) and, during
a search, dropped with a warning.

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
| `proxies` | the proxy list (§10), unless `EVER_JOBS_CRAWL_CALLER_PROXIES=none` or a site owner's lock refuses them (§7.2) |
| `requestTimeout` (s) | not a policy field; gated by the effective mode (§7.2): ≥ 60 s under `stricter`, ignored under `none` |

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

**Set a contact if you run Ever Jobs against sites you do not own.** Every installation
sends the same default UA, so without `EVER_JOBS_CRAWL_CONTACT` / `EVER_JOBS_CRAWL_FROM`
a site operator can tell which project is calling but not which installation, nor whom to
write to. The link in the UA leads to the README's
[For website operators](../README.md#for-website-operators) section: what the UA means,
the default pace, that many people run their own copy, how to reach the project, and how a
site can get a site-owner policy like Softy's (§6.4, §21).

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
pre-1690 random browser UA pool. Their navigations are paced and guarded too (§20).

**Send a browser UA to one site only:**

```json
{ "sites": { "somesite": { "userAgent": "browser", "userAgentMode": "strict" } } }
```

(`browser` expands to the pre-1690 Chrome/120 UA; any literal string works too.) The
live A/B behind these defaults is in [Q-097](./questions.md).

---

## 9. Pacing

One process-wide limiter counts every request made through `HttpClient` — and every
browser navigation made through `BrowserPool.navigate` (§20) — whichever plugin makes
it, against a **bucket**:

| `rateLimitScope` | Bucket | Use when |
|---|---|---|
| `host` (default) | exact hostname, e.g. `acme.softy.pro` | most sites |
| `domain` | registrable domain (Public Suffix List), e.g. `softy.pro` | multi-tenant platforms where every tenant is one server |
| `site` | the plugin's `Site`, whatever hosts it touches | a source spread over several hosts |

A request starts when fewer than `maxConcurrentPerHost` are in flight (0 = unlimited),
at least `minIntervalMs` (× the adaptive slow-down) plus `random(0..jitterMs)` after the
previous start in the bucket, at least `minGapMs` after the previous request of the
bucket **completed**, and the bucket is not cooling down. Waiters are served
first-in first-out. **Every attempt, retries included, holds a slot.**

- **Idle gap after completion** (`minGapMs`, Spec 1714; default `0` = none, as before).
  `minIntervalMs` is measured start to start, so a server that takes 1.5 s per page
  under a 1 s interval gets the next request the moment it answers — it is never idle.
  With `minGapMs: 500` the next start is at least 0.5 s after the answer: 1 s interval,
  1.5 s answers → starts 2 s apart. Softy runs with 500 ms (§6.4).

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
  requests in flight. Size per-host limits for the replica count you run — or set
  **`EVER_JOBS_CRAWL_FLEET_SIZE=N`** (Spec 1714; default `1`, bounded 1–1000) on every
  process sharing one egress IP: each multiplies its start-to-start spacing
  (`minIntervalMs`, a robots.txt `Crawl-delay`, a client's `minIntervalFloorMs`) and
  its `minGapMs` by N, so together they stay within one policy (3 processes and a 1 s
  policy → each spaces its own starts 3 s apart). Jitter, cool-downs and concurrency
  are not multiplied. The value is shown as `meta.fleetSize` (§17). Cool-downs
  (`Retry-After`, server errors) are still per process — a shared, Valkey-backed state
  is a follow-up ([Q-122](./questions.md)).
- The limiter spaces *grants*: under a burst, the first gap between wire starts can be
  a few ms shorter than `minIntervalMs` (measured 86–90 ms for 100 ms).
- **A client floor** (`createHttpClient({ minIntervalFloorMs })`, milliseconds): the
  limiter spaces that client's requests by max(`minIntervalMs`, robots.txt `Crawl-delay`,
  floor), whatever any layer resolved — like a `Crawl-delay`, and unlike `rateDelayMin`,
  which is only the plugin layer. Jitter still follows the policy.
- **Redirect hops are paced by the hop's own policy** (Spec 1715 review A0,
  `EVER_JOBS_CRAWL_PACE_REDIRECTS`, default `true`). axios follows a `3xx` inside the
  slot the first request was granted, so before this change an aggregator link that
  answered `302` to `https://acme.softy.pro/offers/123` reached Softy under the
  aggregator's bucket — no 1 s interval, no lock, the aggregator's proxy. Now a hop is
  **re-issued as a request of its own** when its host carries a host-owned policy (a
  builtin or operator `hosts` entry with a caller lock or `rateLimitScope: 'domain'`,
  e.g. `*.softy.pro` — so also a same-host hop there, like `/offres` → `/offers`), or
  when it falls in a different bucket than the request **and** the request or the hop is
  under a caller lock (effective mode `stricter` / `none`). A source without a lock
  (the global `any`, no host-owned policy on the way) follows every hop inside its slot,
  through its proxy, exactly as before Spec 1714 (review round 2: re-issuing its
  cross-host hops gave the hop a second proxy pick — a new egress IP mid-chain, which
  breaks sites that tie a session cookie set during the chain to the client IP). The re-issued hop gets everything a request
  gets except the memo (below): robots.txt of its origin, the lock, its proxy pick, its own
  limiter slot, the cool-down check and its retries. The redirect answer itself is
  recorded as that slot's outcome. What follow-redirects would have changed is kept: a
  `301`/`302` `POST` or a `303` becomes a `GET` without a body, the headers it drops
  (`Content-*` with the body; `Cookie`, `Authorization` and `Proxy-Authorization` on a
  hop to another domain) stay dropped, axios `auth` is dropped on a hop to another
  origin, and the request's `crawl` override goes with the hop. The
  whole chain is capped at the request's `maxRedirects` (unset: 21, the follow-redirects
  default axios uses), with the same `ERR_FR_TOO_MANY_REDIRECTS` past it. A re-issued
  hop never answers from the multi-location memo (Spec 1700): the request that started
  the chain holds the memo entry for the whole chain, and a loop (A → B → A, or a
  same-URL bounce on a host-owned policy) would otherwise find its own ancestor's entry
  pending and wait on itself until the search deadline. Other hops are followed in the
  slot as before, and so is a `307`/`308` hop whose body cannot be sent again (a
  stream); `maxRedirects: 0` is untouched. The redirect pin and the egress guard still check every hop first (§13).
  `false` (the `legacy` default) = the pre-fix in-slot follow.

  **Known limitation — browser navigations** (review of PR #105). The switch covers
  `HttpClient` only. `BrowserPool.navigate` (§20) resolves the policy of the URL it was
  given and `page.goto` follows every redirect inside that one slot: a vanity careers URL
  answering `302` to `https://acme.softy.pro/offers/123` reaches Softy under the first
  host's bucket, lock and pacing, and a `429` / `503` / `5xx` of the page that finally
  answered cools the first host's bucket, not `domain:softy.pro`. It is not fixed because
  Playwright calls a `page.route` handler only for the first URL of a redirect chain, so a
  hop cannot be held back; stopping at the `3xx` would mean fetching every navigation
  outside the browser (`route.fetch` with `maxRedirects: 0`: another TLS / HTTP stack,
  other cookie and cache handling — a change for every browser source, unlocked ones
  included) or a Chromium-only CDP session. No Softy code path navigates a browser: the
  Softy plugin, JSON-LD and liveness probes all go through `HttpClient`.

---

## 10. Proxies

The proxy list for a request is the first non-empty of: the search request's `proxies`
(unless `EVER_JOBS_CRAWL_CALLER_PROXIES=none`), `EVER_JOBS_CRAWL_PROXIES`,
`DEFAULT_PROXIES` (unless `EVER_JOBS_CRAWL_DEFAULT_PROXIES_FALLBACK=false`), else none —
in which case axios still honours `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`. An entry of
`localhost` (or an empty entry) means "direct".

| `proxyRotation` | Behaviour |
|---|---|
| `per-host` (default) | the same proxy for the same bucket, process-wide and across restarts (stable hash) — each site sees one origin. Under a caller lock (effective mode `stricter` / `none`) or on a host whose builtin policy carries a site owner's lock (`*.softy.pro`, even after an operator unlocked callers there), when the scope resolved **without the caller** is `domain`, the pick keys on the registrable domain, so a caller choosing `host` scope can never split one site's tenants across proxies (Spec 1714; `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE=bucket` restores the pre-1714 pick by the request's bucket). Every other request — a source without a lock under `any`, a bulk-API builtin host included — keeps the pre-1714 pick byte for byte (Spec 1715 review C3) |
| `per-scrape` | one proxy for the whole scrape — every client the plugin uses (e.g. a token client and a data client) keeps the same origin; successive scrapes are spread over the list. A client used outside any search keeps one proxy per client |
| `per-request` | round-robin on every request (pre-1690) |
| `off` | never use a proxy, even when a list is supplied |

A proxy that is not one of the operator's env proxies (e.g. a caller's) is itself
egress-checked (§13). The policy endpoint shows only how many env proxies exist, never
the list (it may carry credentials).

**Caller proxies under a lock** (Spec 1714). For a host whose effective caller-override
mode refuses caller proxies (§7.2 — e.g. every `*.softy.pro` host on a default install),
`HttpClient` skips both the scrape context's caller proxies and the proxies a plugin
handed over from the search DTO (`createHttpClient(input)`), whichever plugin makes the
request; a plugin's own proxy list and the operator's env proxies still apply.

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
  `HostCoolingDownError` (diagnostic `rate_limited`; the server's answer is its
  `cause`) — whether or not a retry was left, so also with `retries: 0` and on the
  last attempt.
- **> `maxRetryAfterMs`**, `cap` → wait `maxRetryAfterMs`, then retry (pre-1690).

**A `429`/`503` never gets a fast retry** (`throttleRetryDelayMs`, default 5 s). With
full jitter the first back-off is anywhere in 0–1 s, and many servers send `429`/`503`
without a `Retry-After` — retrying a throttling answer that quickly is retrying *faster*
instead of backing off. So for a `429` or `503`, retry *n + 1* waits at least
`throttleRetryDelayMs × 2^n`, capped at `max(retryMaxDelayMs, throttleRetryDelayMs)`:
with the defaults 5 s, then 10 s (20 s, 30 s, 30 s… with more retries); `strict` waits
30 s every time. The floor is never less than the normal back-off, and a `Retry-After`
within `maxRetryAfterMs` still wins when it is longer (`max(floor, back-off,
Retry-After)`); over `maxRetryAfterMs` the rules above are unchanged (`cap` never waits
less than the floor). Other retryable answers (`502`, `504`, network errors) keep the
plain back-off. `0` turns the floor off — the `legacy` preset's value.

**At most 10 retries** (`MAX_CRAWL_RETRIES`). A `retries` above 10 is clamped to 10 at
every layer — environment (`EVER_JOBS_CRAWL_RETRIES`, `RETRY_DEFAULT_RETRIES`), operator
policy, plugin manifest or options, and the pre-1690 flat `retries` field — with a
warning (startup log / `warnings` of §17); the `crawl.retries` of a REST, GraphQL or MCP
search is rejected (`400`) above 10.

**Never a tight retry loop.** When the configured back-off would leave less than
**100 ms** before a retry (`retryBaseDelayMs` or `retryMaxDelayMs` `0`, or a base of a few
ms), that retry waits 100 ms; a normal back-off keeps its full jitter. The `legacy`
preset keeps the pre-1690 behaviour (a 0 ms back-off retries at once).

Any `429`/`503` in a paced bucket also cools **the whole bucket** — not just the request
that got it — for the same wait (so at least the floor), and feeds the adaptive throttle.
A throttle floor counts as pacing: with `throttleRetryDelayMs > 0` the bucket is cooled
even when concurrency, interval and adaptive throttle are all off. This includes a `429`
your code accepted through `validateStatus` (it is not retried, but it still counts).

**A struggling server cools the bucket too** (`serverErrorCooldownMs`, Spec 1714;
default `0` = off, as before). A `500`, `502` or `504`, a timeout (`ECONNABORTED`,
`ETIMEDOUT`, `ESOCKETTIMEDOUT`, `ERR_SOCKET_CONNECTION_TIMEOUT`,
`UND_ERR_CONNECT_TIMEOUT`) or a connection reset (`ECONNRESET`, `UND_ERR_SOCKET`,
"socket hang up") cools the **whole bucket** for `serverErrorCooldownMs` — before any
retry sleep, so a retry waits for it as well — whether the answer was thrown, accepted
through `validateStatus`, or a browser navigation (§20). Never our own abort, a
crawl-policy refusal or a DNS failure — and never a timeout that was the search caller's
own `requestTimeout` below 60 s (Spec 1715 review C0, §7.2: the caller aborted, the
server did not struggle; a reset under such a timeout still counts). A `503` is a
throttle answer and keeps the rules above. Softy runs with 30 s (§6.4); set it per host
where a server's `5xx` means "too much load".

**A failed request records its cool-down before it frees its slot** (review of PR #105,
`EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE`, default `locked`). Freeing a slot lets the
limiter grant the next queued request at once; a request that failed used to free its
slot first and only then record the failure, so a request queued behind a `429`, a `503`
or a struggling server could be granted — and sent — inside the very cool-down being set
(the grant is never taken back). With `locked`, a request under a lock — a caller lock,
or a site owner's builtin host lock such as `*.softy.pro`, whichever plugin sends it —
records the outcome, the back-off, the `Retry-After` hold and `serverErrorCooldownMs`
first, then frees its slot: the queued request waits for the cool-down, or fails with
`HostCoolingDownError` when that is longer than it may wait. Every other request frees
the slot first, as before (an unlocked source keeps its pacing byte for byte); `all`
applies the order to every request, `off` (the `legacy` default) restores the old order
everywhere. A bucket with an idle gap (`minGapMs`, Softy's 500 ms) was already safe: the
next grant waits for the gap, and the limiter re-checks the cool-down when it wakes.

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
for the strict RFC 9309 reading).

**Its answer feeds the limiter like any request** (Spec 1714,
`EVER_JOBS_CRAWL_ROBOTS_BACKOFF`, default `true`): a `429`/`503` throttles and cools the
bucket, so the page request waits; a `Retry-After` over `maxRetryAfterMs` cools the bucket
for the full time and fails the page request with `HostCoolingDownError` (nothing else is
sent, and the failure is not cached as the site's robots.txt); a `5xx`, timeout or reset
applies `serverErrorCooldownMs`. `EVER_JOBS_CRAWL_ROBOTS_BACKOFF=false` restores the
pre-1714 behaviour, where the robots.txt answer never touched the limiter. A redirect
hop re-issued under its own policy (§9) is checked against **its** origin's robots.txt
like any request; a hop followed in the slot is not (as before). Downloads are capped at 2 MiB and parsing at
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
`EgressBlockedError`. Browser navigations get the literal check and a best-effort DNS
check (§20). This closes, for every plugin at once, the class of SSRF found in
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
`getAxiosInstance()`, egress guard on or off). Only after these checks does redirect
pacing (§9) decide whether the hop is followed in the slot or re-issued; a refused hop is
refused either way. `EVER_JOBS_HTTP_PIN_REDIRECTS=false` turns only the pin
off (the escape hatch should a pinned site start redirecting somewhere legitimate).

---

## 14. Discovery modes

`discovery` selects the strategy of plugins that have more than one. Today that is
Softy ([Spec 1691](../.specify/specs/1691-softy-sitemap-discovery/spec.md)):

| Mode | Softy behaviour |
|---|---|
| `sitemap` | GET `/sitemap.xml`, take the `/offers/{ID}` entries newest `lastmod` first (one per offer id), fetch just enough detail pages, **one after another** |
| `listing` | GET `/offers?page=1..N` (21 cards per page) and parse the cards; the legacy `/offres` markup is still understood; detail pages per `descriptionDepth` |
| `auto` (default) | `sitemap`; list pages only when the sitemap answered `2xx` but held no offer URL or could not be parsed (`SOFTY_SITEMAP_FALLBACK=empty`, Spec 1715 — never after a `5xx`, `403`, `429`, a timeout or an unknown tenant; §21); `listing` straight away when no detail pages are wanted (`descriptionDepth: board`, unless an operator chose `sitemap` — one list page carries 21 offers, fewer requests than the sitemap plus a detail page per offer); a detail budget smaller than `resultsWanted` stays on the sitemap under the Softy lock and returns what the budget allows with a `partial` note (Spec 1715 review A1) — list pages only when the operator chose `auto`, lifted the lock, set `SOFTY_MAX_DETAIL_FETCHES=0`, or `SOFTY_LEGACY=caller-listing` (§21.3) |

Detail pages are cached by `url|lastmod`, so a repeat search only re-reads offers that
changed. Set per request (`crawl.discovery`), per operator site/host, or globally
(`EVER_JOBS_CRAWL_DISCOVERY`). Plugins with one strategy ignore it. A caller of a locked
source (Softy) may only choose `sitemap` (§7.2); the operator may choose anything.

---

## 15. Search deadline, circuit breaker, liveness

- **Deadline abort.** When the search deadline (`EVER_JOBS_SEARCH_DEADLINE_MS`, 120 s)
  abandons a slow source, its queued requests leave the queue and its in-flight requests
  are cancelled — no orphan traffic after we stopped listening.
  `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false` restores the old detached behaviour.
- **Circuit breaker.** A scrape we aborted at the deadline counts as neither a failure
  nor a success (it says nothing about the source's health). The breaker now tracks up
  to `EVER_JOBS_CIRCUIT_MAX_SITES` sites (4,096; was a hard 250, so most of the ~1,850
  sources could never trip). Since Spec 1714 a scrape that **resolves** with 0 jobs and a
  `rate_limited` or `blocked` diagnostic counts as a failure (the result is still
  returned): a plugin that turns push-back into an empty answer (Softy does) can now
  trip the breaker. `EVER_JOBS_BREAKER_COUNT_REFUSALS=false` restores the pre-1714
  behaviour.
- **Multi-location searches** stop asking a source that pushed back: a `rate_limited`,
  `blocked`, or (Spec 1714) a `503` — thrown, or a `fetch_error` naming it — marks the
  remaining locations of that source "not attempted". `EVER_JOBS_SEARCH_STOP_ON_503=false`
  restores the pre-1714 handling of a `503`. Plugins report the most telling error with
  `preferRefusalError` (`@ever-jobs/models`): a throttle or refusal wins over an earlier
  plain `5xx`.
- **Liveness enrichment** runs its probes under the pseudo-site `liveness-http`, with
  the global policy but not the search caller's `crawl` (a caller's `retries` would
  override the checker's one-shot probes). Tune it with
  `EVER_JOBS_CRAWL_POLICIES='{"sites":{"liveness-http":{…}}}'`; a batch is bounded by
  `EVER_JOBS_LIVENESS_DEADLINE_MS` (60 s), after which unfinished probes are
  `uncertain`. Since Spec 1714 its probes of a host with a builtin or operator host
  policy run under **that host's** policy (e.g. `*.softy.pro`: one bucket for all
  tenants, 1 in flight, 1 s + 0.5 s idle, one proxy; §6.4), and a job whose plugin
  fetched its page during this request (`jobUrlFetchedAt`, not older than the request
  start and not later than now — a future time is probed, like a future listing time;
  never on a search-cache hit) is marked `active` with `reason: "fresh-fetch"`
  instead of being probed again (`EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` probes
  every URL, as before).
- **Liveness on every output path, and the probe cap.** The fresh-fetch trust applies
  to JSON, CSV and `?format=ndjson` (Spec 1721) alike; the NDJSON stream measures
  "this request" from its own start, taken before the cache lookup, and trusts
  nothing on a cache hit. `EVER_JOBS_LIVENESS_MAX_URLS` (Spec 1723, default 100)
  caps the probes actually sent: a job marked `fresh-fetch` (or `listed`, below) costs
  no probe and does not count, so the cap takes the first N of the jobs still needing
  one. With both trusts switched off the cap takes the first N jobs in output order, as
  in Spec 1723.
- **A recent listing counts as evidence too** (Spec 1715 review A3). A repeat search is
  often served from the Softy sitemap cache (10 min), the detail cache and the search
  cache, costing Softy nothing — but `?liveness=true` then probed every offer again, at
  Softy's pace (one a second at most). Now a job carries `jobUrlListedAt` when its source took it from
  its own index — the instant that index (Softy: the tenant's `/sitemap.xml`) was fetched
  from the network, by this search or by an earlier one whose answer the source still
  caches; the ROOT sitemap's answer time for a sitemap index, so it never overstates
  freshness. A job whose `jobUrlListedAt` is at most
  `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` (default 600,000 = 10 min, the sitemap
  cache TTL) before **now** is marked
  `{ "state": "active", "checkedAt": <jobUrlListedAt>, "reason": "listed" }` without a
  probe. The age is measured against now, not the request start, so a search-cache hit
  is trusted as long as the listing is young enough (JSON, CSV and NDJSON alike). A fresh
  fetch still wins (`fresh-fetch`); a listing time in the future or unparseable is not
  trusted (the job is probed). `0` (the `legacy` default) turns it off; probing every URL
  needs both `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` and this at `0`. A Softy list
  page is an index too (review round 2): posts read from list pages or the legacy index
  carry the instant that page answered (list pages are never cached), so
  `descriptionDepth: "board"` — which keeps the listing (§21) — no longer costs a probe per
  card right after the page that listed it (`SOFTY_LEGACY=listing-no-listed-at` = the
  old behaviour).
  `EVER_JOBS_LIVENESS_ENABLED=false` still withholds every verdict.

---

## 16. Reproducing the pre-1690 behaviour

**All of it:** `EVER_JOBS_CRAWL_PRESET=legacy`, plus the few settings listed after it.

What `legacy` restores by itself (the `legacy` column of §3):

- **The crawl policy:** the Chrome/120 UA with the pre-1690 precedence (a request's own
  UA header, else the client's `userAgent` option, else Chrome/120; UAs set through
  `setHeaders()` never reach the wire — exactly the old client), per-request proxy
  rotation with `DEFAULT_PROXIES` ignored, no policy pacing (0 = unlimited in flight, no
  interval, no adaptive throttle, no idle gap, no server-error cool-down), 3 linear
  retries on `429,500,502,503,504` without jitter, no `429`/`503` floor and no 100 ms retry
  minimum, `Retry-After` capped at the retry ceiling and retried, no whole-bucket
  back-off, no egress guard, robots.txt off.
- **The layers above the preset are off:** no builtin host policies (neither the bulk-API
  limits nor `*.softy.pro`) and no plugin manifests — so no site-owner lock either; the
  caller-override mode is the global one.
- **Browser pages:** the pre-1690 UA pool (a random entry for stealth pages, the first
  entry otherwise) and a plain `page.goto`.
- **The Spec 1714 / 1715 switches, when unset** (Spec 1715 review F7):
  `EVER_JOBS_CRAWL_STRICTER_RULES=1690` (the Spec 1690 comparators, `requestTimeout`
  ungated in `JobsService` and `HttpClient`), `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE=bucket`,
  `EVER_JOBS_CRAWL_ROBOTS_BACKOFF=false`, `EVER_JOBS_CRAWL_PACE_REDIRECTS=false`,
  `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=ranked`, `EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE=off`, and the API switches `EVER_JOBS_BREAKER_COUNT_REFUSALS=false`, `EVER_JOBS_SEARCH_STOP_ON_503=false`,
  `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false`, `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS=0`.
  An explicit value of any of them still wins over the preset.

What `legacy` does **not** restore — set these as well:

| Behaviour | Setting |
|---|---|
| requests keep running after the search deadline | `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false` |
| the breaker tracks 250 sites | `EVER_JOBS_CIRCUIT_MAX_SITES=250` |
| a plugin's own client options and settings | they are not crawl-policy layers, so no preset touches them. A client's `minIntervalFloorMs` (§9) still spaces that plugin's requests. Each plugin names its own switch — Softy: `SOFTY_LEGACY=all` (every token, the 1 s client floor included: `no-interval-floor`) plus `SOFTY_SITEMAP_FALLBACK=any-error`, `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES=3`, `SOFTY_DETAIL_ATTEMPT_SLACK=100`, `SOFTY_SITEMAP_CACHE_TTL_MS=0`, `SOFTY_DETAIL_CACHE_TTL_MS=21600000`, `SOFTY_UNKNOWN_TENANT_TTL_MS=0` (§21.4); others, e.g. `EVER_JOBS_REMOTEOK_LEGACY`, `WTTJ_USER_AGENT_MODE`, in their own docs |
| Softy's list pages (pre-1691) | `"sites": {"softy": {"discovery": "listing"}}` |

`EVER_JOBS_CRAWL_FLEET_SIZE` already defaults to `1`, the pre-1714 behaviour.

**One piece at a time** (on top of `polite`):

| Old behaviour | Setting |
|---|---|
| browser UA | `EVER_JOBS_CRAWL_USER_AGENT=browser` (+ `EVER_JOBS_CRAWL_USER_AGENT_MODE=strict` to also override plugin opt-ins) |
| plugins' own UAs sent, pool UA for browser pages | `EVER_JOBS_CRAWL_USER_AGENT_MODE=plugin` (not for Softy, whose manifest pins `identify` since Spec 1715: add the Softy row below) |
| no pacing | `EVER_JOBS_CRAWL_MAX_CONCURRENT_PER_HOST=0`, `EVER_JOBS_CRAWL_MIN_INTERVAL_MS=0`, `EVER_JOBS_CRAWL_ADAPTIVE=false`, `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`, `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false` |
| round-robin proxies | `EVER_JOBS_CRAWL_PROXY_ROTATION=per-request` |
| `DEFAULT_PROXIES` unused | `EVER_JOBS_CRAWL_DEFAULT_PROXIES_FALLBACK=false` |
| old retries | `EVER_JOBS_CRAWL_RETRIES=3`, `EVER_JOBS_CRAWL_RETRY_STATUSES=429,500,502,503,504`, `EVER_JOBS_CRAWL_RETRY_BACKOFF=linear`, `EVER_JOBS_CRAWL_RETRY_JITTER=false`, `EVER_JOBS_CRAWL_MAX_RETRY_AFTER_MS=30000`, `EVER_JOBS_CRAWL_RETRY_AFTER_OVER_MAX=cap`, `EVER_JOBS_CRAWL_THROTTLE_RETRY_DELAY_MS=0` |
| no egress guard | `EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS=false` |
| browser pages navigate outside the policy | `EVER_JOBS_CRAWL_BROWSER_NAVIGATION=false` |
| requests keep running after the deadline | `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false` |
| breaker tracks 250 sites | `EVER_JOBS_CIRCUIT_MAX_SITES=250` |
| Softy's old browser UA | `"sites": {"softy": {"userAgentMode": "plugin"}}` |
| Softy list pages only | `"sites": {"softy": {"discovery": "listing"}}` |

**Undoing Spec 1714, piece by piece** (each new behaviour has its switch; the new
policy fields default to the old behaviour already):

| Pre-1714 behaviour | Setting |
|---|---|
| the Spec 1690 `stricter` comparators (and an ungated `requestTimeout`, in `JobsService` and per host in `HttpClient`; a caller's short timeout counts as a struggling server again) | `EVER_JOBS_CRAWL_STRICTER_RULES=1690` |
| `per-host` proxy pick by the request's bucket, even under a lock | `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE=bucket` |
| robots.txt answers never touch the limiter | `EVER_JOBS_CRAWL_ROBOTS_BACKOFF=false` |
| every redirect hop followed inside the first request's slot (a source without a lock already is; this also covers host-owned policies and locked cross-bucket hops) | `EVER_JOBS_CRAWL_PACE_REDIRECTS=false` |
| a `stricter` caller may pick any `proxyRotation` at least as far down the round-1 order (`off` < `per-host` < `per-scrape` < `per-request`), `off` included while proxies are configured | `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=ranked` (Spec 1715 review round 2; with `EVER_JOBS_CRAWL_STRICTER_RULES=1690` the Spec 1690 order applies instead) |
| a failed request frees its slot before its cool-down is recorded (a queued request may start inside it), under a lock too | `EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE=off` (review of PR #105; a source without a lock already does under the default `locked`) |
| no idle gap / no server-error cool-down | `EVER_JOBS_CRAWL_MIN_GAP_MS=0`, `EVER_JOBS_CRAWL_SERVER_ERROR_COOLDOWN_MS=0` (the defaults; Softy's come from §6.4 and its manifest — see the recipe below) |
| each process paces as if alone | `EVER_JOBS_CRAWL_FLEET_SIZE=1` (the default) |
| a nested sitemap's `429`/`503` is skipped and the walk goes on | Softy: `SOFTY_LEGACY=nested-skip` (or `SOFTY_SITEMAP_FALLBACK=any-error`), which also skips a nested `5xx` / timeout (§21.1); another plugin: `fetchSitemap(…, { nestedErrors: 'skip' })` (plugin code) |
| a `503` does not stop the other locations of a search | `EVER_JOBS_SEARCH_STOP_ON_503=false` |
| a refused empty result is a breaker success | `EVER_JOBS_BREAKER_COUNT_REFUSALS=false` |
| liveness probes every URL | `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` **and** `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS=0` |
| callers may change every Softy field | `{"sites":{"softy":{"callerOverrides":"any"}},"hosts":{"*.softy.pro":{"callerOverrides":"any"},"softy.pro":{"callerOverrides":"any"}}}` **plus `SOFTY_LEGACY=no-interval-floor`** (the Softy client's 1 s floor, which no policy layer lifts, §6.4) — or, more bluntly, `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false` plus `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` (every manifest and builtin host off), again with `SOFTY_LEGACY=no-interval-floor` |
| liveness and other plugins reach `*.softy.pro` under the generic defaults | `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE=*.softy.pro,softy.pro` (Spec 1715 review F3; the bulk-API builtin limits stay, as before Spec 1714). `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` is **not** the same: it also drops the Greenhouse / Lever / Ashby / SmartRecruiters limits that predate Spec 1714 |
| the Softy crawl policy of before Spec 1715 | the recipe below |
| the Softy plugin's pre-1715 behaviour | `SOFTY_LEGACY=all` plus the values in §21.4 |

**The pre-1715 Softy crawl policy** (Spec 1715 review F5). Before Spec 1715 the Softy
manifest was `{ "rateLimitScope": "domain", "maxConcurrentPerHost": 1, "minIntervalMs": 1000 }`;
every other field came from the preset and the environment, other plugins reached Softy's
hosts under the generic defaults, the client had no spacing floor, and callers were not
locked out. The manifest and the builtin host entry now pin those other fields above the
environment (§6.4), so bringing them back takes an operator entry:

```bash
# Other plugins and liveness probes: the generic defaults again (Greenhouse & co keep theirs).
EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE='*.softy.pro,softy.pro'
# The Softy client's own 1 s floor (not a policy layer).
SOFTY_LEGACY=no-interval-floor
# The Softy plugin: the 1691 manifest fields stay; the rest back to the polite preset's values.
EVER_JOBS_CRAWL_POLICIES='{"sites":{"softy":{
  "callerOverrides":"any",
  "minGapMs":0,"serverErrorCooldownMs":0,
  "retries":2,"retryStatuses":[429,502,503,504],"throttleRetryDelayMs":5000,
  "respectRetryAfter":true,"retryAfterOverMax":"give-up",
  "proxyRotation":"per-host","userAgentMode":"identify"}}}'
```

The values shown are the `polite` preset's. Put in the ones your preset and environment
give every other source instead — e.g. `EVER_JOBS_CRAWL_RETRIES=4` → `"retries": 4`,
`EVER_JOBS_CRAWL_USER_AGENT_MODE=plugin` → `"userAgentMode": "plugin"` (Softy's old browser
UA), `strict` → `"retries": 1, "retryStatuses": [429,503], "throttleRetryDelayMs": 30000,
"userAgentMode": "strict"` — because an operator entry pins them for Softy whatever the
environment says later. Drop `"callerOverrides": "any"` to keep the lock. To give Softy's
hosts these values for **every** plugin while keeping their pacing (1 in flight, 1 s, one
bucket), leave the builtin entries on and put the same fields in `hosts["*.softy.pro"]`
and `hosts["softy.pro"]` instead of `sites.softy`: a host entry covers the Softy plugin
and every other plugin that reaches those hosts. The Softy plugin's own pre-1715
decisions (sitemap fallback, push-back stops, caches…) are separate: `SOFTY_LEGACY=all`
and the §21.4 values.

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
  "minGapMs": 500,
  "serverErrorCooldownMs": 30000,
  "retries": 1,
  "discovery": "auto",
  "provenance": {
    "userAgent": "preset",
    "rateLimitScope": "plugin",
    "maxConcurrentPerHost": "plugin",
    "minIntervalMs": "plugin",
    "minGapMs": "plugin",
    "serverErrorCooldownMs": "plugin",
    "retries": "plugin"
  },
  "meta": {
    "preset": "polite",
    "callerOverrides": "stricter",
    "callerOverridesProvenance": "plugin",
    "globalCallerOverrides": "any",
    "builtinHostPatterns": ["*.softy.pro"],
    "builtinHostsDisabled": [],
    "clientMinIntervalFloorMs": 1000,
    "clientMinIntervalFloorSwitch": "SOFTY_LEGACY=no-interval-floor",
    "switches": { "stricterRules": "1714", "proxyPinScope": "base", "robotsBackoff": true, "paceRedirects": true, "callerProxyRotation": "base" },
    "proxyPin": { "scope": "base", "keyedOn": "domain" },
    "fleetSize": 1,
    "abortOnDeadline": true,
    "envProxyCount": 0,
    "plugin": { "rateLimitScope": "domain", "maxConcurrentPerHost": 1, "minIntervalMs": 1000, "callerOverrides": "stricter" },
    "operatorHostPatterns": []
  },
  "warnings": []
}
```

(Abridged: the real response lists every one of the 27 fields and its provenance.)
`meta.callerOverrides` is the **effective** caller-override mode of the request (§7.2),
`meta.callerOverridesProvenance` the layer that decided it (`default`, `env-global`,
`builtin-host`, `plugin`, `operator-site`, `operator-host`), `meta.globalCallerOverrides`
the `EVER_JOBS_CRAWL_CALLER_OVERRIDES` value, `meta.builtinHostPatterns` the builtin host
patterns applied (§6.4) and `meta.fleetSize` `EVER_JOBS_CRAWL_FLEET_SIZE` (§9; the
policy fields show the per-policy values, not the ones this process multiplied). Since
Spec 1715: `meta.builtinHostsDisabled` lists the builtin patterns
`EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE` switches off (whatever the host; a disabled
pattern never appears in `builtinHostPatterns`, and `warnings` notes each one skipped for
this host), and `meta.clientMinIntervalFloorMs` is the spacing floor, ms, that the
plugin's own HTTP client enforces NOW (`createHttpClient({ minIntervalFloorMs })`, §9):
what the plugin's `clientMinIntervalFloor()` in its `@SourcePlugin` metadata reads from
the plugin's own settings, else its declared `clientMinIntervalFloorMs`, or `null` when
there is none (review round 2: Softy reports `1000`, and `null` once
`SOFTY_LEGACY=no-interval-floor` removed it — the API used to show the declared `1000`
either way). `meta.clientMinIntervalFloorSwitch` names that switch. No policy layer
shortens that floor, so the top-level `minIntervalMs` can read lower than what goes on
the wire; only the plugin's own switch removes it, and like `minIntervalMs` it is
multiplied by `fleetSize`. Also since review round 2: `meta.switches` shows the
process-wide restore switches as they are in force — `stricterRules`
(`EVER_JOBS_CRAWL_STRICTER_RULES`), `proxyPinScope` (`_PROXY_PIN_SCOPE`), `robotsBackoff`
(`_ROBOTS_BACKOFF`), `paceRedirects` (`_PACE_REDIRECTS`), `callerProxyRotation`
(`_CALLER_PROXY_ROTATION`), `cooldownBeforeRelease` (`_COOLDOWN_BEFORE_RELEASE`), each at its
preset's default unless set, so after
`EVER_JOBS_CRAWL_PRESET=legacy` you can confirm each took its pre-1714 value — and
`meta.proxyPin` what the `per-host` proxy pick of this request keys on: `scope` is
`switches.proxyPinScope` under a caller lock or a site owner's builtin host lock, else
`bucket` (the pre-1714 pick), and `keyedOn` the rate-limit scope of the key (§10). The
boot-time config mirror (`crawl` in the app configuration) lists the same switches. Try
`/api/sources/liveness-http/crawl-policy?host=acme.softy.pro` to see the Softy policy
applied to another site (`callerOverridesProvenance: "builtin-host"`), and
`?crawl={"proxyRotation":"per-request","discovery":"listing"}` on `softy` to see both
fields refused in `meta.caller.rejected`.
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
  has its own limiter), raise its `throttleRetryDelayMs` (the minimum back-off and
  host cool-down after a `429`/`503`), or switch the bucket to `domain` scope.
- **A proxy is not used.** Check `proxyRotation` is not `off`, `EVER_JOBS_CRAWL_PROXIES`
  is not `none`, `EVER_JOBS_CRAWL_CALLER_PROXIES` for request proxies, and that
  `legacy` ignores `DEFAULT_PROXIES`. `envProxyCount` in §17 shows what the env gave.
  A request's own `proxies` are also dropped for a locked source or host (§7.2, §10).
- **A caller's `crawl` field is ignored for Softy** (or another locked source). That is
  the site owner's lock (§7.2): check `meta.callerOverrides` and
  `meta.callerOverridesProvenance` in §17. The operator can loosen it per site or host
  (§6.4).
- **A redirect now takes longer, or a redirected URL fails with a robots.txt or
  cool-down error.** The hop left the request's bucket (or reached a host-owned policy
  such as `*.softy.pro`), so it was sent as a request of its own under the target's
  policy (§9). `EVER_JOBS_CRAWL_PACE_REDIRECTS=false` restores the in-slot follow.
- **Softy returns nothing and the diagnostic says `rate_limited` / `blocked`.** The
  server pushed back and the plugin stopped at once (§21); the breaker may open after
  five such searches (§15). Wait, or check the tenant in a browser.

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
- **When the site's operator asked for a pace, lock it** (Spec 1714):
  `crawl: { …, callerOverrides: 'stricter' }` means a search caller may only make this
  source's traffic more polite (`'none'`: change nothing), even when the global
  `EVER_JOBS_CRAWL_CALLER_OVERRIDES` is `any`. It only tightens; the operator can loosen
  it per site or host (§7.2). If the pace belongs to the server rather than to your
  plugin (other plugins or liveness probes reach it too), propose a builtin host entry
  (§6.4) that matches the manifest, with a parity test.
- **Pace knobs for fragile servers:** `minGapMs` (idle time after each answer) and
  `serverErrorCooldownMs` (cool the bucket after a `5xx` or timeout) — §9, §11.
- **Report the most telling error:** keep a scrape's error with
  `run.error = preferRefusalError(run.error, err)` (`@ever-jobs/models`), so a `429` /
  `403` / crawl-policy refusal is not hidden behind an earlier `502`.
- **Tell the API a detail page is fresh:** set `jobUrlFetchedAt` (ISO time) on a job
  whose `jobUrl` your scrape just fetched from the network (2xx, parsed; never from a
  cache) — `?liveness=true` then skips probing it (§15). When the posting came from the
  site's own index (a sitemap), also set `jobUrlListedAt`: the instant that index was
  fetched from the network, kept with your index cache so a cache hit carries the
  original time (never the time of the hit); for a sitemap index, the root's answer time.
- **Declare a client floor:** when your plugin passes `minIntervalFloorMs` to
  `createHttpClient`, also declare it as `clientMinIntervalFloorMs` in `@SourcePlugin`,
  so the policy endpoint can show it (§17). The declaration is informational; the client
  option enforces it.
- **Build detail URLs as the site's final URL** rather than one that redirects: a hop is
  a second request, and on a host-owned policy it waits for its own slot (§9). Softy
  links `/offers/{ID}`, the target of the legacy `/offre/{ID}-{slug}` redirect.
- **Fetch detail pages of fragile sites sequentially** (`for (const url of urls) { await … }`),
  never an unbounded `Promise.allSettled` over hundreds of URLs. The limiter bounds
  concurrency per host, but a sequential loop also stops early on the first
  `HostCoolingDownError` or abort, and keeps partial results.
- **Do not set a browser UA.** It is recorded as *declared* and only sent in UA mode
  `plugin`. If an API genuinely requires a specific UA, declare it with `setHeaders`
  and opt in: `crawl: { userAgentMode: 'plugin', userAgentReason: '<why>' }` (the reason
  is shown by the policy endpoint; an opt-in without one is flagged in its `warnings`).
  An operator switch that brings back an older UA (`WTTJ_USER_AGENT_MODE=browser`,
  `EVER_JOBS_REMOTEOK_LEGACY=ua`) must add that opt-in on the clients it affects, or it
  does nothing under `identify`; `strict` still overrides it.
- **A pace a caller may only lengthen:** `rateDelayMin`/`rateDelayMax` on
  `createHttpClient` and a manifest `minIntervalMs` are the plugin layer, which operator
  and caller layers replace (a search's `rateDelayMin` under the default
  `EVER_JOBS_CRAWL_CALLER_OVERRIDES=any`). When a site asks for a minimum spacing (a
  robots.txt `Crawl-delay`, a documented rate) or your spec promises one, also pass
  `minIntervalFloorMs`: no layer shortens it. RemoteOK (1 s, its `Crawl-delay`), Welcome
  to the Jungle (0.5 s board pacing; 2 s between credential pages) and Simplify (2 s) do.
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
  by `url|lastmod`. A nested sitemap answering `429`/`503` or failing with a
  crawl-policy error stops the walk and is rethrown (`nestedErrors: 'stop-on-throttle'`,
  the default since Spec 1714; `'skip'` = report it to `onError` and go on, the pre-1714
  behaviour); `isSitemapStopError(err)` tells you why.
- **Browser pages:** pass `host` (and a declared `userAgent`, if any) in the
  `BrowserPool.getPage()` options so the right policy applies, and navigate with
  `BrowserPool.navigate(page, url, { waitUntil, timeout })` — never `page.goto` directly
  (§20). Test fakes keep working: `navigate` ends in the page's own `goto`.
- **`createHttpClient(input)`** with the search DTO keeps working: inside a search the
  DTO's caller fields are ignored (the scrape context already carries them) and your
  own `timeout` is no longer dropped when proxies are set.
- **Calls straight through `getAxiosInstance()`** get the identity and the egress check
  but are **not** paced or retried — use `get`/`post`/`request`.
- **Mocks for local tests:** `egressAllowHosts: ['localhost']` on the client, or
  `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS`.
- Plugin unit tests that stub `createHttpClient` are unaffected; there is nothing to
  mock for the policy.

---

## 20. Browser pages (`BrowserPool`)

Browser plugins (Playwright through `BrowserPool`) navigate with
`BrowserPool.navigate(page, url, options)`: the browser counterpart of an `HttpClient`
request. `options` (`waitUntil`, `timeout`, `referer`) go to `page.goto` unchanged. For the
URL's host, under the policy resolved from the search in scope (plus the page's `crawl`
options from `getPage`):

| Step | What happens |
|---|---|
| Abort | a source the search deadline abandoned navigates nowhere; an abort while queued, resolving or loading rejects at once (its open pages are closed too, as before) |
| Egress guard (`blockPrivateNetworks`) | the literal check of §13 before anything else; a page launched with a proxy that is not one of the operator's env proxies has the proxy checked too; for a page `getPage` created without a proxy, the name is resolved once right before the navigation and refused when any answer is private. Only `http(s)` URLs navigate (plus `about:`, `data:` and `blob:`, which touch no network); `file:` and the rest are refused |
| robots.txt (`robotsTxt`) | as §12: the shared cache, fetched with the configured identity and a slot of the host's bucket; `respect` refuses a disallowed URL (`RobotsDisallowedError`), a `Crawl-delay` spaces the navigations; the robots.txt answer feeds the limiter (a long `Retry-After` fails the navigation with `HostCoolingDownError`; Spec 1714, `EVER_JOBS_CRAWL_ROBOTS_BACKOFF`) |
| Pacing | a slot of the host's bucket (§9) — the same bucket its HTTP requests use — held for the whole navigation (and its `minGapMs`, when set, after it) |
| `429`/`503` | the response still comes back (the page loaded), but it counts as throttling and cools the bucket, exactly like an HTTP answer a plugin accepts through `validateStatus` (§11) |
| `500`/`502`/`504` | with `serverErrorCooldownMs` > 0 the bucket cools down that long (Spec 1714, §11); the response still comes back |

Limits of the browser path:

- **DNS rebinding.** Chromium's own resolver cannot be hooked, so the DNS check is best
  effort: a record that changes between our lookup and the browser's is not caught
  (direct `HttpClient` connections are guarded on the address actually connected to).
  Redirects inside the browser, and sub-resources the page loads, are not checked or
  paced — only the navigation itself: `EVER_JOBS_CRAWL_PACE_REDIRECTS` does not reach a
  browser redirect, and a redirect into `*.softy.pro` runs under the first host's policy
  (§9, "Known limitation"; Playwright routes only the first URL of a redirect chain).
- **robots.txt of a proxied page** is fetched directly, not through the page's proxy.
- **Pages `getPage` did not create** (a plugin test's fake page, or a page of a Chromium a
  plugin launched itself) get everything above except the DNS check: their proxy is
  unknown.
- **Not migrated:** `source-tesla-playwright` and `source-ats-kula_ai` launch their own
  Chromium instead of using `BrowserPool` (their identity is not policy-driven either),
  and still call `page.goto` directly; so does `source-wellfound` until its rewrite lands.
  Every other browser plugin navigates through `navigate`.

`EVER_JOBS_CRAWL_BROWSER_NAVIGATION=false` (the default under `legacy`) turns all of it
off: `navigate` is then exactly `page.goto(url, options)`, the pre-1690 behaviour.

---

## 21. Softy — a site-owner policy

The Softy ATS serves every client's board from **one shared server** on
`<tenant>.softy.pro`. Its operator asked for five things; this is how each is met, and
which switch undoes it. Plugin design: [Spec 1691](../.specify/specs/1691-softy-sitemap-discovery/spec.md)
and [Spec 1715](../.specify/specs/1715-softy-audit-hardening/spec.md); shared layer:
[Spec 1714](../.specify/specs/1714-crawl-caller-lock-and-host-policies/spec.md).

| Ask | How it is met |
|---|---|
| (A) an honest UA naming the project | the configured UA (`identify`, the manifest declares no own UA); a caller may only switch to `strict` |
| (B) one request at a time, ~1 req/s per site | `domain` bucket for all tenants, 1 in flight, ≥ 1 s between starts **and** ≥ 0.5 s idle after each answer — for every request to `*.softy.pro`, whichever plugin makes it (§6.4), a redirect hop into it included (§9); the Softy client also has a 1 s `minIntervalFloorMs`; `EVER_JOBS_CRAWL_FLEET_SIZE` spreads it over replicas (§9) |
| (C) no proxy rotation | `proxyRotation: per-host` keyed on `domain:softy.pro` (one origin for all tenants, §10); caller proxies refused under the lock, and a caller cannot change `proxyRotation` there — not even to `off` while proxies are configured (§6.4, §7.2) |
| (D) back off on `429`/`Retry-After`, and when the server struggles | 1 retry on `429`/`503` only, ≥ 10 s back-off, `Retry-After` always honoured (over 60 s → give up and cool the bucket); a `500`/`502`/`504` or timeout cools the whole bucket 30 s (§11); the plugin stops the scrape on any push-back (below) |
| (E) discover offers from `/sitemap.xml`, not list pages | `auto` = sitemap first; list pages only when the sitemap answered but held no offer; a caller may only choose `sitemap`, and a caller's `resultsWanted` above the detail budget no longer steers the scrape to list pages (§21.3); a per-tenant sitemap cache (10 min) |

All of it is **locked** (`callerOverrides: 'stricter'`, from the manifest and the builtin
host entry): on a default install an anonymous API caller can make Softy traffic more
polite, never less (§7.2).

### 21.1 Sitemap stage (`auto` discovery)

`SOFTY_SITEMAP_FALLBACK` decides when `auto` may fall back from the sitemap to list pages:

| Sitemap answer | `empty` (default) | `missing` | `any-error` (pre-1715 decisions) |
|---|---|---|---|
| `2xx`, ≥ 1 offer URL | sitemap path | sitemap path | sitemap path |
| `2xx` sitemap with 0 offer URLs, or not a sitemap (soft-404 HTML) | list pages | list pages | list pages |
| `2xx` with bot-wall markers (a challenge page) | stop, `blocked` | stop, `blocked` | list pages |
| `404` / `410` | stop, `bad_input` (names `SOFTY_SITEMAP_FALLBACK=missing`) | list pages | list pages |
| `401` / `403` / `407` | stop, `blocked` | stop, `blocked` | list pages |
| other `4xx` | stop, diagnostic | stop, diagnostic | list pages |
| `429` (after `HttpClient`'s retry) | stop, `rate_limited` | stop, `rate_limited` | stop |
| `503` | stop, `rate_limited` | stop, `rate_limited` | list pages |
| `500` / `502` / `504`, timeout, reset, other network error | stop, diagnostic | stop, diagnostic | list pages |
| `ENOTFOUND` on the first request (unknown tenant) | stop, `bad_input` "unknown Softy tenant", negative cache | same | list pages, no negative cache |
| robots.txt refusal | stop, `blocked` | list pages | list pages |
| crawl-policy refusal (cool-down, queue timeout, egress), abort | stop | stop | stop |

"Stop" means no further request of any kind in that scrape. An explicit
`discovery: 'sitemap'` never falls back. Unknown tenants are not on Softy's server at
all (no wildcard DNS): the first request fails in DNS, the plugin stops, and the tenant
is remembered for `SOFTY_UNKNOWN_TENANT_TTL_MS` (1 h) so the next search sends nothing
and gets the same `bad_input` diagnostic.

**A tenant with no open offer** (review round 2): its sitemap answers `2xx` without an
offer URL, so `auto` reads `/offers?page=1` (the `empty` rule above) — and when that
page holds no card either, the tenant has nothing open. That answer is remembered for
`SOFTY_SITEMAP_CACHE_TTL_MS` (10 min) like a sitemap, so a repeat search — an all-ATS
`companySlug` search naming the tenant included — returns the same empty board with no
request, instead of `/sitemap.xml` + `/offers?page=1` every time. A failure, a stop, a
note, an abort or a listing with cards leaves nothing cached. `SOFTY_LEGACY=empty-board-uncached`
(or `SOFTY_SITEMAP_CACHE_TTL_MS=0`) restores the old behaviour.

**Nested sitemaps** (today's tenants serve a plain `<urlset>`, but an index is
supported). A child sitemap that

- answers `429`/`503` or hits a crawl-policy refusal stops the walk and the scrape
  (`fetchSitemap`'s default, §19): `rate_limited` / the refusal's reason;
- answers `401`/`403`/`407` or a challenge page stops the scrape as `blocked`;
- finds the server struggling — `500`/`502`/`504`, a timeout, a connection reset, the
  same classifier as the server-error cool-down (§11) — stops the scrape with a
  `fetch_error` / `timeout` diagnostic, like the root sitemap (Spec 1715 review A5, ask D);
- fails any other way (`404`/`410`, a size cap, bad gzip, a scope refusal) is skipped,
  and the walk goes on.

Under `SOFTY_LEGACY=nested-skip` or `SOFTY_SITEMAP_FALLBACK=any-error` **every** nested
failure is skipped and the walk goes on, as before Spec 1715 (review F4: `fetchSitemap`
then runs with `nestedErrors: 'skip'`). Note that `any-error` restores the pre-1715
*decisions* of the sitemap stage, not the whole pre-1715 stage: the manifest's crawl
policy still applies (one retry on `429`/`503` only, the 30 s server-error cool-down —
which holds a fallback list page back after a `5xx`), so does the 1 s client floor, and
so do the other Spec 1715 plugin changes (sitemap cache, offer-id dedupe…). The pre-1715
crawl policy is the operator recipe in §16; the other plugin changes are `SOFTY_LEGACY`
tokens.

### 21.2 Page stage (list pages, legacy index, detail pages)

| Answer | Default | Pre-1715 via |
|---|---|---|
| `2xx` page with bot-wall markers, or `401` / `403` / `407` | stop the scrape, `blocked` | `SOFTY_LEGACY=block-as-missing` |
| `404` / `410` / other `4xx` on a detail page | skip it; detail GETs are capped at `wanted + SOFTY_DETAIL_ATTEMPT_SLACK` | `SOFTY_DETAIL_ATTEMPT_SLACK` ≥ the budget |
| `404` / `410` on list page 1 | the legacy index at `/offers` (the redirect target, so no redirect hop) | `SOFTY_LEGACY=offres` |
| a legacy card's detail / apply link `/offre/{ID}-{slug}` (a `301` to `/offers/{ID}`) | the post's URL is built as `/offers/{ID}`, so each detail GET is one paced request (Spec 1715 review A0) | `SOFTY_LEGACY=legacy-detail-url` |
| `429` | stop, `rate_limited` | the stop is as before; its diagnostic, `fetch_error` of the first error, with `SOFTY_LEGACY=first-error` |
| `503` | stop, `rate_limited` | `SOFTY_LEGACY=503-as-failure` |
| `5xx` / timeout on a detail page | a failure; `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` (1) in a row stop the scrape with the partial result | `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES=3` |
| `5xx` / timeout on a list page | stop pagination and details; the cards read so far are returned without descriptions | `SOFTY_LEGACY=listing-failure-details` |
| crawl-policy refusal, abort | stop | the stop is as before; its diagnostic with `SOFTY_LEGACY=first-error` (below) |

The scrape reports the most telling error (`preferRefusalError`), so a stop on push-back
reaches the API as `rate_limited` / `blocked` — which stops a multi-location search and
counts for the circuit breaker (§15). `SOFTY_LEGACY=first-error` restores the pre-1715
diagnostics (review round 2): the scrape keeps the FIRST error it met and reports
`classifyScrapeError` of it, and a `429` or a crawl-policy hold-back no longer names
`rate_limited` / `blocked` itself — so a `502` then a `429` reads `fetch_error` naming
the `502` (as before Spec 1715), a multi-location search goes on to the next location,
and a 0-job result does not count for the breaker. The requests sent do not change: the
`429` still stops the scrape. A post whose detail page was fetched from the
network in this scrape carries `jobUrlFetchedAt`, so `?liveness=true` does not fetch it
again. Every post taken from a sitemap also carries `jobUrlListedAt` — when the root
sitemap answered from the network, kept with the sitemap cache so a cache hit carries the
original time — which `?liveness=true` trusts for up to
`EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` (10 min, §15). So does every post taken from
a list page or the legacy index (review round 2): the instant that page answered — list
pages are never cached, so it is always fresh, and `descriptionDepth: 'board'` with
`?liveness=true` sends no probe for the board it just read. `SOFTY_LEGACY=listing-no-listed-at`
leaves list-page posts without it (the old behaviour: each is probed).

### 21.3 Budget, dedupe, caches

- In `auto`, the detail budget is compared with `resultsWanted` only (offset entries cost
  no detail fetch on the sitemap path) — `SOFTY_LEGACY=offset-budget` restores the old
  comparison with `offset + resultsWanted`.
- The sitemap path keeps one entry per offer id (the newest `lastmod`) —
  `SOFTY_LEGACY=duplicate-ids` restores no dedupe.
- **Which path `auto` takes** (Spec 1715 FR-11 and review A1):

  | Request | Path | Why |
  |---|---|---|
  | `descriptionDepth: 'board'` | list pages, unless an **operator** chose `sitemap` | Kept on purpose (Spec 1715 D5): a board-only result needs no detail page, and sitemap entries carry nothing but a URL, so the list pages are the only source of card data — and the cheaper one: one list page carries 21 offers, against the sitemap plus one detail page per offer. A caller's `discovery: 'sitemap'` does not change it. With `?liveness=true` the posts carry `jobUrlListedAt` (the list page's answer time), so the premise holds there too: no probe per card (review round 2). |
  | detail budget (`detail-25`, `SOFTY_MAX_DETAIL_FETCHES`) smaller than `resultsWanted`, while the effective caller-override mode is `stricter` or `none` (the Softy lock on a default install; a global or operator `stricter` / `none` counts too) | sitemap, up to the budget, with a `partial` note naming the lock and the switches | `resultsWanted` (and a `detail-25` depth) are caller parameters; a caller must not be able to steer the scrape to list pages with them (ask E). Before review round 2 this read list pages and returned the rest board-only. |
  | the same, when the `auto` itself came from the operator (`EVER_JOBS_CRAWL_DISCOVERY=auto`, `sites.softy` / `hosts[…]` `discovery: "auto"`), the operator lifted the lock (`callerOverrides: "any"`), or `SOFTY_MAX_DETAIL_FETCHES=0` | list pages, board-only beyond the budget (as before) | the operator's choice |
  | anything else | sitemap | — |

  `SOFTY_LEGACY=caller-listing` restores the old selection under the lock.
- An operator's `discovery: 'sitemap'` wins over `descriptionDepth: 'board'` (the sitemap
  path runs with cache hits only, and a `partial` note says so) —
  `SOFTY_LEGACY=board-over-sitemap` restores the old precedence. `SOFTY_MAX_LIST_PAGES=0`
  disables list pages entirely.
- Per-tenant sitemap cache (`SOFTY_SITEMAP_CACHE_TTL_MS`, 10 min, ≤ 200 tenants): Softy's
  sitemap is generated on every request (its `Last-Modified` is the request time, no
  `ETag`), so a conditional GET saves nothing; a TTL cache does. The same TTL keeps a
  tenant with no open offer (§21.1; `SOFTY_LEGACY=empty-board-uncached` = not kept).
- Detail cache: sitemap entries are keyed by `url|lastmod`, so they never go stale and
  no longer expire by default (the LRU cap bounds memory); list-page entries keep 6 h.

### 21.4 Variables

| Variable | Values (default) | Restores pre-1715 with |
|---|---|---|
| `SOFTY_SITEMAP_FALLBACK` | `empty` \| `missing` \| `any-error` (`empty`) | `any-error` (the sitemap-stage decisions, nested skips included; not the crawl policy — §21.1) |
| `SOFTY_UNKNOWN_TENANT_TTL_MS` | int ms, at most 86,400,000 (`3600000`; `0` disables) | `0` |
| `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` | int ≥ 0 (`1`; `0` = never stop early) | `3` |
| `SOFTY_DETAIL_ATTEMPT_SLACK` | int ≥ 0 (`5`) | a value ≥ `SOFTY_MAX_DETAIL_FETCHES` (e.g. `100`) |
| `SOFTY_SITEMAP_CACHE_TTL_MS` | int ms (`600000`; `0` disables) | `0` |
| `SOFTY_DETAIL_CACHE_TTL_MS` | int ms; unset = sitemap entries never expire, list entries 6 h; set = every entry, `0` = no expiry | `21600000` |
| `SOFTY_MAX_LIST_PAGES` | int ≥ 0 (`50`; `0` = no list pages) | — |
| `SOFTY_MAX_DETAIL_FETCHES` | detail pages per scrape; cache hits do not count (`100`) | — |
| `SOFTY_DETAIL_CACHE_MAX` | detail cache entries; `0` disables (`500`) | — |
| `SOFTY_LASTMOD_AS_DATE_POSTED` | use the sitemap `lastmod` as `datePosted` when the page has no date (`true`) | — |
| `SOFTY_LEGACY` | comma list of the tokens below, or `all` (empty) | `all` |

| `SOFTY_LEGACY` token | Restores |
|---|---|
| `offset-budget` | `offset` counts against the detail budget in `auto` |
| `duplicate-ids` | no offer-id dedupe on the sitemap path |
| `board-over-sitemap` | `descriptionDepth: 'board'` beats an operator `sitemap` |
| `offres` | the legacy index requested at `/offres` |
| `block-as-missing` | `401`/`403`/`407` and challenge pages on list/detail pages treated as missing |
| `503-as-failure` | a `503` on list/detail pages is a plain failure, not a stop |
| `listing-failure-details` | a failed list page still lets the collected cards' detail pages be fetched |
| `no-interval-floor` | no `minIntervalFloorMs` on the Softy client |
| `caller-listing` | under a caller lock, a detail budget shorter than `resultsWanted` still reads list pages in `auto` (review A1) |
| `nested-skip` | every nested-sitemap failure is skipped and the walk goes on — `429`/`503`, a crawl-policy refusal, `5xx`/timeouts, `401`/`403`/`407`, a challenge page (review A5 / F4) |
| `legacy-detail-url` | legacy cards link `/offre/{ID}-{slug}` (a `301` hop) instead of its target `/offers/{ID}` (review A0) |
| `first-error` | the pre-1715 diagnostics: the first error met, classified — a later `429` / robots.txt refusal no longer replaces an earlier `5xx`, and a `429` or a crawl-policy hold-back names no `rate_limited` / `blocked` itself (a `429` reads `fetch_error`) (review round 2, §21.2) |
| `listing-no-listed-at` | posts from list pages / the legacy index carry no `jobUrlListedAt`, so `?liveness=true` probes each of them (review round 2) |
| `empty-board-uncached` | a tenant whose sitemap lists no offer and whose listing has no card is asked again on every search (review round 2, §21.1) |

`SOFTY_LEGACY=all` includes every round-2 token; an unknown token is warned once and
ignored.

The crawl-policy side — the manifest's pace and retries, the `*.softy.pro` builtin host
entry and the lock — is undone by operator policy, not by `SOFTY_LEGACY`: the lock alone
with the §6.4 JSON, the whole pre-1715 Softy crawl policy with the recipe in §16
(`EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE=*.softy.pro,softy.pro`, a `sites.softy` entry with
the preset's retry and back-off values, and `SOFTY_LEGACY=no-interval-floor`).

**CI.** The live Softy e2e runs only on the weekly schedule, on a manual dispatch, or
with `EVER_JOBS_LIVE_SOFTY=1`; on a push or pull request it is skipped with a visible
reason, so CI does not send requests to a real tenant on every run.
