/**
 * Constants for the PrismHR / HiringThing careers platform.
 *
 * PrismHR careers boards live at `https://{slug}.prismhr-hire.com/`. The board
 * is a React SPA powered by HiringThing, but the server renders two views the
 * adapter needs:
 *
 *   GET /                    -> board list page. Contains a
 *                               `data-react-props` JSON payload on the
 *                               `HiringThing.Components.JobFiltersContainer`
 *                               element with all job IDs, titles, a
 *                               state -> city -> [ids] location map,
 *                               remotePositions[], and categories{}.
 *   GET /job/{id}            -> detail page. Embeds a schema.org
 *                               `JobPosting` JSON-LD block (description,
 *                               datePosted, hiringOrganization, location)
 *                               and a `HiringThing.Components.ApplyButtonGroup`
 *                               React-props JSON carrying remote, salary,
 *                               pay_frequency, and category.
 *
 * The adapter reads the board list for the complete job enumeration, then fans
 * out to each detail page and consumes the shared JSON-LD extractor plus the
 * React-props for salary/remote/category.
 */

/** Host suffix — every tenant lives at `{slug}.prismhr-hire.com`. */
export const PRISMHR_HOST_SUFFIX = '.prismhr-hire.com';

/** Default results cap when the caller omits `resultsWanted`. */
export const PRISMHR_DEFAULT_RESULTS = 100;

/** Hard ceiling on detail-page fan-out per scrape. */
export const PRISMHR_MAX_DETAIL_FETCHES = 100;

/** Bounded concurrency for detail-page fan-out. */
export const PRISMHR_DETAIL_CONCURRENCY = 8;

/** Per-request HTTP timeout (seconds). */
export const PRISMHR_DEFAULT_TIMEOUT_SECONDS = 15;

/** Default request headers — the board expects a browser-like UA. */
export const PRISMHR_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Builds the board list URL from the tenant slug. */
export const prismhrBoardUrl = (slug: string): string =>
  `https://${encodeURIComponent(slug)}${PRISMHR_HOST_SUFFIX}/`;

/** Builds the detail page URL from slug + numeric job ID. */
export const prismhrDetailUrl = (slug: string, jobId: number): string =>
  `https://${encodeURIComponent(slug)}${PRISMHR_HOST_SUFFIX}/job/${jobId}`;

/** Extracts the company display name from the `<title>` tag ("{Company} Career Opportunities"). */
export const PRISMHR_TITLE_COMPANY_REGEX = /^(.*?)\s+Career\s+Opportunities\s*$/i;

/** Detects remote / home-working roles from the title or location text. */
export const PRISMHR_REMOTE_REGEX =
  /\b(remote|virtual|home[\s-]?(?:based|working|office)|work\s*from\s*home|wfh|telecommute|telework|anywhere)\b/i;
