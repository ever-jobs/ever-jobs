/**
 * Constants for the Harri hospitality hiring platform.
 *
 * Harri (harri.com) is an all-in-one workforce management and talent acquisition
 * platform built for the hospitality and service industries. Each employer tenant
 * is addressed by a short slug (the "employer slug") and their public careers page
 * is served at:
 *
 *   https://harri.com/{employerSlug}
 *
 * For example, `https://harri.com/riverstation-careers` is the public careers page
 * for Riverstation restaurant, and `https://harri.com/HHospitality` is Hogsalt
 * Hospitality's page.
 *
 * Wire surface — public anonymous HTML-only:
 *
 *   Harri's employer pages are rendered by an Angular SPA. The underlying JSON API
 *   the Angular app calls requires authentication tokens and is deliberately NOT
 *   used. The public-facing HTML rendered at `harri.com/{slug}` lists open job
 *   positions as anchor-tag links using the pattern:
 *
 *     /{employerSlug}/job/{jobId}-{titleSlug}
 *
 *   e.g. `/riverstation-careers/job/2734396-deputy-general-manager`
 *
 *   We:
 *     1. Fetch the employer's careers page at `HARRI_HOST/{employerSlug}` and
 *        extract all job-link hrefs using {@link HARRI_JOB_HREF_REGEX}.
 *     2. Fan out with a bounded `Promise.allSettled` to each job-detail page at
 *        `HARRI_HOST/{employerSlug}/job/{jobId}-{titleSlug}`.
 *     3. Parse job title, location, description, employment type, pay, and remote
 *        status from the server-rendered HTML on each detail page using meta tags
 *        and heuristic extraction.
 *
 *   The job-detail page at `harri.com/{slug}/job/{id}-{titleSlug}` is server-
 *   rendered HTML that includes Open Graph meta tags (`og:title`, `og:description`)
 *   with the job title and location, and a structured HTML body with the full
 *   job description.
 *
 *   Apply URLs follow the pattern:
 *     `harri.com/{slug}/job/{jobId}-{titleSlug}/apply/{jobId}`
 *
 * Tenant resolution:
 *   - `input.companySlug` — the employer slug, e.g. `riverstation-careers`.
 *   - `input.companyUrl` — fallback; the first path segment of the URL is used,
 *     e.g. `https://harri.com/riverstation-careers` → `riverstation-careers`.
 *
 * Live verification (2026-06-03):
 *   - `harri.com/riverstation-careers` returned HTTP 200 with 2 job links.
 *   - `harri.com/careers_uk` (Harri's own UK careers page) returned HTTP 200
 *     with 2 job links.
 *   - Job URL pattern `/{slug}/job/{jobId}-{titleSlug}` confirmed on multiple
 *     tenants across the global `harri.com/jobs?page=N` listing.
 *   - No public anonymous JSON API is available; this adapter uses HTML scraping.
 *   - Confidence: heuristic (HTML structure confirmed, detail-page parsing
 *     relies on meta tags and heuristic HTML extraction).
 */

/** Base host for all Harri employer careers pages. */
export const HARRI_HOST = 'https://harri.com';

/** Path suffix for the employer careers page; `{slug}` is substituted at runtime. */
export const HARRI_EMPLOYER_PATH_TEMPLATE = '/{slug}';

/**
 * Regex that matches a Harri job-detail href path and captures:
 *   [1] employerSlug — the employer's path segment (e.g. `riverstation-careers`)
 *   [2] jobId        — the numeric job id (e.g. `2734396`)
 *   [3] titleSlug    — the hyphenated title slug (e.g. `deputy-general-manager`)
 *
 * Pattern: `/{employerSlug}/job/{jobId}-{titleSlug}`
 * The apply sub-page (`/apply/…`) is NOT matched — callers must filter those out.
 */
export const HARRI_JOB_HREF_REGEX = /^\/([^/]+)\/job\/(\d+)-(.+)$/;

/**
 * Maximum number of job-detail pages to fetch concurrently per tenant.
 * Harri detail pages are server-rendered HTML; keep this low to stay polite.
 */
export const HARRI_MAX_CONCURRENCY = 5;

/** Delay (ms) between successive concurrency rounds, to stay polite. */
export const HARRI_REQUEST_DELAY_MS = 300;

/**
 * Default internal results cap. Mirrors the sibling ATS adapters.
 * Harri employer pages for smaller tenants typically have 2–60 open roles.
 */
export const HARRI_DEFAULT_RESULTS = 100;

/** Default request headers — Harri expects a browser-like UA. */
export const HARRI_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Env toggle for Harri's country inference (Spec 1689), layered on top of the
 * shared parser: a US address shape ("San Jose, CA 95130") fills a missing
 * country with `US` and a UK postcode shape fills it with `GB` — the stamps
 * Spec 5125 removed. `false` / `0` / `off` / `no` → shared-parser output only
 * (literal-only country); unset or anything else → inference on.
 */
export const HARRI_LOCATION_HEURISTICS_ENV = 'HARRI_LOCATION_HEURISTICS';

export function harriLocationHeuristicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[HARRI_LOCATION_HEURISTICS_ENV] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}
