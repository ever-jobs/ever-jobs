/**
 * Canonical job-URL de-duplication (Spec 1754).
 *
 * The same posting reaches a run through several routes (a board page, a feed,
 * a partner link) and the links differ only by campaign-tracking parameters or
 * host casing. {@link canonicalJobUrl} reduces such links to one comparable form and
 * {@link dropDuplicateJobUrls} keeps the first posting seen for each canonical URL.
 *
 * 🛑 Deliberately conservative. Only parameters that are pure click/campaign
 * tracking are removed, and the fragment is kept (some boards route on it, so
 * `#/jobs/1` and `#/jobs/2` are different postings). A duplicate additionally
 * needs the same role (see `roleKey`): several plugins fall back to one shared
 * listing URL for every posting, and that must never collapse different roles
 * into one.
 */

/** Longest URL considered; longer input has no canonical form. */
const MAX_JOB_URL_LENGTH = 4096;

/** Query parameters (lower case) that only carry click / campaign tracking. */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'msclkid',
  'twclid',
  'yclid',
  'igshid',
  'li_fat_id',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'gh_src',
  'lever-source',
  'lever-origin',
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

/**
 * The canonical form of a posting URL, or `null` when `url` is not an absolute
 * `http(s)` URL (or is empty / over 4096 characters).
 *
 * - the host is lower-cased and a default port dropped (the URL parser does both);
 * - tracking parameters (`utm_*`, `gclid`, `fbclid`, …) are removed;
 * - the remaining parameters are sorted by name, keeping the order of equal names;
 * - the path, the other parameters and the fragment are left untouched.
 */
export function canonicalJobUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > MAX_JOB_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.hostname) return null;

  const kept: Array<[string, string]> = [];
  parsed.searchParams.forEach((value, name) => {
    if (!isTrackingParam(name)) kept.push([name, value]);
  });
  // Array#sort is stable: equal names keep their original relative order.
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  parsed.search = '';
  for (const [name, value] of kept) parsed.searchParams.append(name, value);
  return parsed.toString();
}

/** Why a posting was skipped. */
export const JOB_URL_DUPLICATE_REASON = 'duplicate_canonical_url';

/** One posting skipped by {@link dropDuplicateJobUrls}. */
export interface JobUrlSkip {
  /** Position of the skipped posting in the input. */
  readonly index: number;
  /** Position of the first posting that owns the same canonical URL. */
  readonly firstIndex: number;
  readonly canonicalUrl: string;
  readonly reason: typeof JOB_URL_DUPLICATE_REASON;
}

export interface JobUrlDedupResult<T> {
  /** The postings kept, in input order. */
  readonly jobs: T[];
  /** The postings skipped, in input order. */
  readonly skipped: JobUrlSkip[];
}

interface JobUrlLike {
  jobUrl?: string | null;
  title?: string | null;
}

function titleKey(title: string | null | undefined): string {
  return typeof title === 'string' ? title.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

export interface DropDuplicateJobUrlsOptions<T> {
  /**
   * What must match, besides the URL, for two postings to be the same role.
   * Default: the normalised title. Return `undefined` to keep the posting
   * (its role cannot be told apart). The aggregator passes the engine's
   * company + title + location key, so one listing URL shared by the same
   * title in two cities keeps both.
   */
  readonly roleKey?: (job: T) => string | undefined;
  /** Return true to keep a posting whatever its URL (it is never skipped nor remembered). */
  readonly keep?: (job: T) => boolean;
}

/** Postings checked between event-loop yields. */
const URL_DEDUP_YIELD_EVERY = 500;

/**
 * Keep the first posting for each canonical URL and skip the rest (first seen
 * wins). A posting without a usable `jobUrl` is always kept. The input is not
 * modified and nothing is logged; the caller reports `skipped`. Yields to the
 * event loop every {@link URL_DEDUP_YIELD_EVERY} postings so a large fan-out
 * does not stall other requests.
 */
export async function dropDuplicateJobUrls<T extends JobUrlLike>(
  jobs: ReadonlyArray<T>,
  options: DropDuplicateJobUrlsOptions<T> = {},
): Promise<JobUrlDedupResult<T>> {
  const roleKey = options.roleKey ?? ((job: T) => titleKey(job.title));
  const firstSeen = new Map<string, number>();
  const kept: T[] = [];
  const skipped: JobUrlSkip[] = [];
  for (let index = 0; index < jobs.length; index++) {
    if (index > 0 && index % URL_DEDUP_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const job = jobs[index];
    const canonicalUrl = options.keep?.(job) ? null : canonicalJobUrl(job.jobUrl);
    const role = canonicalUrl === null ? undefined : roleKey(job);
    if (canonicalUrl === null || role === undefined) {
      kept.push(job);
      continue;
    }
    const key = `${canonicalUrl}\u0000${role}`;
    const firstIndex = firstSeen.get(key);
    if (firstIndex === undefined) {
      firstSeen.set(key, index);
      kept.push(job);
    } else {
      skipped.push({ index, firstIndex, canonicalUrl, reason: JOB_URL_DUPLICATE_REASON });
    }
  }
  return { jobs: kept, skipped };
}
