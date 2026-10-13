/**
 * TypeScript interfaces for data parsed from the Factorial public career-page HTML.
 *
 * Factorial career pages are server-rendered Rails applications. No anonymous
 * JSON API exists; all job data is extracted from the HTML DOM via regex
 * pattern matching. These interfaces model the normalised in-memory
 * representation produced by the HTML parser before the data is mapped to
 * `JobPostDto`.
 */

/**
 * A single job posting as extracted from the career-page index HTML
 * (`data-controller='job-postings'` elements) before the detail fetch.
 */
export interface FactorialIndexJob {
  /** Absolute URL of the job-detail page, e.g. `https://{slug}.factorial.com/job_posting/ai-developer-304592`. */
  jobUrl: string;

  /**
   * Numeric ATS id extracted from the trailing token of the job URL path.
   * e.g. from `/job_posting/ai-developer-304592` → `"304592"`.
   */
  id: string;

  /** Human-readable job title extracted from the inner `<div>` of the list item. */
  title: string;

  /** Office / city label derived from the surrounding `<h3>` group heading. */
  officeLabel: string | null;

  /** Numeric location id from `data-location-id`; resolved to a name via the select options. */
  locationId: string | null;

  /** Numeric team id from `data-team-id`; resolved to a department name via the select options. */
  teamId: string | null;

  /** `true` when `data-is-remote='true'`. */
  isRemote: boolean;

  /**
   * Contract type token from `data-contract-type`, e.g. `"indefinite"`,
   * `"temporary"`, `"part-time"`.
   */
  contractType: string | null;

  /**
   * ISO date string (`YYYY-MM-DD`) from the sitemap `<lastmod>` entry for
   * this job URL; may be `null` if the sitemap was unavailable or the entry
   * was not found.
   */
  lastmod: string | null;
}

/**
 * Additional fields fetched from the job-detail page.
 * Merged with `FactorialIndexJob` to produce the final `JobPostDto`.
 */
export interface FactorialDetailJob {
  /**
   * Full HTML job description from `<div class='styledText'>`.
   * `null` if the div was absent or the page fetch failed.
   */
  descriptionHtml: string | null;

  /**
   * Absolute apply URL, typically the `/apply/{slug}` path resolved to the
   * tenant host. `null` if the apply link was not found.
   */
  applyUrl: string | null;

  /**
   * Free-text location label extracted from the sidebar (e.g. `"Monterrey, Monterrey, Mexico"`).
   * Supplements `officeLabel` with a finer-grained location string.
   */
  locationLabel: string | null;

  /**
   * Human-readable team / department name from the sidebar
   * (e.g. `"HR"`, `"Sales"`).
   */
  teamName: string | null;
}
