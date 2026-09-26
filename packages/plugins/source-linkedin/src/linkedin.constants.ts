export const LINKEDIN_HEADERS: Record<string, string> = {
  authority: 'www.linkedin.com',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'max-age=0',
  'sec-ch-ua': '"Not_A Brand";v="99", "Google Chrome";v="120", "Chromium";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

/**
 * LinkedIn job type codes for API filtering.
 */
export const JOB_TYPE_CODES: Record<string, string> = {
  fulltime: 'F',
  parttime: 'P',
  contract: 'C',
  temporary: 'T',
  internship: 'I',
  volunteer: 'V',
  other: 'O',
};

/** Canonical origin every id, job URL and company URL is normalised onto (Spec 1701). */
export const LINKEDIN_BASE_URL = 'https://www.linkedin.com';

/** Guest search endpoint: an HTML fragment of `<li>` cards, 10 per page. */
export const LINKEDIN_SEARCH_PATH = '/jobs-guest/jobs/api/seeMoreJobPostings/search';

/**
 * The guest search stops serving results at about this item offset. The loop
 * never requests `start >= LINKEDIN_MAX_START`, so at most 100 pages are
 * fetched per call however large `resultsWanted` is.
 */
export const LINKEDIN_MAX_START = 1000;

/** Consecutive pages with no new job id before pagination stops (Spec 1701). */
export const LINKEDIN_MAX_PAGES_WITHOUT_NEW = 2;

/**
 * The fixed `start` step the plugin used before Spec 1701. A page holds 10
 * cards, so a step of 25 skipped positions 10-24 of every window. Kept only
 * for `EVER_JOBS_LINKEDIN_LEGACY=pagination`.
 */
export const LINKEDIN_LEGACY_PAGE_STEP = 25;

/** Unique company pages fetched per `scrape()` call when enrichment is on. */
export const LINKEDIN_MAX_COMPANY_FETCHES = 25;

/** Pause between two requests to linkedin.com, in seconds: `delay` to `delay + band`. */
export const LINKEDIN_REQUEST_DELAY_S = 3;
export const LINKEDIN_REQUEST_DELAY_BAND_S = 4;

/**
 * `f_WT` workplace-type filter codes. A comma list is accepted by the board.
 * Only `remote` is wired to an input today (`isRemote`).
 */
export const WORKPLACE_TYPE_CODES: Record<'onsite' | 'remote' | 'hybrid', string> = {
  onsite: '1',
  remote: '2',
  hybrid: '3',
};

/** LinkedIn's non-standard "request refused" status. */
export const LINKEDIN_BLOCK_STATUS = 999;

/**
 * A final URL (after redirects) that is a sign-in wall rather than the page we
 * asked for. Anchored at the first path segment so a company slug such as
 * `/company/login-systems` is not mistaken for one.
 */
export const LINKEDIN_BLOCK_URL_RE =
  /^https?:\/\/[^/?#]*linkedin\.com\/(?:authwall|signup|login|uas\/login|checkpoint)(?:[/?#]|$)/i;

/** The only host whose images are real company logos (the rest are UI placeholders). */
export const LINKEDIN_MEDIA_HOST = 'media.licdn.com';

/**
 * Currency prefixes as LinkedIn renders them for `accept-language: en-US`,
 * longest first so `CA$` is never read as `$`. An ISO-4217 code followed by a
 * number (`SGD 6,000.00`) is recognised separately.
 */
export const LINKEDIN_CURRENCY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['CA$', 'CAD'],
  ['NZ$', 'NZD'],
  ['HK$', 'HKD'],
  ['MX$', 'MXN'],
  ['US$', 'USD'],
  ['CN¥', 'CNY'],
  ['A$', 'AUD'],
  ['R$', 'BRL'],
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['₹', 'INR'],
  ['¥', 'JPY'],
  ['₪', 'ILS'],
  ['₩', 'KRW'],
  ['₱', 'PHP'],
];

/**
 * Opt back into pre-Spec 1701 behaviour, per area. A comma list of
 * `pagination`, `ids`, `pay`, `detail`, `remote`, or `all` (also `true`/`1`).
 * Unset or empty keeps every fix on. Read on every `scrape()` call.
 */
export const LINKEDIN_LEGACY_ENV = 'EVER_JOBS_LINKEDIN_LEGACY';

/**
 * Default for company-page enrichment when the input does not say
 * (`linkedinFetchCompanyDetails`). `true`/`1`/`yes`/`on` enables it; off by default.
 */
export const LINKEDIN_FETCH_COMPANY_DETAILS_ENV = 'EVER_JOBS_LINKEDIN_FETCH_COMPANY_DETAILS';
