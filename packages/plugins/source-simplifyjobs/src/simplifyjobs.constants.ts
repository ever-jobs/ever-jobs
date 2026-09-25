import { Site } from '@ever-jobs/models';

/** Site value of this plugin (`Site.SIMPLIFYJOBS = 'simplifyjobs'`). */
export const SIMPLIFYJOBS_SITE: Site = Site.SIMPLIFYJOBS;

/** Host serving both published feeds (a static file CDN). */
export const SIMPLIFYJOBS_RAW_HOST = 'raw.githubusercontent.com';
export const SIMPLIFYJOBS_RAW_BASE = `https://${SIMPLIFYJOBS_RAW_HOST}`;
/** Path of the machine-readable list inside each repository. */
export const SIMPLIFYJOBS_FEED_PATH = '.github/scripts/listings.json';
/** robots.txt of the feed host, checked before any feed request. */
export const SIMPLIFYJOBS_ROBOTS_URL = `${SIMPLIFYJOBS_RAW_BASE}/robots.txt`;

export const SIMPLIFYJOBS_DEFAULTS = {
  newGradRepo: 'SimplifyJobs/New-Grad-Positions',
  /** Renamed every season; the previous name redirects for a while. */
  internshipsRepo: 'SimplifyJobs/Summer2027-Internships',
  branch: 'dev',
} as const;

/**
 * Operator overrides, read on every scrape (not at import) so a changed value
 * needs no rebuild. An invalid value is ignored with a warning and the default
 * is used, so a typo can never point the fetch somewhere unexpected.
 */
export const SIMPLIFYJOBS_ENV = {
  newGradRepo: 'SIMPLIFYJOBS_NEWGRAD_REPO',
  internshipsRepo: 'SIMPLIFYJOBS_INTERNSHIPS_REPO',
  branch: 'SIMPLIFYJOBS_BRANCH',
} as const;

/** `owner/repo`: word characters, dots and dashes; `.` / `..` segments are refused separately. */
export const SIMPLIFYJOBS_REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
/** A branch name: word characters, dots, dashes and slashes; `.` / `..` / empty segments are refused separately. */
export const SIMPLIFYJOBS_BRANCH_RE = /^[\w./-]{1,100}$/;

/** Honest identification: who we are and where to read about us. */
export const SIMPLIFYJOBS_USER_AGENT =
  'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)';
/** Product token matched against robots.txt `User-agent` lines. */
export const SIMPLIFYJOBS_ROBOTS_TOKEN = 'everjobs';

/** Fallback freshness window; the host sends `Cache-Control: max-age=300`. */
export const SIMPLIFYJOBS_DEFAULT_TTL_MS = 300_000;
/** A `max-age` is clamped to this range, so a bad header can neither hammer nor freeze the feed. */
export const SIMPLIFYJOBS_MIN_TTL_MS = 60_000;
export const SIMPLIFYJOBS_MAX_TTL_MS = 30 * 60_000;
/** After a failed refresh a cached copy up to this old is still served (flagged `partial`). */
export const SIMPLIFYJOBS_STALE_MAX_MS = 6 * 3_600_000;
/** After a failed refresh, no new request for the same feed within this window. */
export const SIMPLIFYJOBS_ERROR_BACKOFF_MS = 60_000;
/** How long a robots.txt verdict is reused (RFC 9309 §2.4). */
export const SIMPLIFYJOBS_ROBOTS_TTL_MS = 24 * 3_600_000;
/** Bytes of robots.txt read at most (RFC 9309 asks crawlers to parse at least 500 KiB). */
export const SIMPLIFYJOBS_ROBOTS_MAX_BYTES = 512 * 1024;

/** Upper bound on one decompressed feed body (the feeds are ~13 MB today). */
export const SIMPLIFYJOBS_MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Upper bound on one row's JSON text; a real row is under 2 KB. */
export const SIMPLIFYJOBS_MAX_ROW_BYTES = 256 * 1024;
/** Locations kept per row (one real row lists 13). */
export const SIMPLIFYJOBS_MAX_LOCATIONS_PER_ROW = 50;

export const SIMPLIFYJOBS_DEFAULT_RESULTS = 25;
export const SIMPLIFYJOBS_MAX_RESULTS = 1000;
/** HttpClient timeout, in SECONDS. */
export const SIMPLIFYJOBS_TIMEOUT_SECONDS = 60;
export const SIMPLIFYJOBS_DEFAULT_RETRIES = 2;
/** Minimum spacing between two requests of one scrape, in SECONDS; a caller may only lengthen it. */
export const SIMPLIFYJOBS_MIN_INTERVAL_S = 2;

/** Search tokens beyond this many are ignored, which bounds the matching work. */
export const SIMPLIFYJOBS_MAX_SEARCH_TOKENS = 16;
/** Distinct location labels whose parsed facts are memoised (the feeds hold a few thousand). */
export const SIMPLIFYJOBS_LOCATION_MEMO_MAX = 10_000;
/** A feed whose newest posting is older than this probably moved (yearly rename) or froze. */
export const SIMPLIFYJOBS_STALE_FEED_WARN_MS = 14 * 24 * 3_600_000;

export const SIMPLIFYJOBS_DAY_SECONDS = 86_400;

/** Simplify's own company pages; any other `company_url` is dropped. */
export const SIMPLIFYJOBS_COMPANY_URL_PREFIX = 'https://simplify.jobs/';

/** Canadian province and territory codes, with their names (used for location matching). */
export const SIMPLIFYJOBS_CA_PROVINCES: Readonly<Record<string, string>> = {
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PE: 'Prince Edward Island',
  QC: 'Quebec',
  SK: 'Saskatchewan',
  YT: 'Yukon',
};

/**
 * Whole-label shorthands the shared location parser reads as a city name.
 * A bare `LA` is deliberately absent: the feed also writes Louisiana that way
 * (`Bossier City, LA`).
 */
export const SIMPLIFYJOBS_LOCATION_ALIASES: Readonly<Record<string, string>> = {
  nyc: 'New York, NY',
  sf: 'San Francisco, CA',
  'sf bay area': 'San Francisco Bay Area, CA',
  'bay area': 'San Francisco Bay Area, CA',
  dc: 'Washington, DC',
};

/** Apply-URL host suffix to ATS name. The first matching suffix wins. */
export const SIMPLIFYJOBS_ATS_HOSTS: ReadonlyArray<readonly [suffix: string, ats: string]> = [
  ['myworkdayjobs.com', 'workday'],
  ['myworkdaysite.com', 'workday'],
  ['greenhouse.io', 'greenhouse'],
  ['lever.co', 'lever'],
  ['ashbyhq.com', 'ashby'],
  ['icims.com', 'icims'],
  ['smartrecruiters.com', 'smartrecruiters'],
  ['oraclecloud.com', 'oracle'],
  ['taleo.net', 'taleo'],
  ['eightfold.ai', 'eightfold'],
  ['workable.com', 'workable'],
  ['jobvite.com', 'jobvite'],
  ['successfactors.com', 'successfactors'],
  ['successfactors.eu', 'successfactors'],
  ['ultipro.com', 'ukg'],
  ['dayforcehcm.com', 'dayforce'],
  ['workforcenow.adp.com', 'adp'],
  ['bamboohr.com', 'bamboohr'],
  ['recruitee.com', 'recruitee'],
  ['breezy.hr', 'breezy'],
  ['applytojob.com', 'jazzhr'],
  ['paylocity.com', 'paylocity'],
  ['avature.net', 'avature'],
  ['teamtailor.com', 'teamtailor'],
  ['pinpointhq.com', 'pinpoint'],
  ['personio.com', 'personio'],
  ['personio.de', 'personio'],
];

/** Explanation returned, with no request, for a job type neither list carries. */
export const SIMPLIFYJOBS_UNSUPPORTED_JOB_TYPE_DETAIL =
  'simplifyjobs lists only full-time new-grad roles and internships';
