import { BadRequestException } from '@nestjs/common';
import { SITE_CATEGORIES, SiteCategory, isSiteCategory } from '@ever-jobs/models';

/**
 * Search-input normalisation shared by every entry point (Spec 1720).
 *
 * REST, GraphQL, the CLI and unit tests all reach `JobsService`, and only the
 * REST path runs `ValidationPipe`. Normalising here — not in a DTO
 * `@Transform` — is what gives every caller the same list-mode semantics.
 */

/**
 * Progress snapshot reported by the fan-out (Spec 1721 NDJSON heartbeat).
 * `jobs` counts raw (pre-dedup) jobs collected so far.
 */
export interface SearchProgress {
  sourcesDone: number;
  sourcesTotal: number;
  jobs: number;
}

/** Optional per-call hooks for `JobsService.searchJobsWithDiagnostics`. */
export interface SearchRunOptions {
  /** Called once when the fan-out starts, then after every source settles. */
  onProgress?: (progress: SearchProgress) => void;
  /**
   * Spec 1721 / FR-14 — polled before each source is STARTED, next to the
   * deadline check. Once it returns `true` no further source starts (in-flight
   * ones finish) and the result carries `cancelled: true`. The NDJSON path
   * passes "the client has disconnected".
   */
  isCancelled?: () => boolean;
}

/**
 * Reduce a caller-supplied keyword to either a trimmed non-empty string or
 * `undefined`. `undefined`, `null`, `""` and whitespace-only all mean
 * "no keyword" — list mode. Non-strings (a number sent over GraphQL/CLI) are
 * treated as absent rather than stringified into a query.
 */
export function normalizeSearchTerm(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalise the keyword fields of `input` in place and return it. Idempotent,
 * so the controller (before its cache lookup) and the service (for direct
 * callers) can both call it.
 *
 * An absent keyword is *deleted*, not set to `undefined`, so the cache key and
 * any `JSON.stringify` of the input are identical to a request that never sent
 * the field.
 */
export function normalizeSearchInput<T extends { searchTerm?: unknown; googleSearchTerm?: unknown }>(
  input: T,
): T {
  for (const key of ['searchTerm', 'googleSearchTerm'] as const) {
    if (!(key in input)) continue;
    const normalised = normalizeSearchTerm(input[key]);
    if (normalised === undefined) {
      delete input[key];
    } else {
      input[key] = normalised as T[typeof key];
    }
  }
  return input;
}

/**
 * Clamp `input.resultsWanted` to `max` in place (Spec 1720 / FR-12).
 * `max <= 0` means no cap. Returns the value the caller asked for when it was
 * clamped (for a log line), `undefined` otherwise. Idempotent, so the
 * controller (before its cache key) and the service (for every other entry
 * point) can both call it.
 */
export function clampResultsWanted(
  input: { resultsWanted?: number },
  max: number,
): number | undefined {
  if (!(max > 0)) return undefined;
  const requested = input.resultsWanted;
  if (typeof requested !== 'number' || Number.isNaN(requested) || requested <= max) {
    return undefined;
  }
  input.resultsWanted = max;
  return requested;
}

/** True when the request carries no usable keyword (Spec 1720 list mode). */
export function isListMode(input: { searchTerm?: unknown }): boolean {
  return normalizeSearchTerm(input.searchTerm) === undefined;
}

/**
 * Render the keyword for a log line: `<none>` in list mode, a JSON-quoted
 * string otherwise — never the literal `undefined` or `null`.
 */
export function describeTerm(input: { searchTerm?: unknown }): string {
  const term = normalizeSearchTerm(input.searchTerm);
  return term === undefined ? '<none>' : JSON.stringify(term);
}

/**
 * Validate `siteCategories` for callers that bypass `ValidationPipe`.
 * Returns `undefined` when the filter is absent or empty (no narrowing), the
 * de-duplicated set otherwise.
 *
 * @throws {@link BadRequestException} naming the unknown values and the
 *         allowed list.
 */
export function parseSiteCategories(raw: unknown): Set<SiteCategory> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new BadRequestException(
      `siteCategories must be an array of: ${SITE_CATEGORIES.join(', ')}`,
    );
  }
  if (raw.length === 0) return undefined;
  const unknown = raw.filter((value) => !isSiteCategory(value));
  if (unknown.length > 0) {
    throw new BadRequestException(
      `Unknown siteCategories value(s): ${unknown.map((v) => JSON.stringify(v)).join(', ')}. ` +
        `Allowed: ${SITE_CATEGORIES.join(', ')}`,
    );
  }
  return new Set(raw as SiteCategory[]);
}
