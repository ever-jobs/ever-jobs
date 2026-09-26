import { InternshalaDescriptionDepth, InternshalaKind } from './internshala.types';

/** Board origin. Every listing and detail URL is built on it. */
export const INTERNSHALA_BASE = 'https://internshala.com';

/** Redirect hops must stay on this host (https, same host or a subdomain). */
export const INTERNSHALA_REDIRECT_HOSTS: readonly string[] = ['internshala.com'];

/** Listing root per stream. `page-N/` is appended for N >= 2. */
export const INTERNSHALA_ROOT: Readonly<Record<InternshalaKind, string>> = {
  job: '/jobs/',
  internship: '/internships/',
};

/** Detail path prefix per stream (singular `detail`: allowed by robots.txt). */
export const INTERNSHALA_DETAIL_PREFIX: Readonly<Record<InternshalaKind, string>> = {
  job: '/job/detail/',
  internship: '/internship/detail/',
};

/** Stream fetch order: internships (the board's main content) first. */
export const INTERNSHALA_STREAM_ORDER: readonly InternshalaKind[] = ['internship', 'job'];

/**
 * Request headers. Deliberately no `user-agent`: the UA comes from
 * `input.userAgent`, or {@link INTERNSHALA_DEFAULT_USER_AGENT}.
 */
export const INTERNSHALA_HEADERS: Readonly<Record<string, string>> = {
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US,en;q=0.9',
};

/**
 * Honest, identifying UA used when the caller names none. The board served
 * full listing markup to it when probed; no browser UA is needed.
 */
export const INTERNSHALA_DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)';

export const INTERNSHALA_DEFAULT_RESULTS = 15;

/** Default hard cap on listing requests per stream (~400 cards). */
export const INTERNSHALA_MAX_PAGES_PER_STREAM = 10;

/** Ceiling for the `INTERNSHALA_MAX_PAGES` override. */
export const INTERNSHALA_MAX_PAGES_CEILING = 50;

/** Seconds between requests: `randomSleep(delay, delay + band)`. */
export const INTERNSHALA_DELAY_SECONDS = 2;
export const INTERNSHALA_BAND_DELAY_SECONDS = 3;

/** Hard ceiling on detail requests per scrape, including `detail-all`. */
export const INTERNSHALA_MAX_DESCRIPTION_FETCHES = 100;

/**
 * Consecutive failed detail requests after which the walk stops. A refusal
 * (403, 429, a challenge page) stops it at once.
 */
export const INTERNSHALA_DETAIL_MAX_CONSECUTIVE_FAILURES = 3;

/** Detail requests allowed per description depth. */
export const INTERNSHALA_DESCRIPTION_BUDGET: Readonly<Record<InternshalaDescriptionDepth, number>> = {
  board: 0,
  'detail-25': 25,
  'detail-all': INTERNSHALA_MAX_DESCRIPTION_FETCHES,
};

export const INTERNSHALA_DEFAULT_DESCRIPTION_DEPTH: InternshalaDescriptionDepth = 'detail-25';

/** A logo URL containing this is the site's placeholder, not a company logo. */
export const INTERNSHALA_PLACEHOLDER_LOGO = 'placeholder_logo';

/** Longest search term sent to the site; longer input is cut at a word boundary. */
export const INTERNSHALA_MAX_TERM_LENGTH = 100;

/** Input city spelling -> the site's slug. Matching also runs the other way. */
export const INTERNSHALA_CITY_ALIASES: Readonly<Record<string, string>> = {
  bengaluru: 'bangalore',
  gurugram: 'gurgaon',
  'new delhi': 'delhi',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
};

/** Detail-page body container (the second selector is the pre-Spec-1706 fallback). */
export const INTERNSHALA_DETAIL_SELECTOR = '.internship_details .text-container, .detail_view';

/**
 * robots.txt (`User-Agent: *`) — the only path prefixes this plugin requests.
 * Everything else on the host is out of scope.
 */
export const INTERNSHALA_ALLOWED_PREFIXES: readonly string[] = [
  '/jobs/',
  '/internships/',
  '/job/detail/',
  '/internship/detail/',
];

/** robots.txt `Disallow` prefixes that sit next to the allowed ones. */
export const INTERNSHALA_DISALLOWED_PREFIXES: readonly string[] = [
  '/api/',
  '/student',
  '/internship/details/',
  '/job/details/',
  '/internship/search/',
  '/job/search/',
];

/** Environment switches (read on every scrape). */
export const INTERNSHALA_ENV = {
  /** `both` (default) | `job` | `internship`: streams for a search without `jobType`. */
  defaultStreams: 'INTERNSHALA_DEFAULT_STREAMS',
  /** `posting` (default) | `url-hash`: the pre-Spec-1706 id scheme. */
  idScheme: 'INTERNSHALA_ID_SCHEME',
  /** Listing requests per stream, 1..50 (default 10). */
  maxPages: 'INTERNSHALA_MAX_PAGES',
  /** `false`/`0`/`off`/`no` stops the detail-slug epoch refinement of `datePosted`. */
  slugTimestamp: 'INTERNSHALA_SLUG_TIMESTAMP',
} as const;
