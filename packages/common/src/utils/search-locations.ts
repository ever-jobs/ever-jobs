import {
  DEFAULT_MAX_SEARCH_LOCATIONS,
  HARD_MAX_SEARCH_LOCATIONS,
} from '@ever-jobs/models';

/**
 * Multi-location search input helpers (Spec 1700).
 *
 * A search may carry `location` and/or `locations[]`. Every plugin only
 * understands a single `input.location`, so the fan-out runs one plugin call
 * per (source, location). These helpers turn the caller's raw input into the
 * ordered, de-duplicated, capped list of locations that is actually searched,
 * and into its cache-key form (caller order kept: the fan-out merges in order).
 *
 * Pure and synchronous; no regex over caller input beyond a fixed whitespace
 * collapse.
 */

/** The locations a search will actually run, and the ones the cap dropped. */
export interface ResolvedSearchLocations {
  /** Searched, in caller order (`location` first), normalized and de-duplicated. */
  readonly locations: string[];
  /** Valid entries dropped by the cap, in order; reported as `bad_input` diagnostics. */
  readonly overCap: string[];
}

const WHITESPACE_RUN = /\s+/g;

/**
 * NFC, trim, collapse internal whitespace runs to one space. Returns `''` for
 * anything that is not a string, so callers can treat "blank" and "not a
 * string" the same way.
 */
export function normalizeSearchLocation(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * Case-insensitive identity of a normalized location. Diacritics are KEPT on
 * purpose: "São Paulo" and "Sao Paulo" can match different upstream records,
 * so collapsing them would silently drop one of the caller's searches.
 */
function locationKey(normalized: string): string {
  return normalized.toLocaleLowerCase('en');
}

/**
 * Clamp an operator setting (`EVER_JOBS_SEARCH_MAX_LOCATIONS`) into
 * `[1, HARD_MAX_SEARCH_LOCATIONS]`. Non-numeric, non-finite, below 1 or above
 * the hard ceiling all resolve to {@link DEFAULT_MAX_SEARCH_LOCATIONS} rather
 * than being honoured — the same rule `clampConcurrency` applies, so a typo
 * such as `1e9` can never restore an unbounded fan-out.
 */
export function clampMaxLocations(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_SEARCH_LOCATIONS;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > HARD_MAX_SEARCH_LOCATIONS) {
    return DEFAULT_MAX_SEARCH_LOCATIONS;
  }
  return Math.floor(n);
}

/**
 * Union of `input.location` and `input.locations`, in that order.
 *
 * - Each entry goes through {@link normalizeSearchLocation}; blanks and
 *   non-strings are dropped.
 * - Duplicates are detected on the normalized, lower-cased form; the first
 *   spelling wins.
 * - The first `maxLocations` unique entries are returned in `locations`; the
 *   remaining unique entries go to `overCap` so the caller can report them.
 *
 * `maxLocations` is clamped with {@link clampMaxLocations}.
 */
export function resolveSearchLocations(
  input: { location?: unknown; locations?: unknown },
  maxLocations: number = DEFAULT_MAX_SEARCH_LOCATIONS,
): ResolvedSearchLocations {
  const max = clampMaxLocations(maxLocations);
  const raw: unknown[] = [input?.location];
  if (Array.isArray(input?.locations)) raw.push(...input.locations);

  const seen = new Set<string>();
  const locations: string[] = [];
  const overCap: string[] = [];
  for (const entry of raw) {
    const normalized = normalizeSearchLocation(entry);
    if (!normalized) continue;
    const key = locationKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    if (locations.length < max) locations.push(normalized);
    else overCap.push(normalized);
  }
  return { locations, overCap };
}

/**
 * Order- and case-insensitive cache-key form of a resolved location list: the
 * lower-cased keys, sorted. `["Chicago, IL", "new york, ny"]` and
 * `["New York, NY", "Chicago, IL"]` therefore share one cache entry.
 *
 * @deprecated Not a safe search cache key: a multi-location search merges in
 * caller order (the first same-source duplicate wins, a refusal skips the
 * locations after it), so a permuted list can return different rows. The
 * search cache uses {@link searchLocationsOrderedCacheKey}. Kept for callers
 * that want set semantics.
 */
export function searchLocationsCacheKey(locations: readonly string[]): string[] {
  return locations
    .map((l) => locationKey(normalizeSearchLocation(l)))
    .filter((l) => l.length > 0)
    .sort();
}

/**
 * Cache-key form of a location list that keeps the caller's order, as the
 * search runs it: each entry normalized ({@link normalizeSearchLocation}) and
 * lower-cased, blanks dropped, duplicates removed keeping the first occurrence
 * — the same identity and first-wins rule as {@link resolveSearchLocations}.
 * `["New York, NY", " chicago,  il", "NEW YORK, NY"]` keys as
 * `["new york, ny", "chicago, il"]`; `["Chicago, IL", "New York, NY"]` keys
 * differently, because the fan-out merges its locations in order.
 */
export function searchLocationsOrderedCacheKey(locations: readonly string[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const entry of locations) {
    const key = locationKey(normalizeSearchLocation(entry));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}
