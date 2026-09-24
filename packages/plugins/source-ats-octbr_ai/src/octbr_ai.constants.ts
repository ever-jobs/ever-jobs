/**
 * Constants for the Octbr (octbr.ai) careers-board scraper.
 *
 * Octbr is a multi-tenant ATS: every customer gets a `<slug>.octbr.ai`
 * Laravel + Inertia app. The landing page server-renders an Inertia
 * `data-page` JSON prop on the root div; `props.jobsByDepartment` lists every
 * open role (`{id, title, slug, url, location, location_type,
 * employment_type, ...}`) plus `props.organisation.name` and
 * `props.totalJobs`. Each `job.url` is another Inertia page whose `props.job`
 * carries the full `description` / `responsibilities` / `requirements` HTML
 * and an absolute `posted_date`.
 *
 * So the scraper is a plain HTTP read (no headless browser):
 *   1. GET the tenant root — enumerate roles + company name.
 *   2. GET each `job.url` — extract the description fields.
 *
 * The advertised `/feeds/jobs.json` feed returns an HTML error page on the
 * observed tenant, so it is not used.
 */

export const OCTBR_AI_HOST = 'octbr.ai';

export const OCTBR_AI_DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * A tenant slug is one DNS label (Spec 1689). `companySlug` is spliced into
 * the hostname `https://{slug}.octbr.ai/`, so anything outside a single
 * label — a dot, colon, slash, `@`, `#` or `?` — would move the request to
 * another host, port or path. Anything that fails this is refused as
 * `bad_input` before a URL is built.
 */
export const OCTBR_AI_SLUG_RE = /^[a-z0-9-]{1,63}$/i;

/**
 * Most detail pages fetched at once (Spec 1689). `resultsWanted` has no
 * upper bound, so the detail fan-out runs in batches of this size — the same
 * shape as `ADP_DETAIL_CONCURRENCY` — instead of all at once.
 */
export const OCTBR_AI_DETAIL_CONCURRENCY = 5;

/** `data-page="…"` attribute value on the Inertia root div. */
export const OCTBR_AI_DATA_PAGE_RE = /data-page="([\s\S]*?)"/;
