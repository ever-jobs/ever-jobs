import {
  EXCLUSION_INPUT_KEYS,
  resolveSearchLocations,
  searchLocationsOrderedCacheKey,
} from '@ever-jobs/common';

/**
 * Cache-key parameters for a search (Spec 1700), shared by the REST controller
 * and the GraphQL resolver.
 *
 * The cache stores the RAW fan-out, so the key must change exactly when the
 * fan-out would:
 *
 *  - Exclusion fields (`excludeTitleTerms`, `excludeKeywords`,
 *    `excludePresets`) are blanked. They are a per-request view filter that
 *    runs after the cache, so a filtered request reuses the unfiltered entry.
 *  - `locations`, when present, is replaced by the key of the locations
 *    actually searched (the cap applied), with `location` folded in first:
 *    each entry normalized and lower-cased, duplicates dropped keeping the
 *    first, and the caller's order kept. The service searches the locations
 *    in that order and keeps the first same-source duplicate (and a refusal
 *    skips the locations after it), so `[A, B]` and `[B, A]` can return
 *    different rows and must not share an entry. A request whose list
 *    resolves to a single location keys exactly like a plain `location`
 *    request, because the service runs it that way.
 *
 * A request carrying none of these fields produces exactly the object it
 * produced before (`{ ...input, ...extra }`), so existing entries stay valid.
 * `CacheService.generateKey` drops `undefined` values.
 */
export function searchCacheParams(
  input: object,
  extra: Record<string, unknown>,
  maxLocations: number,
): Record<string, unknown> {
  const source = input as Record<string, unknown>;
  const params: Record<string, unknown> = { ...source, ...extra };
  for (const key of EXCLUSION_INPUT_KEYS) {
    if (key in params) params[key] = undefined;
  }
  if (source.locations !== undefined && source.locations !== null) {
    const resolved = resolveSearchLocations(source, maxLocations).locations;
    if (resolved.length > 1) {
      params.location = undefined;
      params.locations = searchLocationsOrderedCacheKey(resolved);
    } else {
      params.locations = undefined;
      if (resolved.length === 1) params.location = resolved[0];
    }
  }
  return params;
}
