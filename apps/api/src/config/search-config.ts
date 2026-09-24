/**
 * Pure env resolvers for the search pipeline (Specs 1721, 1723).
 *
 * Kept out of `configuration.ts` so they can be unit-tested with a synthetic
 * env map and reused without constructing the whole config object.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Fan-out budget when nothing is configured (unchanged from Spec 5026). */
export const DEFAULT_FANOUT_DEADLINE_MS = 120_000;

/** Contract v1 name for the fan-out deadline (Spec 1721). Takes precedence. */
export const FANOUT_DEADLINE_ENV_VAR = 'EVER_JOBS_FANOUT_DEADLINE_MS';

/** Pre-existing name (Spec 5026). Still honoured as a fallback. */
export const LEGACY_SEARCH_DEADLINE_ENV_VAR = 'EVER_JOBS_SEARCH_DEADLINE_MS';

/**
 * Per-request cap on liveness probes (Spec 1723). 100 equals the existing
 * `page_size` ceiling, so a paginated request is never truncated by the cap —
 * only unpaginated JSON / CSV / NDJSON requests are bounded by it.
 */
export const DEFAULT_LIVENESS_MAX_URLS = 100;

export const LIVENESS_ENABLED_ENV_VAR = 'EVER_JOBS_LIVENESS_ENABLED';
export const LIVENESS_MAX_URLS_ENV_VAR = 'EVER_JOBS_LIVENESS_MAX_URLS';

/** A finite number parsed from a non-blank string, else `undefined`. */
function parseFiniteNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the fan-out deadline in milliseconds.
 *
 * Precedence: {@link FANOUT_DEADLINE_ENV_VAR} → {@link LEGACY_SEARCH_DEADLINE_ENV_VAR}
 * → {@link DEFAULT_FANOUT_DEADLINE_MS}. A blank or non-numeric value is
 * treated as unset and falls through to the next source (a typo must not
 * silently disable the deadline). `0` or a negative value is passed through:
 * `JobsService` treats it as "no deadline", as it always has.
 */
export function resolveFanoutDeadlineMs(env: Env): number {
  return (
    parseFiniteNumber(env[FANOUT_DEADLINE_ENV_VAR]) ??
    parseFiniteNumber(env[LEGACY_SEARCH_DEADLINE_ENV_VAR]) ??
    DEFAULT_FANOUT_DEADLINE_MS
  );
}

export interface LivenessConfig {
  /**
   * Server gate. `true` (default) honours the per-request `?liveness=true`
   * flag; `false` never probes, even when requested.
   */
  readonly enabled: boolean;
  /** Probes per request; `0` means no cap. */
  readonly maxUrls: number;
}

/**
 * Resolve the liveness server gate and cap (Spec 1723).
 *
 * `EVER_JOBS_LIVENESS_ENABLED`: unset/blank → `true`; `false/0/no/off`
 * (any case) → `false`; anything else → `true`. Only an explicit "off" word
 * disables it, so a typo leaves the documented default in place.
 *
 * `EVER_JOBS_LIVENESS_MAX_URLS`: unset/blank/non-numeric → 100; `0` or
 * negative → `0` (no cap); otherwise floored.
 */
export function resolveLivenessConfig(env: Env): LivenessConfig {
  const rawEnabled = env[LIVENESS_ENABLED_ENV_VAR]?.trim().toLowerCase();
  const enabled = !(
    rawEnabled !== undefined && ['false', '0', 'no', 'off'].includes(rawEnabled)
  );

  const parsedMax = parseFiniteNumber(env[LIVENESS_MAX_URLS_ENV_VAR]);
  const maxUrls =
    parsedMax === undefined
      ? DEFAULT_LIVENESS_MAX_URLS
      : parsedMax <= 0
        ? 0
        : Math.floor(parsedMax);

  return { enabled, maxUrls };
}
