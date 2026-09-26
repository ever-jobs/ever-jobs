import type { PluginCrawlPolicy } from '@ever-jobs/common';

/**
 * Constants for the Welcome to the Jungle (WTTJ) careers platform.
 *
 * Welcome to the Jungle (welcometothejungle.com, France / EU) is a recruitment and
 * employer-branding marketplace. Each company ("organization") publishes a branded,
 * public, unauthenticated jobs page on the shared host:
 *
 *   https://www.welcometothejungle.com/{lang}/companies/{slug}/jobs   (company jobs page)
 *
 * The open roles for a company are NOT scraped from that server-rendered HTML; instead
 * the candidate-facing front-end is powered by a **public, anonymous Algolia search
 * index** whose search-only credentials are embedded in the WTTJ front-end JavaScript.
 * The adapter queries that index directly (no headless browser, no API key of our own):
 *
 *   POST https://{appId-lower}-dsn.algolia.net/1/indexes/{index}/query
 *     headers: x-algolia-application-id, x-algolia-api-key, Referer (allow-listed)
 *     body:    { query: '', hitsPerPage, page, facetFilters: [["organization.slug:{slug}"]] }
 *
 * Each Algolia hit carries the role's `reference` (a stable per-role guid — the ATS id
 * and `objectID`), `name` (title), `slug` (the URL-safe per-role segment), `contract_type`,
 * `offices[]` (structured city/state/country), `published_at`, `remote`, `new_profession`
 * (category/sub-category), `summary` / `profile` / `key_missions` (HTML-ish body fragments),
 * salary parts, and the embedded `organization` object (its own `slug`, `name`, `reference`).
 * The adapter reads that JSON rather than depending on volatile CSS class names or a
 * client-rendered DOM, so no headless browser is required.
 *
 * Each role's canonical public detail page is built from the same record:
 *
 *   https://www.welcometothejungle.com/{lang}/companies/{org.slug}/jobs/{job.slug}
 *
 * and the apply URL appends `/apply`:
 *
 *   https://www.welcometothejungle.com/{lang}/companies/{org.slug}/jobs/{job.slug}/apply
 *
 * The `reference` guid is the stable per-role ATS id (`objectID` is the same value and is
 * kept as a defensive alternate). A company with no open roles, an unknown company slug,
 * or an empty index response degrades naturally to an empty result. A fetch error, an
 * HTTP 4xx, a DNS failure, or a malformed body degrades to an empty / partial result
 * rather than throwing, so a single bad company never breaks a batch run.
 *
 * Surface confidence (researched + verified live 2026-06-03, no authentication):
 *  - Confirmed the platform + company addressing
 *    (`welcometothejungle.com/{lang}/companies/{slug}/jobs`) and a real, named company
 *    on it: `groupe-partnaire` (Groupe Partnaire).
 *  - Confirmed the public Algolia index `wttj_jobs_production_en` (app `CSEKHVMS53`,
 *    embedded search key) answers the documented query with a Referer of
 *    `https://www.welcometothejungle.com/`, returning the per-role wire shape above:
 *    a `facetFilters` of `["organization.slug:groupe-partnaire"]` yielded 48 live roles
 *    (`nbHits: 48`), each with a `reference` guid + `slug` mapping to the canonical
 *    detail URL `/companies/{org.slug}/jobs/{job.slug}` (verified=true).
 *
 * Spec 1705 (re-verified live 2026-09-24 with the identifying user agent below):
 *  - With no company filter the same index answers keyword / facet / date queries over the
 *    whole board (about 90k postings, newest first). The `_fr` index holds the same postings
 *    in another locale, so board mode queries `_en` only. Any one query can page through at
 *    most 1,000 hits (`hitsPerPage * page` beyond that returns no hits).
 *  - Every public detail page embeds the same search credentials in an inline
 *    `window.env = {...}` script, which is where the plugin re-reads them when the key rotates.
 */

/** Root domain — used to recognise company hosts / URLs passed via `companyUrl`. */
export const WTTJ_ROOT_DOMAIN = 'welcometothejungle.com';

/** Public, candidate-facing web origin used to build canonical detail / apply URLs. */
export const WTTJ_WEB_ORIGIN = 'https://www.welcometothejungle.com';

/**
 * Public Algolia application id powering the WTTJ candidate-facing job search. This is a
 * search-only credential embedded in the WTTJ front-end (not a secret of ours).
 */
export const WTTJ_ALGOLIA_APP_ID = 'CSEKHVMS53';

/**
 * Public Algolia search-only API key embedded in the WTTJ front-end. Search keys are
 * intentionally public (limited to read-only querying of the published job index).
 */
export const WTTJ_ALGOLIA_API_KEY = '4bd8f6215d0cc52b26430765769e65a0';

/**
 * Prefix of the localised Algolia job indexes (`{prefix}_{locale}`). The front-end
 * publishes it as `ALGOLIA_JOBS_INDEX_PREFIX`, so a rediscovered prefix (Spec 1705) can
 * replace this default at runtime.
 */
export const WTTJ_ALGOLIA_JOBS_INDEX_PREFIX = 'wttj_jobs_production';

/** Index locales, in the order the company mode tries them. */
export const WTTJ_ALGOLIA_INDEX_LOCALES: readonly string[] = ['en', 'fr'];

/** Builds a localised job index name from an index prefix. */
export const wttjAlgoliaIndexName = (prefix: string, locale: string): string =>
  `${prefix}_${locale}`;

/**
 * Algolia job indexes tried in order. WTTJ maintains parallel localised indexes; the
 * `_en` index is the English-facing board and `_fr` the French. The first index that
 * answers with any hits for the company wins.
 */
export const WTTJ_ALGOLIA_INDEXES: readonly string[] = WTTJ_ALGOLIA_INDEX_LOCALES.map(
  (locale) => wttjAlgoliaIndexName(WTTJ_ALGOLIA_JOBS_INDEX_PREFIX, locale),
);

/**
 * Builds the Algolia DSN query endpoint for a given index. `appId` defaults to the
 * built-in application id; a rediscovered one (Spec 1705) is passed explicitly.
 */
export const wttjAlgoliaQueryUrl = (index: string, appId: string = WTTJ_ALGOLIA_APP_ID): string =>
  `https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/${index}/query`;

/**
 * Builds a company's canonical public jobs-page URL from its slug (used as a sensible
 * fallback detail URL when a per-role slug is missing).
 */
export const wttjCompanyJobsUrl = (lang: string, slug: string): string =>
  `${WTTJ_WEB_ORIGIN}/${lang}/companies/${encodeURIComponent(slug)}/jobs`;

/** Default UI language segment for canonical detail / apply URLs. */
export const WTTJ_DEFAULT_LANG = 'en';

/**
 * UI locales the site serves (Spec 1705 B6). A posting's own `language` becomes the URL
 * locale only when it is one of these; any other language (`de`, `it`, `pt`, …) falls
 * back to {@link WTTJ_DEFAULT_LANG}.
 */
export const WTTJ_URL_LOCALES: ReadonlySet<string> = new Set(['en', 'fr', 'es', 'cs', 'sk']);

/**
 * Algolia page size requested per query. The index pages results; the adapter walks
 * pages (bounded by `WTTJ_MAX_PAGES`) until `resultsWanted` is satisfied or the pages
 * are exhausted.
 */
export const WTTJ_PAGE_SIZE = 100;

/**
 * Default internal results cap. Mirrors the sibling ATS adapters: when a caller omits
 * `resultsWanted` entirely we ingest up to 100 of the company's open roles.
 */
export const WTTJ_DEFAULT_RESULTS = 100;

/**
 * Hard ceiling on Algolia pages fetched per scrape. Guards against an unexpectedly
 * large company board (or a pathological `nbPages`) burning the request budget.
 */
export const WTTJ_MAX_PAGES = 50;

/**
 * Upper bound (seconds) on the per-request HTTP timeout. An unresponsive Algolia DSN
 * can connect-then-hang, so we cap the shared client's 60s default to keep
 * graceful-degradation well inside callers' budgets; a healthy query responds in well
 * under a second. A caller may request a SHORTER timeout — we only bound the upper end.
 */
export const WTTJ_DEFAULT_TIMEOUT_SECONDS = 15;

/**
 * Identifying user agent (Spec 1705 §7). Both the Algolia DSN and the public web host
 * answered it normally on 2026-09-24, so it is the default.
 */
export const WTTJ_HONEST_USER_AGENT =
  'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)';

/**
 * The user agent this plugin sent before Spec 1705. Kept only so the earlier behaviour
 * stays reachable: it is used when `WTTJ_USER_AGENT_MODE=browser` is set, never
 * automatically.
 */
export const WTTJ_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36';

/**
 * The crawl-policy opt-in (Spec 1690 §4.2) both clients get only while
 * `WTTJ_USER_AGENT_MODE=browser` is set. The plugin's User-Agent (the `userAgent`
 * option and `setHeaders()`) is a *declared* UA: under the default `identify` mode
 * the configured crawl UA goes out instead unless the plugin layer opts into
 * `userAgentMode: 'plugin'`. With it, the switch sends {@link WTTJ_BROWSER_USER_AGENT}
 * again. `strict` still wins: `EVER_JOBS_CRAWL_USER_AGENT_MODE=strict` (or the `strict`
 * preset) sends the configured UA, and a caller's `userAgent` is sent as the caller
 * layer (`strict`).
 */
export const WTTJ_BROWSER_UA_CRAWL_POLICY: PluginCrawlPolicy = {
  userAgentMode: 'plugin',
  userAgentReason:
    'WTTJ_USER_AGENT_MODE=browser set by the operator: send the pre-Spec-1705 browser User-Agent (Spec 1705 D-05).',
};

/**
 * Default request headers. The Algolia DSN allow-lists the WTTJ web origin via the
 * Referer header (a query without it is rejected as "Method not allowed with this
 * referer"); the search credentials travel in the `x-algolia-*` headers. Each query also
 * sends the credentials it was built with as per-request headers, so a rediscovered key
 * (Spec 1705) takes precedence over the defaults below.
 */
export const WTTJ_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Referer: `${WTTJ_WEB_ORIGIN}/`,
  Origin: WTTJ_WEB_ORIGIN,
  'x-algolia-application-id': WTTJ_ALGOLIA_APP_ID,
  'x-algolia-api-key': WTTJ_ALGOLIA_API_KEY,
  'User-Agent': WTTJ_HONEST_USER_AGENT,
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Pacing between requests from one scrape, in seconds (Spec 1705 A3). The shared
 * HttpClient waits a random delay in this range before every request after the first.
 * A caller's larger `rateDelayMin` / `rateDelayMax` wins. Since the Spec 1690 merge the
 * range is the crawl policy's plugin layer (a caller override replaces it), so the
 * minimum is also the client's `minIntervalFloorMs`, which no layer shortens.
 */
export const WTTJ_RATE_DELAY_MIN_SECONDS = 0.5;
export const WTTJ_RATE_DELAY_MAX_SECONDS = 1.0;

// ── Board-wide search (Spec 1705 work item A) ───────────────────────────────

/** Any one query can reach at most this many hits (`hitsPerPage * page`), verified live. */
export const WTTJ_BOARD_WINDOW = 1000;

/** Largest page size the board mode requests. */
export const WTTJ_BOARD_MAX_HITS_PER_PAGE = 100;

/** Board-mode results when the caller gives no `resultsWanted` (the DTO default). */
export const WTTJ_BOARD_DEFAULT_RESULTS = 15;

/** Board mode queries this index locale only: `_fr` holds the same postings. */
export const WTTJ_BOARD_LOCALE = 'en';

/** Used only when the board locale answers HTTP 404 / 400 (the index is missing). */
export const WTTJ_BOARD_FALLBACK_LOCALE = 'fr';

/** Longest free-text query sent to the index (characters). */
export const WTTJ_BOARD_MAX_QUERY_LENGTH = 256;

/** Longest single facet value sent to the index (characters). */
export const WTTJ_BOARD_MAX_FACET_VALUE_LENGTH = 100;

/**
 * Attributes a board-mode hit carries: what the mapping reads, nothing else. The whole
 * `organization` object is retrieved because nested-path retrieval was not verified.
 */
export const WTTJ_BOARD_ATTRIBUTES: readonly string[] = [
  'reference',
  'objectID',
  'name',
  'slug',
  'language',
  'contract_type',
  'offices',
  'remote',
  'new_profession',
  'summary',
  'key_missions',
  'profile',
  'published_at',
  'published_at_date',
  'published_at_timestamp',
  'salary_minimum',
  'salary_maximum',
  'salary_currency',
  'salary_period',
  'salary_yearly_minimum',
  'has_salary_yearly_minimum',
  'experience_level_minimum',
  'has_experience_level_minimum',
  'education_level',
  'sectors',
  'organization',
];

// ── Credential self-heal (Spec 1705 work item C) ────────────────────────────

/**
 * A public job detail page known live on 2026-09-24; the last-resort page the plugin
 * reads the search credentials from. Detail paths carry no query string, which the
 * site's robots.txt allows.
 */
export const WTTJ_DEFAULT_CREDENTIALS_SEED_URL =
  'https://www.welcometothejungle.com/en/companies/lucca/jobs/business-developer-existing-business_paris_LUCCA_Kgwm8Re';

/** Hosts a credential page may be fetched from (and redirected within). */
export const WTTJ_CREDENTIAL_HOSTS: readonly string[] = [WTTJ_ROOT_DOMAIN];

/** At most one credential refresh per process in this window, so a bad key cannot storm. */
export const WTTJ_CREDENTIAL_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

/** Minimum spacing between credential-page requests within one refresh, in seconds. */
export const WTTJ_CREDENTIAL_FETCH_INTERVAL_SECONDS = 2;

/** A detail page is about 365 KB; anything far larger is not the page we expect. */
export const WTTJ_CREDENTIAL_MAX_HTML_BYTES = 2_000_000;

/** An Algolia error message that means the key or referer was refused. */
export const WTTJ_CREDENTIAL_REJECTION_REGEX =
  /Invalid Application-ID or API key|not allowed with this referer/i;

/** The runtime-config keys a detail page embeds (Spec 1705 §6). */
export const WTTJ_RUNTIME_APP_ID_REGEX = /"ALGOLIA_APPLICATION_ID":"([A-Z0-9]{6,16})"/;
export const WTTJ_RUNTIME_API_KEY_REGEX = /"ALGOLIA_API_KEY_CLIENT":"([0-9a-f]{32})"/;
export const WTTJ_RUNTIME_INDEX_PREFIX_REGEX = /"ALGOLIA_JOBS_INDEX_PREFIX":"([a-z0-9_]+)"/;

// ── Switches (Spec 1705) ────────────────────────────────────────────────────

/**
 * Environment variables that keep every pre-Spec-1705 behaviour reachable. Each is read
 * on every call, so it can be flipped without a rebuild.
 */
export const WTTJ_ENV = {
  /**
   * Default off (owner decision pending, docs/questions.md Q-099): `scrape()` without a
   * company returns `[]`, as before Spec 1705. `on` / `true` / `1` / `yes` lets it run a
   * whole-index board search. robots.txt disallows the site's own search pages, and the
   * index host is reached with the site's Referer/Origin, so this is opt-in until ruled on.
   * `scrapeBoard()` called directly is not affected.
   */
  BOARD_MODE: 'WTTJ_BOARD_MODE',
  /** `legacy`: any remote token other than an explicit "no" counts as remote. */
  REMOTE_MODE: 'WTTJ_REMOTE_MODE',
  /** `legacy`: the old key-missions + profile body (array missions are dropped). */
  DESCRIPTION_LAYOUT: 'WTTJ_DESCRIPTION_LAYOUT',
  /** `off`: every posting language becomes the URL locale, as before. */
  URL_LOCALE_GUARD: 'WTTJ_URL_LOCALE_GUARD',
  /** `browser`: send {@link WTTJ_BROWSER_USER_AGENT} instead of the identifying one. */
  USER_AGENT_MODE: 'WTTJ_USER_AGENT_MODE',
  /** `off`: never fetch a credential page; a refused key is reported as `blocked`. */
  CREDENTIAL_REFRESH: 'WTTJ_CREDENTIAL_REFRESH',
  /** A detail page (https, no query string) tried before the built-in seed page. */
  CREDENTIALS_SEED_URL: 'WTTJ_CREDENTIALS_SEED_URL',
} as const;

/** The trimmed, lower-cased value of a WTTJ env switch ('' when unset). */
export function wttjEnvValue(name: string): string {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** True when a default-on WTTJ env switch is set to `false` / `0` / `off` / `no`. */
export function wttjEnvOff(name: string): boolean {
  return ['false', '0', 'off', 'no'].includes(wttjEnvValue(name));
}

/** True when a default-off WTTJ env switch is set to `true` / `1` / `on` / `yes`. */
export function wttjEnvOn(name: string): boolean {
  return ['true', '1', 'on', 'yes'].includes(wttjEnvValue(name));
}

/** Detects remote / home-working roles across the title, location, and profession fields. */
export const WTTJ_REMOTE_REGEX =
  /\b(remote|full[\s-]?remote|home[\s-]?(?:based|working)|work\s*from\s*home|wfh|telecommute|t[ée]l[ée]travail)\b/i;
