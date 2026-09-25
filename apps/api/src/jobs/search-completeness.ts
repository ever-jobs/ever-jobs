import type { ScrapeReason, SourceDiagnosticDto } from '@ever-jobs/models';

/**
 * Crawl completeness of one fan-out (Spec 1721 / FR-15).
 *
 * The fan-out has two server-side bounds that stop it early: the wall-clock
 * deadline (`EVER_JOBS_FANOUT_DEADLINE_MS`, Spec 5026) and the raw-job ceiling
 * (`EVER_JOBS_MAX_JOBS_PER_SEARCH`, Spec 1720 / FR-12). Either one leaves
 * selected sources unscraped, and before this record the NDJSON `end` line
 * looked the same for a crawl that covered every source and for one that
 * covered half of them — so a consumer that treats "absent from a complete
 * crawl" as "the posting is gone" had no way to know when it must not.
 *
 * The record is reported on the NDJSON `end` line (additive fields) and cached
 * in the same entry as the raw fan-out (`./search-cache`, FR-19), so a cache
 * hit reports the completeness of the crawl that produced it.
 */

/** Why the fan-out stopped before every selected source had run. */
export type SearchStopReason = 'deadline' | 'job_ceiling';

export interface SearchCompleteness {
  /**
   * `true` when every selected source was started and allowed to finish: no
   * source was skipped or abandoned because of the deadline or the job
   * ceiling. Sources that failed on their own do not make a crawl incomplete
   * (they are counted in {@link sourcesFailed}).
   */
  complete: boolean;
  /**
   * The bound that stopped the fan-out — the first one to trip when both did.
   * `null` when {@link complete} is `true`.
   */
  stopReason: SearchStopReason | null;
  /**
   * Selected sources that contributed nothing because the fan-out stopped:
   * not started (deadline or job ceiling) or abandoned mid-flight at the
   * deadline. Keyword-only sources that list mode does not dispatch
   * (Spec 1720) are excluded — skipping them is the request's semantics, not
   * a truncated crawl.
   */
  sourcesSkipped: number;
  /**
   * Sources that ran and ended with a failure reason (`blocked`, `fetch_error`,
   * `timeout`, `bad_input`, `browser_unavailable`, `circuit_open`,
   * `not_registered`, `unknown`). A `partial` source returned jobs and is not
   * counted; sources counted in {@link sourcesSkipped} are not counted again.
   */
  sourcesFailed: number;
}

/** A fan-out that ran every selected source (also: nothing was selected). */
export const COMPLETE_SEARCH: Readonly<SearchCompleteness> = Object.freeze({
  complete: true,
  stopReason: null,
  sourcesSkipped: 0,
  sourcesFailed: 0,
});

/**
 * Reasons that count a source as failed. `ok`, `empty` and `partial` returned
 * what the source had (or some of it); everything else is a failure.
 */
const NOT_FAILED: ReadonlySet<ScrapeReason> = new Set<ScrapeReason>(['ok', 'empty', 'partial']);

/** Does this per-source outcome count as a failed source? */
export function isFailedSourceReason(reason: ScrapeReason): boolean {
  return !NOT_FAILED.has(reason);
}

/**
 * Build the record from the fan-out's counters.
 *
 * @param stopReason  the first bound that tripped, or `null`
 * @param sourcesSkipped  sources not started or abandoned because of a bound
 * @param failedRows  per-source rows of the sources that RAN (skipped ones excluded)
 */
export function buildSearchCompleteness(
  stopReason: SearchStopReason | null,
  sourcesSkipped: number,
  failedRows: ReadonlyArray<Pick<SourceDiagnosticDto, 'reason'>>,
): SearchCompleteness {
  const sourcesFailed = failedRows.filter((row) => isFailedSourceReason(row.reason)).length;
  // "incomplete ⇔ stopReason set" is the wire contract. Every skip path in the
  // fan-out records its reason before it counts the skip, so `stopReason` is
  // the single source of truth here.
  return {
    complete: stopReason === null,
    stopReason,
    sourcesSkipped,
    sourcesFailed,
  };
}

const STOP_REASONS: ReadonlySet<string> = new Set<SearchStopReason>(['deadline', 'job_ceiling']);

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Shape guard for a record read back from the cache (Redis returns whatever
 * was stored, possibly by another version of the API).
 */
export function isSearchCompleteness(value: unknown): value is SearchCompleteness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.complete !== 'boolean' || !isCount(v.sourcesSkipped) || !isCount(v.sourcesFailed)) {
    return false;
  }
  if (v.complete) return v.stopReason === null;
  return typeof v.stopReason === 'string' && STOP_REASONS.has(v.stopReason);
}
