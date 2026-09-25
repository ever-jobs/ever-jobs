export const REMOTEOK_API_URL = 'https://remoteok.com/api';

/**
 * Our identifying User-Agent, sent by default (Spec 1707). A live request with
 * it on 2026-09-25 got HTTP 200 and the JSON feed.
 */
export const REMOTEOK_USER_AGENT =
  'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)';

/** The browser User-Agent sent before; `EVER_JOBS_REMOTEOK_LEGACY=ua` restores it. */
export const REMOTEOK_LEGACY_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36';

export const REMOTEOK_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent': REMOTEOK_USER_AGENT,
};

/** Origin used to build a job page URL when the feed omits a usable one (Spec 1707). */
export const REMOTEOK_BASE_URL = 'https://remoteok.com';

/**
 * Hosts that belong to the board itself. An apply link on one of these (or a
 * subdomain) is the board's own job page, never an employer's application
 * page, so it is not a `jobUrlDirect`. Also the redirect pin for the client.
 */
export const REMOTEOK_HOSTS: readonly string[] = ['remoteok.com', 'remoteok.io'];

/**
 * robots.txt asks every agent for `Crawl-delay: 1`. A scrape makes at most two
 * sequential requests; the client spaces them by at least this many seconds,
 * and a caller's `rateDelayMin` can only lengthen the gap, never shorten it.
 */
export const REMOTEOK_CRAWL_DELAY_S = 1;
/** Default client spacing (seconds) when the caller sets none. */
export const REMOTEOK_RATE_DELAY_MIN_S = 1;
export const REMOTEOK_RATE_DELAY_MAX_S = 1.5;

/** `resultsWanted` default and hard ceiling (the feed itself caps near 100). */
export const REMOTEOK_DEFAULT_LIMIT = 100;
export const REMOTEOK_MAX_LIMIT = 200;

/** Search tokens beyond this many are ignored, which bounds the matching work. */
export const REMOTEOK_MAX_SEARCH_TOKENS = 16;

/** Words that carry no search signal on a remote-only board. */
export const REMOTEOK_STOPWORDS: ReadonlySet<string> = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'for', 'in', 'at', 'to', 'with',
  'remote', 'job', 'jobs', 'work', 'from', 'home', 'wfh',
]);

/**
 * Seniority, role-shape and contract words. They still have to match locally,
 * but they are never used to pick the tag feed: as tags they are either
 * absent or applied far too loosely to narrow anything.
 */
export const REMOTEOK_GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'senior', 'sr', 'junior', 'jr', 'mid', 'lead', 'principal', 'staff', 'head', 'chief',
  'engineer', 'engineering', 'developer', 'dev', 'manager', 'management', 'specialist',
  'associate', 'assistant', 'intern', 'internship', 'full', 'part', 'time', 'contract',
  'contractor', 'freelance', 'consultant', 'analyst',
]);

/** Whole-location labels that only mean "remote" (the location parser misses the non-English ones). */
export const REMOTEOK_REMOTE_ALIASES = /^(?:remot[oa]|anywhere|worldwide)$/i;

/**
 * Below this, a salary figure is ambiguous (hourly? thousands?) and is not
 * emitted as a yearly amount; the description fallback gets a chance instead.
 */
export const REMOTEOK_MIN_PLAUSIBLE_SALARY = 1000;
/** A max/min ratio above this is a placeholder range, not a real one. */
export const REMOTEOK_MAX_SALARY_SPREAD = 10;

/**
 * Restores pre-Spec-1707 behaviour, read on every scrape. `true` / `1` / `yes`
 * / `on` / `all` restores every part below; otherwise a comma- or
 * space-separated subset of:
 *
 * - `search`   - global feed only, whole-phrase substring match on title and
 *                tags, feed order (no tag feed, no tokens, no ranking);
 * - `text`     - no repair of double-encoded UTF-8, no trailing-separator trim
 *                on titles;
 * - `urls`     - `jobUrl` is the feed's `url` verbatim, `applyUrl` /
 *                `jobUrlDirect` are its `apply_url` verbatim (the board page),
 *                and `companyLogo` is `company_logo` verbatim (no `logo`
 *                fallback, no URL check);
 * - `salary`   - any pair with both bounds above zero is emitted as yearly USD;
 * - `location` - the location label goes to the parser untidied;
 * - `ua`       - the pre-1707 browser User-Agent ({@link REMOTEOK_LEGACY_USER_AGENT})
 *                instead of {@link REMOTEOK_USER_AGENT}. A caller's `userAgent`
 *                wins in every mode.
 *
 * Unset, empty, `false` / `0` / `no` / `off` keep the current behaviour.
 * `offset` and `hoursOld` are honoured in every mode: a caller that wants the
 * old result simply omits them.
 */
export const REMOTEOK_LEGACY_ENV = 'EVER_JOBS_REMOTEOK_LEGACY';
