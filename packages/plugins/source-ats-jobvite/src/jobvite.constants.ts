/**
 * Constants for the Jobvite careers platform.
 *
 * Jobvite hosts a branded public career board for each tenant at
 * `https://jobs.jobvite.com/{slug}/`. The board is a client-side Angular SPA,
 * but Jobvite also serves fully server-rendered HTML for the two views the
 * adapter needs:
 *
 *   GET /{slug}/jobs            → job list grouped under `<h3 class="h2">{dept}</h3>`
 *                                 headings, each followed by a `table.jv-job-list`
 *                                 of `<a href="/{slug}/job/{jobId}">{title}</a>`
 *                                 rows plus a `td.jv-job-list-location` cell.
 *   GET /{slug}/job/{jobId}     → detail page embedding a schema.org
 *                                 `JobPosting` JSON-LD block (description body,
 *                                 datePosted, employmentType, structured
 *                                 location, jobLocationType, baseSalary).
 *
 * The adapter reads the server-rendered list for the department grouping + job
 * ids, then fans out to each detail page and consumes the shared JSON-LD
 * extractor for the remaining fields.
 */

/** Board host — every tenant lives under a path segment of this host. */
export const JOBVITE_ROOT_DOMAIN = 'jobs.jobvite.com';

/** Board origin. */
export const JOBVITE_HOST = 'https://jobs.jobvite.com';

/** Builds a tenant's server-rendered job-list URL from its slug. */
export const jobviteBoardUrl = (slug: string): string =>
  `${JOBVITE_HOST}/${encodeURIComponent(slug)}/jobs`;

/**
 * Builds the canonical public detail / apply URL for a role from its tenant slug
 * and stable `jobId`: `https://jobs.jobvite.com/{slug}/job/{jobId}`.
 */
export const jobviteJobDetailUrl = (slug: string, jobId: string): string =>
  `${JOBVITE_HOST}/${encodeURIComponent(slug)}/job/${encodeURIComponent(jobId)}`;

/**
 * Default internal results cap. When a caller omits `resultsWanted` the adapter
 * ingests up to 100 of the tenant's open roles.
 */
export const JOBVITE_DEFAULT_RESULTS = 100;

/**
 * Hard ceiling on detail pages fetched per scrape. Bounds the per-role fan-out so
 * an unexpectedly huge tenant board never runs away.
 */
export const JOBVITE_MAX_DETAIL_FETCHES = 100;

/**
 * Concurrency cap for the per-role detail fan-out. Roles are fetched in bounded
 * batches (via `Promise.allSettled`) so a large board stays inside CI time budgets.
 */
export const JOBVITE_DETAIL_CONCURRENCY = 8;

/**
 * Upper bound (seconds) on the per-request HTTP timeout. An unresponsive board
 * host degrades gracefully inside callers' budgets; a healthy tenant responds
 * well under a second.
 */
export const JOBVITE_DEFAULT_TIMEOUT_SECONDS = 15;

/** Default request headers. The board expects a browser-like UA. */
export const JOBVITE_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Extracts the `{jobId}` from a `/{slug}/job/{jobId}` board URL or href. */
export const JOBVITE_JOB_ID_REGEX = /\/job\/([a-zA-Z0-9]+)/;

/** Extracts the company display name from the board `<title>` ("{Company} Careers"). */
export const JOBVITE_TITLE_COMPANY_REGEX = /^(.*?)\s+Careers\s*$/i;

/** Detects remote / home-working roles from the title or location text. */
export const JOBVITE_REMOTE_REGEX =
  /\b(remote|virtual|home[\s-]?(?:based|working|office)|work\s*from\s*home|wfh|telecommute|telework|anywhere)\b/i;
