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
 * Since 2026-09 `/offres` 301-redirects to `/offers`.
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g.
 * `groupecls`) or by `companyUrl` (a board URL on a `softy.pro` host, from which the
 * tenant sub-domain label is derived). An unknown tenant resolves to a host that
 * answers an HTTP 4xx / empty board, so it degrades naturally to an empty result. A
 * fetch error, an HTTP 4xx, a DNS failure, or a malformed body degrades to an empty
 * / partial result rather than throwing, so a single bad tenant never breaks a batch.
 *
 * Politeness (Spec 1690/1691): every tenant is served by one Softy server, so the
 * plugin's crawl policy paces the whole `softy.pro` domain at ~1 request/second with
 * one request in flight, and detail pages are always fetched one after another.
 */

/** Root domain — used to recognise tenant hosts / URLs passed via `companyUrl`. */
export const SOFTY_ROOT_DOMAIN = 'softy.pro';

/** URL scheme used to build a tenant board host from a bare slug. */
export const SOFTY_SCHEME = 'https://';

/**
 * Legacy server-rendered open-roles index path (French). Kept as the fallback
 * scraping surface for tenants still on the old markup (Spec 1691).
 */
export const SOFTY_OFFERS_PATH = '/offres';

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
 * exists. Overridable with `SOFTY_MAX_LIST_PAGES`.
 */
export const SOFTY_MAX_LIST_PAGES = 50;

/** Entries in the process-wide detail cache (0 disables it). Env: `SOFTY_DETAIL_CACHE_MAX`. */
export const SOFTY_DETAIL_CACHE_MAX = 500;

/** Detail-cache time-to-live, ms (0 = no expiry). Env: `SOFTY_DETAIL_CACHE_TTL_MS`. */
export const SOFTY_DETAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * In sitemap discovery the detail page carries no date, so `datePosted` falls back
 * to the sitemap `<lastmod>` date. Env: `SOFTY_LASTMOD_AS_DATE_POSTED=false` disables.
 */
export const SOFTY_LASTMOD_AS_DATE_POSTED = true;

/**
 * Consecutive failed detail fetches (5xx / network) after which a scrape stops
 * fetching detail pages — a struggling server gets left alone. Env:
 * `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` (0 = never stop early).
 */
export const SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES = 3;

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
} as const;

/**
 * The plugin's crawl-policy defaults (`@SourcePlugin({ crawl })`, Spec 1690): all
 * tenants share Softy's one server, so the budget is per registrable domain
 * (`softy.pro`), one request in flight, ~1 request/second. Operators
 * (`EVER_JOBS_CRAWL_POLICIES` `sites.softy` / `hosts["*.softy.pro"]`) and search
 * callers (`crawl`) can override any of it.
 */
export const SOFTY_CRAWL_POLICY: PluginCrawlPolicy = {
  rateLimitScope: 'domain',
  maxConcurrentPerHost: 1,
  minIntervalMs: 1000,
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
