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
 * FR-20 adds the per-source view a consumer needs to decide expiry PER
 * SOURCE: which selected sources did not run cleanly (failed, partial,
 * skipped, cut at `resultsWanted`, or not queried in list mode). A crawl can
 * be `complete` and still have sources whose postings must not be expired.
 *
 * The record is reported on the NDJSON `end` line (additive fields) and cached
 * in the same entry as the raw fan-out (`./search-cache`, FR-19), so a cache
 * hit reports the completeness of the crawl that produced it. An incomplete
 * crawl is never cached (FR-20).
 */

/** Why the fan-out stopped before every selected source had run. */
export type SearchStopReason = 'deadline' | 'job_ceiling';

/**
 * Why a selected source's result cannot be used to expire its postings
 * (Spec 1721 / FR-20):
 *
 * - a failure {@link ScrapeReason} (`blocked`, `fetch_error`, `timeout`, …) —
 *   it ran and failed;
 * - `partial` — it returned some jobs, then failed;
 * - `skipped` — a bound (deadline, job ceiling) left it unstarted or abandoned
 *   it mid-flight;
 * - `results_wanted` — it returned at least `resultsWanted` jobs, so its list
 *   was probably cut there;
 * - `keyword_required` — list mode does not query it (Spec 1720,
 *   `requiresSearchTerm`).
 */
export type ProblemSourceReason = ScrapeReason | 'skipped' | 'results_wanted' | 'keyword_required';

/** One entry of {@link SearchCompleteness.problemSources}. */
export interface ProblemSource {
  site: string;
  reason: ProblemSourceReason;
}

/** Most entries {@link SearchCompleteness.problemSources} carries (FR-20). */
export const MAX_PROBLEM_SOURCES = 200;

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
  /**
   * FR-20 — sources that ran and returned jobs AND reported a failure
   * (`partial`). Not failures, not skipped; their lists are incomplete.
   */
  sourcesPartial: number;
  /**
   * FR-20 — the selected sources whose result must NOT be used to expire their
   * postings, in fan-out order, at most {@link MAX_PROBLEM_SOURCES}. Every
   * selected source not listed here (when {@link problemSourcesTotal} equals
   * the list's length) ran to the end, did not fail, and returned fewer than
   * `resultsWanted` jobs.
   */
  problemSources: ProblemSource[];
  /**
   * FR-20 — how many sources qualified for {@link problemSources} before the
   * cap. Larger than `problemSources.length` ⇔ the list was truncated, and
   * then no unlisted source may be assumed clean.
   */
  problemSourcesTotal: number;
}

/** A fan-out that ran every selected source (also: nothing was selected). */
export const COMPLETE_SEARCH: Readonly<SearchCompleteness> = Object.freeze({
  complete: true,
  stopReason: null,
  sourcesSkipped: 0,
  sourcesFailed: 0,
  sourcesPartial: 0,
  problemSources: Object.freeze([]) as unknown as ProblemSource[],
  problemSourcesTotal: 0,
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
 * The problem entry of one source that RAN (FR-20), or `null` when it ran
 * cleanly: a failure reason, `partial`, or `results_wanted` when an otherwise
 * clean source returned at least `resultsWanted` jobs (`resultsWanted`
 * unset or not positive: never).
 */
export function problemOfRanSource(
  row: Pick<SourceDiagnosticDto, 'site' | 'reason' | 'count'>,
  resultsWanted: number | null | undefined,
): ProblemSource | null {
  if (isFailedSourceReason(row.reason) || row.reason === 'partial') {
    return { site: row.site, reason: row.reason };
  }
  if (typeof resultsWanted === 'number' && resultsWanted > 0 && row.count >= resultsWanted) {
    return { site: row.site, reason: 'results_wanted' };
  }
  return null;
}

/**
 * Build the record from the fan-out's counters.
 *
 * @param stopReason  the first bound that tripped, or `null`
 * @param sourcesSkipped  sources not started or abandoned because of a bound
 * @param ranRows  per-source rows of the sources that RAN (skipped ones excluded)
 * @param problems  FR-20 — every problem source, in fan-out order (capped here)
 */
export function buildSearchCompleteness(
  stopReason: SearchStopReason | null,
  sourcesSkipped: number,
  ranRows: ReadonlyArray<Pick<SourceDiagnosticDto, 'reason'>>,
  problems: ReadonlyArray<ProblemSource> = [],
): SearchCompleteness {
  const sourcesFailed = ranRows.filter((row) => isFailedSourceReason(row.reason)).length;
  const sourcesPartial = ranRows.filter((row) => row.reason === 'partial').length;
  // "incomplete ⇔ stopReason set" is the wire contract. Every skip path in the
  // fan-out records its reason before it counts the skip, so `stopReason` is
  // the single source of truth here.
  return {
    complete: stopReason === null,
    stopReason,
    sourcesSkipped,
    sourcesFailed,
    sourcesPartial,
    problemSources: problems.slice(0, MAX_PROBLEM_SOURCES).map((p) => ({ site: p.site, reason: p.reason })),
    problemSourcesTotal: problems.length,
  };
}

const STOP_REASONS: ReadonlySet<string> = new Set<SearchStopReason>(['deadline', 'job_ceiling']);

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

const isProblemSource = (v: unknown): v is ProblemSource =>
  Boolean(v) &&
  typeof v === 'object' &&
  typeof (v as ProblemSource).site === 'string' &&
  typeof (v as ProblemSource).reason === 'string';

/**
 * Shape guard for a record read back from the cache (Redis returns whatever
 * was stored, possibly by another version of the API).
 */
export function isSearchCompleteness(value: unknown): value is SearchCompleteness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.complete !== 'boolean' ||
    !isCount(v.sourcesSkipped) ||
    !isCount(v.sourcesFailed) ||
    !isCount(v.sourcesPartial) ||
    !isCount(v.problemSourcesTotal)
  ) {
    return false;
  }
  if (
    !Array.isArray(v.problemSources) ||
    v.problemSources.length > MAX_PROBLEM_SOURCES ||
    v.problemSources.length > v.problemSourcesTotal ||
    !v.problemSources.every(isProblemSource)
  ) {
    return false;
  }
  if (v.complete) return v.stopReason === null;
  return typeof v.stopReason === 'string' && STOP_REASONS.has(v.stopReason);
}
