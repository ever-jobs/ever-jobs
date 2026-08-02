/**
 * Constants for the Submit4Jobs / Pereless careers platform.
 *
 * Submit4Jobs careers boards live at `https://{slug}.submit4jobs.com/`. The
 * board is a ColdFusion-hosted Angular SPA embedded via an iframe; the job list
 * is not server-rendered but is served by a JSON API. Three views matter:
 *
 *   GET https://{slug}.submit4jobs.com/
 *                            -> board home page. Embeds a `<script src>` of the
 *                               form `//{apiHost}/templates/{template}/embed/
 *                               iframe.cfm?cid={cid}` revealing the API host,
 *                               template, and numeric company id.
 *   GET .../embed/iframe.cfm?cid={cid}
 *                            -> sets the ColdFusion session cookies
 *                               (CFID, CFTOKEN, CFCLIENT_CAREERHOSTING). These
 *                               must be replayed for the API to answer.
 *   POST .../api/?action=getJobs   (header `cid`, body `{filters:{…}}`)
 *                            -> JSON array of job objects. With `filters.jid`
 *                               set it returns the single matching job carrying
 *                               the description body.
 *
 * Observed host/template pairs: `apps.submit4jobs.com`/`magneto` and
 * `devapps.pereless.com`/`magnetolive`. The pair is discovered from the board
 * page, never hard-coded per tenant.
 */

/** Host suffix — every tenant board lives at `{slug}.submit4jobs.com`. */
export const SUBMIT4JOBS_HOST_SUFFIX = '.submit4jobs.com';

/**
 * Domains the discovered `apiHost` is allowed to live on.
 *
 * 🛑 SECURITY — this is an SSRF gate, not tidiness. `apiHost` is capture group 1
 * of {@link SUBMIT4JOBS_EMBED_REGEX}, i.e. it comes from the *scraped tenant
 * board's own HTML*, and it is then interpolated into the URLs that
 * `primeSession` and `getJobs` request — carrying the ColdFusion session
 * cookies. The regex only constrains the SHAPE of the host (`[a-z0-9.-]+`), so
 * without this check anyone able to edit a `*.submit4jobs.com` board page could
 * point our scraper at an arbitrary host: an internal cluster address, a
 * link-local metadata endpoint, or their own collector.
 *
 * Both entries are required. Observed pairs are `apps.submit4jobs.com`/`magneto`
 * AND `devapps.pereless.com`/`magnetolive` — Pereless Systems is the upstream
 * vendor that white-labels these boards, so allowlisting only `submit4jobs.com`
 * would silently break every tenant served from the `pereless.com` host.
 */
export const SUBMIT4JOBS_ALLOWED_API_HOST_SUFFIXES: readonly string[] = [
  '.submit4jobs.com',
  '.pereless.com',
];

/**
 * `true` when `host` is a bare hostname on one of
 * {@link SUBMIT4JOBS_ALLOWED_API_HOST_SUFFIXES}.
 *
 * Rejects anything carrying credentials, a port, a path, or an IP literal — an
 * embed URL never needs them, and each is a way to slip past a naive
 * `endsWith` (`evil.com/x.submit4jobs.com`, `10.0.0.1:80`,
 * `user@evil.com#.submit4jobs.com`).
 */
export function isAllowedSubmit4jobsApiHost(host: string): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  // Bare hostname only: letters/digits/dot/hyphen, no `@`, `:`, `/`, `#`, `?`.
  if (!/^[a-z0-9.-]+$/.test(h)) return false;
  if (h.includes('..') || h.startsWith('.') || h.startsWith('-')) return false;
  return SUBMIT4JOBS_ALLOWED_API_HOST_SUFFIXES.some((suffix) =>
    h.endsWith(suffix),
  );
}

/** Default results cap when the caller omits `resultsWanted`. */
export const SUBMIT4JOBS_DEFAULT_RESULTS = 100;

/** Bounded concurrency for the description fan-out. */
export const SUBMIT4JOBS_DETAIL_CONCURRENCY = 8;

/** Per-request HTTP timeout (seconds). */
export const SUBMIT4JOBS_DEFAULT_TIMEOUT_SECONDS = 20;

/** The three ColdFusion session cookies the API requires. */
export const SUBMIT4JOBS_SESSION_COOKIES = [
  'CFID',
  'CFTOKEN',
  'CFCLIENT_CAREERHOSTING',
];

/** Default request headers — the board expects a browser-like UA. */
export const SUBMIT4JOBS_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Builds the board home-page URL from the tenant slug. */
export const submit4jobsBoardUrl = (slug: string): string =>
  `https://${encodeURIComponent(slug)}${SUBMIT4JOBS_HOST_SUFFIX}/`;

/** Builds the canonical SPA job-detail URL from slug + numeric job id. */
export const submit4jobsJobUrl = (
  slug: string,
  jid: string | number,
  title: string,
): string => {
  const titleSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `https://${encodeURIComponent(slug)}${SUBMIT4JOBS_HOST_SUFFIX}/#/jobDescription/${jid}${
    titleSlug ? `/${titleSlug}` : ''
  }`;
};

/**
 * Extracts the API coordinates from the board's embed `<script src>`.
 *
 * Matches e.g. `//apps.submit4jobs.com/templates/magneto/embed/iframe.cfm?cid=85514`
 * (with or without a leading scheme).
 */
export const SUBMIT4JOBS_EMBED_REGEX =
  /(?:https?:)?\/\/([a-z0-9.-]+)\/templates\/([a-z0-9_-]+)\/embed\/iframe\.cfm\?cid=(\d+)/i;

/** The `embed/iframe.cfm` URL used to prime the CF session. */
export const submit4jobsIframeUrl = (
  apiHost: string,
  template: string,
  cid: string,
): string =>
  `https://${apiHost}/templates/${template}/embed/iframe.cfm?cid=${cid}`;

/** The `getJobs` API URL for a given host/template. */
export const submit4jobsApiUrl = (apiHost: string, template: string): string =>
  `https://${apiHost}/templates/${template}/api/?action=getJobs`;

/**
 * Template-default `getJobs` filter objects. The API errors on an empty filter
 * set for `magnetolive`, so each template ships the exact empty-filter shape its
 * server accepts. Unknown templates fall back to the `magneto` shape.
 */
export const SUBMIT4JOBS_TEMPLATE_FILTERS: Record<
  string,
  Record<string, unknown>
> = {
  magneto: {
    buid: '',
    intranet: '0',
    city: '',
    state: '',
    country: '',
    title: '',
    zipcode: '',
    department: '',
    businessname: '',
    language: 'en',
  },
  magnetolive: {
    buid: '',
    intranet: '0',
    city: '',
    mystate: [],
    country: '',
    title: '',
    zipcode: '',
    department: '',
    businessname: '',
    jobtype: '',
    keyword: '',
    jobcapability: [],
    jobcategory: [],
  },
};

/** Resolve the default filters for a template (magneto shape as fallback). */
export const submit4jobsFilters = (
  template: string,
): Record<string, unknown> => ({
  ...(SUBMIT4JOBS_TEMPLATE_FILTERS[template.toLowerCase()] ??
    SUBMIT4JOBS_TEMPLATE_FILTERS.magneto),
});

/**
 * Pereless `salarytype` code → pay-period word understood by
 * `getCompensationInterval`. `0` / unknown → no interval.
 */
export const SUBMIT4JOBS_SALARY_TYPE_MAP: Record<string, string> = {
  H: 'HOUR',
  Y: 'YEAR',
  A: 'YEAR',
  W: 'WEEK',
  M: 'MONTH',
  D: 'DAY',
};
