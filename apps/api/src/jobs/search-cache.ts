import type { JobPostDto } from '@ever-jobs/models';
import { SearchCompleteness, isSearchCompleteness } from './search-completeness';

/**
 * The REST search cache entry (Spec 1721 / FR-19).
 *
 * ONE entry holds the raw fan-out AND the completeness record of the crawl
 * that produced it. FR-17 first stored the record as a second entry next to
 * the raw set; with `CACHE_MAX_ITEMS=1` (every deployed environment) writing
 * that second entry evicted the raw set from the LRU, so the next request
 * with the same parameters — page 2 of a paginated search — ran the whole
 * fan-out again. One entry cannot be half-evicted.
 *
 * Its own `endpoint` (namespace): entries written under `search` by an older
 * version hold a bare job array and are simply never read again (they expire
 * on their TTL), so a rollout never misreads one shape as the other.
 */
export const SEARCH_CACHE_ENDPOINT = 'search-v2';

/** The cached value: the raw (pre-dedup) fan-out and, when known, its completeness. */
export interface CachedSearch {
  readonly jobs: JobPostDto[];
  readonly completeness?: SearchCompleteness;
}

/** Build the value to cache. The record is omitted, never guessed, when unknown. */
export function toCachedSearch(
  jobs: JobPostDto[],
  completeness: SearchCompleteness | undefined,
): CachedSearch {
  return completeness ? { jobs, completeness } : { jobs };
}

/**
 * Read a cached value back (Redis returns whatever was stored, possibly by
 * another version of the API). `null` when it is not a cached search. A
 * malformed completeness record is dropped — the set is still usable where
 * completeness is not reported (JSON), and NDJSON treats it as a miss (FR-17).
 * A bare job array reads as a set without a record.
 */
export function readCachedSearch(value: unknown): CachedSearch | null {
  if (Array.isArray(value)) return { jobs: value as JobPostDto[] };
  if (!value || typeof value !== 'object') return null;
  const v = value as { jobs?: unknown; completeness?: unknown };
  if (!Array.isArray(v.jobs)) return null;
  const jobs = v.jobs as JobPostDto[];
  return isSearchCompleteness(v.completeness) ? { jobs, completeness: v.completeness } : { jobs };
}
