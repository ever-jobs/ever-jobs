/**
 * Granularity of a job's posting time (Spec 1696) — how wide the error bar on
 * `datePosted` / `datePostedAt` is. Only `EXACT`, `MINUTE` and `HOUR` ever come
 * with a `datePostedAt` instant; coarser values describe a date-only posting.
 */
export enum DatePostedPrecision {
  /** An absolute timestamp from the source (second or millisecond resolution). */
  EXACT = 'exact',
  MINUTE = 'minute',
  HOUR = 'hour',
  DAY = 'day',
  /** e.g. "2 weeks ago" with no better signal. */
  WEEK = 'week',
  MONTH = 'month',
  YEAR = 'year',
}

/** Where a job's posting time came from (Spec 1696). */
export enum DatePostedBasis {
  /** The source gave an absolute instant. */
  TIMESTAMP = 'timestamp',
  /** The source gave a calendar date. */
  DATE = 'date',
  /** Derived from an age label ("3 hours ago"), anchored to our fetch time. */
  RELATIVE = 'relative',
}
