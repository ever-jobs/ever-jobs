import type { PluginCrawlPolicy } from '@ever-jobs/common';

/**
 * Constants for the Softy (softy.pro) careers platform.
 *
 * Softy (softy.pro, Dijon, France — a 100% French ATS / recruitment suite) powers
 * each customer tenant's branded, public, unauthenticated candidate-facing careers
 * board on its own sub-domain of the shared application host, addressed by the
 * tenant slug.
 *
 * Current surface (verified 2026-09-24, Spec 1691):
 *
 *   https://{tenant}.softy.pro/sitemap.xml        (<urlset>: one /offers/{ID} per open
 *                                                   offer with <lastmod>, newest first)
 *   https://{tenant}.softy.pro/offers?page=N      (paginated index, 21 cards per page)
 *   https://{tenant}.softy.pro/offers/{ID}        (canonical detail / apply page)
 *
 * List cards are `<a href=".../offers/{ID}">` wrapping `h3[data-slot=joboffer-title]`,
 * `[data-slot=joboffer-locations] p` (city), `[data-slot=joboffer-published-at]`
 * ("Mise en ligne le DD/MM/YYYY") and `span[data-slot=badge]` (contract, schedule).
 * Detail pages carry an `h1`, the same location / badge slots, `.prose` sections
 * under `h2` headings and `og:title` / `og:description` — no JSON-LD, no date.
 *
 * Legacy surface (researched 2026-06-03, kept as a fallback for tenants still on it):
 *
 *   https://{tenant}.softy.pro/offres                 (single-page index — French)
 *   https://{tenant}.softy.pro/offre/{ID}-{title-slug} (detail / apply)
 *
 * Since 2026-09 `/offres` 301-redirects to `/offers`, so the legacy index is now
 * requested at `/offers` directly (Spec 1715 FR-14): no unpaced redirect hop.
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g.
 * `groupecls`) or by `companyUrl` (a board URL on a `softy.pro` host, from which the
 * tenant sub-domain label is derived). Unknown tenants are NXDOMAIN (no wildcard
 * DNS): the first request fails in DNS, the scrape stops with a `bad_input`
 * diagnostic and the tenant is remembered for `SOFTY_UNKNOWN_TENANT_TTL_MS` (Spec
 * 1715 FR-5). Failures never throw: they end the scrape with whatever was collected
 * plus a diagnostic, so a single bad tenant never breaks a batch.
 *
 * Politeness (Specs 1690, 1691, 1714, 1715): every tenant is served by ONE Softy
 * server, so the whole `softy.pro` domain is paced at ~1 request/second with one
 * request in flight and an idle gap after each answer, detail pages are always
 * fetched one after another, and the scrape stops at the first push-back (a block, a
 * throttle or a struggling server) instead of moving to heavier pages.
 */

/** Root domain — used to recognise tenant hosts / URLs passed via `companyUrl`. */
export const SOFTY_ROOT_DOMAIN = 'softy.pro';

/** URL scheme used to build a tenant board host from a bare slug. */
export const SOFTY_SCHEME = 'https://';

/**
 * Legacy server-rendered open-roles index path (French). It 301-redirects to
 * `/offers` since 2026-09; requested only with `SOFTY_LEGACY=offres` (the pre-1715
 * behaviour) — by default the legacy index is read at `SOFTY_LEGACY_INDEX_PATH`.
 */
export const SOFTY_OFFERS_PATH = '/offres';

/**
 * Where the legacy-markup index is requested (Spec 1715 FR-14, audit G6): the target
 * of the `/offres` 301, so every request is one paced limiter slot (axios would
 * follow the redirect inside the same slot). `SOFTY_LEGACY=offres` restores
 * `/offres` (`SOFTY_OFFERS_PATH`).
 */
export const SOFTY_LEGACY_INDEX_PATH = '/offers';

/** Legacy per-role detail / apply path segment: `/offre/{ID}-{title-slug}`. */
export const SOFTY_OFFER_PATH = '/offre/';

/** Current paginated open-roles index path: `/offers?page=N` (Spec 1691). */
export const SOFTY_LISTING_PATH = '/offers';

/** Current canonical per-role detail / apply path segment: `/offers/{ID}` (Spec 1691). */
export const SOFTY_DETAIL_PATH = '/offers/';

/** Query parameter that selects a listing page. */
export const SOFTY_PAGE_PARAM = 'page';

/** Tenant sitemap path (a `<urlset>` of offers with `<lastmod>`). */
export const SOFTY_SITEMAP_PATH = '/sitemap.xml';

/**
 * Default internal results cap. Mirrors the sibling ATS adapters: the public DTO
 * default is small, but when a caller omits `resultsWanted` entirely we ingest up
 * to 100 of the tenant's open roles.
 */
export const SOFTY_DEFAULT_RESULTS = 100;

/**
 * Hard ceiling on detail pages fetched per scrape (cache hits do not count).
 * Overridable with the `SOFTY_MAX_DETAIL_FETCHES` environment variable.
 */
export const SOFTY_MAX_DETAIL_FETCHES = 100;

/** Detail pages fetched for `descriptionDepth: 'detail-25'`. */
export const SOFTY_DETAIL_25_LIMIT = 25;

/**
 * Listing pages read per scrape in `listing` discovery. Pagination also stops at
 * `resultsWanted`, at a page with no new cards, or when no link to a later page
 * exists. Overridable with `SOFTY_MAX_LIST_PAGES`; `0` disables list pages entirely
 * (Spec 1715 FR-11): `auto` never picks the listing and an explicit `listing` returns
 * nothing with a `bad_input` note.
 */
export const SOFTY_MAX_LIST_PAGES = 50;

/** Entries in the process-wide detail cache (0 disables it). Env: `SOFTY_DETAIL_CACHE_MAX`. */
export const SOFTY_DETAIL_CACHE_MAX = 500;

/**
 * Detail-cache time-to-live of SITEMAP entries, ms, when `SOFTY_DETAIL_CACHE_TTL_MS`
 * is unset: 0 = no expiry (Spec 1715 FR-13, audit G24). Their key is `url|lastmod`,
 * so an edited offer gets a new key and a stale entry is never served; the LRU cap
 * (`SOFTY_DETAIL_CACHE_MAX`) bounds memory. Was 6 h: `SOFTY_DETAIL_CACHE_TTL_MS=21600000`
 * (`SOFTY_LEGACY_DETAIL_CACHE_TTL_MS`) restores the pre-1715 expiry for every entry.
 */
export const SOFTY_DETAIL_CACHE_TTL_MS = 0;

/**
 * Detail-cache TTL of LISTING entries, ms, when `SOFTY_DETAIL_CACHE_TTL_MS` is unset
 * (Spec 1715 D3): their key is the URL only (a card carries no change indicator), so
 * they keep the 6 h expiry to pick up edits. A set `SOFTY_DETAIL_CACHE_TTL_MS` applies
 * to every entry, as before Spec 1715.
 */
export const SOFTY_LISTING_DETAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** The pre-1715 default of `SOFTY_DETAIL_CACHE_TTL_MS` (every entry, 6 h). */
export const SOFTY_LEGACY_DETAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * In sitemap discovery the detail page carries no date, so `datePosted` falls back
 * to the sitemap `<lastmod>` date. Env: `SOFTY_LASTMOD_AS_DATE_POSTED=false` disables.
 */
export const SOFTY_LASTMOD_AS_DATE_POSTED = true;

/**
 * Consecutive failed detail fetches (5xx / network / timeout) after which a scrape
 * stops — a struggling server gets left alone. Env:
 * `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` (0 = never stop early). Default 1 since
 * Spec 1715 (FR-6, audit G13): Softy's one server answering a 5xx is struggling, and
 * the manifest's `serverErrorCooldownMs` already cooled the bucket. Was 3:
 * `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES=3` (`SOFTY_LEGACY_MAX_CONSECUTIVE_DETAIL_FAILURES`)
 * restores the pre-1715 behaviour.
 */
export const SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES = 1;

/** The pre-1715 default of `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES`. */
export const SOFTY_LEGACY_MAX_CONSECUTIVE_DETAIL_FAILURES = 3;

/**
 * Detail GETs (network, not cache hits) per scrape are capped at
 * `min(detail budget, resultsWanted + SOFTY_DETAIL_ATTEMPT_SLACK)` (Spec 1715 FR-7,
 * audit G20): a few offers that are gone (404/410) are skipped, but a sitemap of
 * dead entries cannot cost a request per entry. Env `SOFTY_DETAIL_ATTEMPT_SLACK`; a
 * value ≥ `SOFTY_MAX_DETAIL_FETCHES` (e.g. `100`) restores the pre-1715 behaviour
 * (only the detail budget bounds the attempts).
 */
export const SOFTY_DETAIL_ATTEMPT_SLACK = 5;

/**
 * When `auto` discovery may fall back from `/sitemap.xml` to list pages (Spec 1715
 * FR-4, table §7.3):
 *
 * - `empty` (default): only when the sitemap answered 2xx but held no offer URL or
 *   could not be parsed. Push-back (401/403/407, a challenge page, 429, 503), a
 *   struggling server (5xx, timeout, reset) or a 404/410 stop the scrape.
 * - `missing`: also on 404/410 (the Spec 1691 wording) and a robots.txt refusal.
 * - `any-error`: the shipped (pre-1715) sitemap stage exactly — every failure except a
 *   429 or a crawl-policy refusal falls back, and an unknown tenant (`ENOTFOUND`) is
 *   not negatively cached.
 */
export type SoftySitemapFallback = 'empty' | 'missing' | 'any-error';

/** Every `SOFTY_SITEMAP_FALLBACK` value. */
export const SOFTY_SITEMAP_FALLBACKS: readonly SoftySitemapFallback[] = ['empty', 'missing', 'any-error'];

/**
 * Default `SOFTY_SITEMAP_FALLBACK` (Spec 1715, audit G13/G21/K0/K1). Pre-1715:
 * `SOFTY_SITEMAP_FALLBACK=any-error`.
 */
export const SOFTY_SITEMAP_FALLBACK: SoftySitemapFallback = 'empty';

/**
 * How long an unknown tenant (its host does not resolve: `ENOTFOUND` on the scrape's
 * first request) is remembered, ms (Spec 1715 FR-5, audit K0): a cached unknown
 * tenant returns the same `bad_input` diagnostic with no request. Env
 * `SOFTY_UNKNOWN_TENANT_TTL_MS`; `0` disables the negative cache (the pre-1715
 * behaviour: every search asks DNS again).
 */
export const SOFTY_UNKNOWN_TENANT_TTL_MS = 60 * 60 * 1000;

/** Longest accepted `SOFTY_UNKNOWN_TENANT_TTL_MS` (larger values are clamped with a warning). */
export const SOFTY_UNKNOWN_TENANT_TTL_MAX_MS = 24 * 60 * 60 * 1000;

/** Entries in the unknown-tenant negative cache. */
export const SOFTY_UNKNOWN_TENANT_CACHE_MAX = 1000;

/**
 * Per-tenant sitemap cache TTL, ms (Spec 1715 FR-12, audit G23): the offer entries of
 * a successful sitemap (≥ 1 offer) are kept this long, so a repeat search within the
 * window sends no sitemap request. Softy generates the sitemap per request
 * (`Last-Modified` = now, no `ETag`), so a conditional GET would save nothing. Env
 * `SOFTY_SITEMAP_CACHE_TTL_MS`; `0` disables the cache (the pre-1715 behaviour).
 */
export const SOFTY_SITEMAP_CACHE_TTL_MS = 10 * 60 * 1000;

/** Tenants kept in the sitemap cache. */
export const SOFTY_SITEMAP_CACHE_MAX = 200;

/**
 * The spacing floor the Softy client is built with (`createHttpClient({
 * minIntervalFloorMs })`, Spec 1715 FR-2, audit G3): no policy layer — a caller's
 * `rateDelayMin: 0` included — shortens the gap between two request starts below it.
 * `SOFTY_LEGACY=no-interval-floor` builds the client without it (pre-1715).
 */
export const SOFTY_MIN_INTERVAL_FLOOR_MS = 1000;

/**
 * `SOFTY_LEGACY` tokens (comma list, or `all`): each restores one pre-1715 plugin
 * behaviour (Spec 1715 FR-17, table §7.2).
 *
 * | Token | Restores | Gap |
 * |---|---|---|
 * | `offset-budget` | `offset` counts against the detail budget in `auto` | G19 |
 * | `duplicate-ids` | no offer-id dedupe on the sitemap path | G25 |
 * | `board-over-sitemap` | `descriptionDepth: 'board'` beats an operator `sitemap` | G22 |
 * | `offres` | the legacy index requested at `/offres` | G6 |
 * | `block-as-missing` | 401/403/407 and challenge pages on list/detail pages treated as missing | K1, G20 |
 * | `503-as-failure` | a 503 on list/detail pages is a plain failure, not a stop | G13 |
 * | `listing-failure-details` | a failed listing page still lets the collected cards' detail pages be fetched | G13 |
 * | `no-interval-floor` | no `minIntervalFloorMs` on the Softy client | G3 |
 */
export const SOFTY_LEGACY_TOKENS = [
  'offset-budget',
  'duplicate-ids',
  'board-over-sitemap',
  'offres',
  'block-as-missing',
  '503-as-failure',
  'listing-failure-details',
  'no-interval-floor',
] as const;

export type SoftyLegacyToken = (typeof SOFTY_LEGACY_TOKENS)[number];

/** Longest description kept (chars), in whichever `descriptionFormat` was asked for. */
export const SOFTY_DESCRIPTION_MAX_CHARS = 8000;

/** Environment variables that override the constants above (read per scrape). */
export const SOFTY_ENV = {
  MAX_LIST_PAGES: 'SOFTY_MAX_LIST_PAGES',
  MAX_DETAIL_FETCHES: 'SOFTY_MAX_DETAIL_FETCHES',
  DETAIL_CACHE_MAX: 'SOFTY_DETAIL_CACHE_MAX',
  DETAIL_CACHE_TTL_MS: 'SOFTY_DETAIL_CACHE_TTL_MS',
  LASTMOD_AS_DATE_POSTED: 'SOFTY_LASTMOD_AS_DATE_POSTED',
  MAX_CONSECUTIVE_DETAIL_FAILURES: 'SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES',
  SITEMAP_FALLBACK: 'SOFTY_SITEMAP_FALLBACK',
  UNKNOWN_TENANT_TTL_MS: 'SOFTY_UNKNOWN_TENANT_TTL_MS',
  DETAIL_ATTEMPT_SLACK: 'SOFTY_DETAIL_ATTEMPT_SLACK',
  SITEMAP_CACHE_TTL_MS: 'SOFTY_SITEMAP_CACHE_TTL_MS',
  LEGACY: 'SOFTY_LEGACY',
} as const;

/**
 * The plugin's crawl policy (`@SourcePlugin({ crawl })`; Specs 1690, 1715 FR-1), the
 * pace Softy's operator asked for: all tenants share ONE server, so the budget is per
 * registrable domain (`softy.pro`), one request in flight, ≥ 1 s between starts and
 * ≥ 0.5 s of idle time after each answer; one stable proxy; one retry on 429/503 only,
 * ≥ 10 s of back-off after a throttle and a 30 s whole-bucket cool-down after a
 * 500/502/504 or a timeout; `Retry-After` always honoured (longer than we wait → give
 * up and cool the bucket); the honest Ever Jobs UA.
 *
 * `callerOverrides: 'stricter'` is the site owner's lock (Spec 1714): an API caller may
 * make this traffic more polite, never less — whatever `EVER_JOBS_CRAWL_CALLER_OVERRIDES`
 * says. The same values (without `userAgentMode`) are the builtin host policy of
 * `*.softy.pro` (`BUILTIN_SOFTY_HOST_POLICY`), so every request to Softy is paced
 * alike whichever plugin makes it; a parity test keeps the two in step.
 *
 * Operators still decide (`EVER_JOBS_CRAWL_POLICIES` `sites.softy` /
 * `hosts["*.softy.pro"]`, including `callerOverrides: "any"` to lift the lock;
 * `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false` ignores every manifest). Pre-1715 manifest:
 * `{ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 }`.
 */
export const SOFTY_CRAWL_POLICY: PluginCrawlPolicy = {
  rateLimitScope: 'domain',
  maxConcurrentPerHost: 1,
  minIntervalMs: 1000,
  minGapMs: 500,
  callerOverrides: 'stricter',
  proxyRotation: 'per-host',
  retries: 1,
  retryStatuses: [429, 503],
  throttleRetryDelayMs: 10000,
  serverErrorCooldownMs: 30000,
  respectRetryAfter: true,
  retryAfterOverMax: 'give-up',
  userAgentMode: 'identify',
};

/**
 * The browser User-Agent this plugin declared before Spec 1691. It is still
 * *declared* (via `setHeaders`), but `HttpClient` only puts a declared UA on the wire
 * when the resolved UA mode is `plugin` — by default the honest Ever Jobs UA goes out.
 */
export const SOFTY_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36';

/**
 * Default request headers: HTML `Accept` and a French `Accept-Language`. The UA is
 * not part of these any more (see `SOFTY_BROWSER_USER_AGENT`).
 */
export const SOFTY_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

/**
 * Matches a legacy Softy detail anchor inside the index HTML, capturing the
 * numeric job id and the title slug:
 *   /offre/{ID}-{title-slug}
 * The id is a run of digits; the slug runs up to the next quote / whitespace / query.
 */
export const SOFTY_OFFER_LINK_REGEX = /\/offre\/(\d+)-([^"'?#\s<>]+)/gi;

/**
 * Matches the path of a current Softy detail URL (`/offers/{ID}`, optionally behind a
 * two-letter locale segment), capturing the numeric id. `/offers/{ID}/apply` and
 * `/offers?page=N` do not match.
 */
export const SOFTY_DETAIL_PATH_REGEX = /^(?:\/[a-z]{2})?\/offers\/(\d+)\/?$/i;

/**
 * Matches a "Mise en ligne le DD/MM/YYYY" published-date line in a card window,
 * capturing the day / month / year parts.
 */
export const SOFTY_PUBLISHED_REGEX = /Mise\s+en\s+ligne\s+le\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i;

/**
 * Recognises a French (or English) contract-type token in a card window, e.g.
 * "CDI", "CDD", "Apprentissage - 24 Mois", "Stage - 4 Mois", "Intérim",
 * "Freelance", "Temps plein", "Temps partiel".
 */
export const SOFTY_CONTRACT_REGEX =
  /\b(CDI|CDD|Apprentissage|Alternance|Stage|Int[eé]rim|Freelance|Temps\s+(?:plein|partiel)|Internship|Apprenticeship|Permanent|Contract)\b[^\r\n<]*/i;

/**
 * Recognises a contract *badge* (current markup): a contract token that is the whole
 * badge or is followed by a separator or a duration ("CDI", "CDD - 6 Mois",
 * "Stage 4 mois"), so skill badges such as "Contract management" on detail pages are
 * not mistaken for it.
 */
export const SOFTY_CONTRACT_BADGE_REGEX =
  /^\s*(CDI|CDD|Apprentissage|Alternance|Stage|Int[eé]rim|Freelance|Internship|Apprenticeship|Permanent|Contract|VIE|Contrat\s+de\s+professionnalisation|Contrat\s+pro)(?=\s*$|\s*[-–—:(,/]|\s+\d)/i;

/** Recognises a working-time badge ("Temps plein", "Temps partiel", "Full-time"…). */
export const SOFTY_SCHEDULE_REGEX =
  /\b(Temps\s+(?:plein|partiel)|Mi-temps|Full[\s-]?time|Part[\s-]?time)\b/i;

/** Detects remote / télétravail roles across the title, location, and contract fields. */
export const SOFTY_REMOTE_REGEX =
  /\b(remote|t[ée]l[ée]travail|home[\s-]?(?:based|working)|work\s*from\s*home|wfh|fully\s*remote|100\s*%\s*distanciel|distanciel)\b/i;
