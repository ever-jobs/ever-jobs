/**
 * Workday uses company-specific subdomains. The URL pattern is:
 *   https://{company}.wd{n}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs
 *
 * The company slug format for Workday is: {company}:{wd_number}:{site}
 * e.g., "tesla:5:Tesla" or "microsoft:1:External"
 */
import { toDateOnly } from '@ever-jobs/common';

/** Default page size for Workday pagination */
export const WORKDAY_PAGE_SIZE = 20;

/** Maximum number of public CXS detail requests in flight at once. */
export const WORKDAY_DETAIL_CONCURRENCY = 5;

/** Default headers for Workday API requests */
export const WORKDAY_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
};

/**
 * Parse a Workday compound slug into its components.
 * Format: "{company}:{wd_number}:{site}"
 * Defaults: wd_number=5, site=External
 */
export function parseWorkdaySlug(slug: string): {
  company: string;
  wdNumber: string;
  site: string;
} {
  const parts = slug.split(':');
  return {
    company: parts[0],
    wdNumber: parts[1] ?? '5',
    site: parts[2] ?? 'External',
  };
}

/**
 * Build the Workday API URL for a given company.
 */
export function buildWorkdayUrl(company: string, wdNumber: string, site: string): string {
  return `https://${company}.wd${wdNumber}.myworkdayjobs.com/wday/cxs/${company}/${site}/jobs`;
}

/** Build the public CXS detail endpoint for a search result's external path. */
export function buildWorkdayDetailUrl(
  company: string,
  wdNumber: string,
  site: string,
  externalPath: string,
): string {
  const path = externalPath.startsWith('/') ? externalPath : `/${externalPath}`;
  return `https://${company}.wd${wdNumber}.myworkdayjobs.com/wday/cxs/${company}/${site}${path}`;
}

/**
 * Identity of a search-result posting, for de-duplication. `externalPath` is the
 * detail-URL path and is unique per requisition; a listing without one falls back to
 * its title so it is de-duplicated rather than dropped.
 */
export function workdayListingKey(listing: {
  externalPath?: string | null;
  title?: string | null;
}): string | null {
  return listing.externalPath?.trim() || listing.title?.trim() || null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Format a Date as an ISO calendar date (YYYY-MM-DD, UTC).
 * Returns null for an Invalid Date (e.g. a day offset that left the
 * representable ECMAScript date range) instead of letting
 * `.toISOString()` throw a RangeError.
 */
function toIsoDate(date: Date): string | null {
  return toDateOnly(date);
}

/**
 * ISO-shaped absolute date: `YYYY-MM-DD`, optionally followed by a time
 * part (`T`/space separator, optional seconds, fraction and zone). Only
 * this shape is accepted by the absolute-date fallback — `Date.parse`
 * of non-ISO strings (e.g. "May 20, 2026") uses host-LOCAL time, which
 * would make the result drift with the host timezone (NFR-1 / NFR-3).
 */
const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * Validate that an ISO-shaped Y/M/D triple is a real calendar date
 * (rejects e.g. 2026-02-30, which V8's legacy parser would otherwise
 * roll over into March in local time). TZ-independent.
 */
function isRealUtcDate(year: number, month: number, day: number): boolean {
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

/**
 * Parse Workday's `postedOn` field into an ISO calendar date (YYYY-MM-DD).
 *
 * The job-list endpoint returns relative human-readable labels rather than
 * dates — live probe of the public API on 2026-06-11 confirmed the shapes
 * "Posted Today", "Posted Yesterday", "Posted 3 Days Ago" and
 * "Posted 30+ Days Ago". Matching is case-insensitive and tolerant of
 * irregular whitespace. Day arithmetic is UTC-based off `now` (defaults to
 * the current time) so results do not drift with the host timezone.
 *
 * - "Posted Today"        -> ISO date of `now`
 * - "Posted Yesterday"    -> `now` minus 1 day
 * - "Posted N Days Ago"   -> `now` minus N days (null if the offset leaves
 *                            the representable ECMAScript date range)
 * - "Posted N+ Days Ago"  -> null (open lower bound — a concrete date would
 *                            fabricate precision the source never provided)
 * - other strings         -> ISO-shaped absolute date (`YYYY-MM-DD`, optional
 *                            time part) -> that calendar date as written;
 *                            anything else -> null (non-ISO formats are
 *                            host-TZ-dependent under `Date.parse`)
 * - null/undefined/empty  -> null
 *
 * Never throws.
 */
export function parseWorkdayPostedOn(
  postedOn?: string | null,
  now: Date = new Date(),
): string | null {
  if (!postedOn) return null;

  const normalized = postedOn.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return null;

  if (normalized === 'posted today') {
    return toIsoDate(now);
  }

  if (normalized === 'posted yesterday') {
    return toIsoDate(new Date(now.getTime() - MS_PER_DAY));
  }

  const relativeMatch = normalized.match(/^posted (\d+)(\+)? days? ago$/);
  if (relativeMatch) {
    // "N+ Days Ago" is a lower bound only — no exact date can be derived.
    if (relativeMatch[2]) return null;
    const days = parseInt(relativeMatch[1], 10);
    return toIsoDate(new Date(now.getTime() - days * MS_PER_DAY));
  }

  const isoMatch = postedOn.trim().match(ISO_DATE_RE);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    if (isRealUtcDate(Number(year), Number(month), Number(day))) {
      return `${year}-${month}-${day}`;
    }
  }

  return null;
}
