import type { CrawlStricterRules } from './env';
import { CallerOverridePolicy } from './types';

/**
 * Caller-override lock helpers (Spec 1714). A site owner's lock
 * (`callerOverrides` on a plugin manifest or a builtin host policy) and the
 * operator's global `EVER_JOBS_CRAWL_CALLER_OVERRIDES` combine to the most
 * restrictive mode; these helpers are the pure pieces of that rule, shared by the
 * resolver and the API.
 */

/** How restrictive each caller-override mode is: `any` 0 < `stricter` 1 < `none` 2. */
export const CALLER_OVERRIDES_RANK: Readonly<Record<CallerOverridePolicy, number>> = Object.freeze({
  any: 0,
  stricter: 1,
  none: 2,
});

/** Whether `mode` is one of `any` / `stricter` / `none`. */
export function isCallerOverridePolicy(mode: unknown): mode is CallerOverridePolicy {
  return typeof mode === 'string' && Object.prototype.hasOwnProperty.call(CALLER_OVERRIDES_RANK, mode);
}

/**
 * The most restrictive of `modes` (`none` > `stricter` > `any`); `undefined` and
 * unknown values are skipped. `undefined` when none is a known mode.
 */
export function mostRestrictiveCallerOverrides(
  ...modes: Array<CallerOverridePolicy | undefined>
): CallerOverridePolicy | undefined {
  let out: CallerOverridePolicy | undefined;
  for (const mode of modes) {
    if (!isCallerOverridePolicy(mode)) continue;
    if (out === undefined || CALLER_OVERRIDES_RANK[mode] > CALLER_OVERRIDES_RANK[out]) out = mode;
  }
  return out;
}

/** The request timeout, seconds, a search gets when the caller sends none (`ScraperInputDto.requestTimeout`). */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 60;

/** What `gateCallerRequestTimeout` decided. */
export interface CallerRequestTimeoutDecision {
  /** The timeout (seconds) to use; `requested` unchanged under `any`. */
  value: number | undefined;
  /** False when the caller's value was replaced by the default. */
  accepted: boolean;
  /** Why the caller's value was replaced (for a debug log line). */
  note?: string;
}

/**
 * Gate a search caller's `requestTimeout` (the flat DTO field, in SECONDS) with
 * the effective caller-override mode of the source it goes to (Spec 1714 FR-7,
 * audit K3): a tiny timeout abandons a request client-side while the server is
 * still rendering it, so the next paced request overlaps it on the server.
 *
 * | Mode       | Result                                                                  |
 * |------------|-------------------------------------------------------------------------|
 * | `any`      | `requested`, unchanged (the pre-1714 behaviour)                         |
 * | `stricter` | `requested` when it is a finite number ≥ the default, else the default |
 * | `none`     | the default (the caller's value is ignored)                             |
 *
 * `undefined` / `null` (the caller sent nothing) is never "replaced": `any` passes
 * it through, `stricter` / `none` answer the default. An unknown mode is treated
 * as `stricter` (fail safe). `rules: '1690'` (`EVER_JOBS_CRAWL_STRICTER_RULES=1690`)
 * passes every value through unchanged — `requestTimeout` was not gated before
 * Spec 1714.
 */
export function gateCallerRequestTimeout(
  requested: unknown,
  mode: CallerOverridePolicy,
  resolvedDefaultSeconds: number = DEFAULT_REQUEST_TIMEOUT_SECONDS,
  rules: CrawlStricterRules = '1714',
): CallerRequestTimeoutDecision {
  const passThrough: CallerRequestTimeoutDecision = { value: requested as number | undefined, accepted: true };
  if (rules === '1690' || mode === 'any') return passThrough;

  const fallback =
    typeof resolvedDefaultSeconds === 'number' && Number.isFinite(resolvedDefaultSeconds) && resolvedDefaultSeconds > 0
      ? resolvedDefaultSeconds
      : DEFAULT_REQUEST_TIMEOUT_SECONDS;
  if (requested === undefined || requested === null) return { value: fallback, accepted: true };

  const finite = typeof requested === 'number' && Number.isFinite(requested);
  if (mode === 'none') {
    if (finite && requested === fallback) return { value: fallback, accepted: true };
    return {
      value: fallback,
      accepted: false,
      note: `requestTimeout ${describeSeconds(requested)} ignored (caller overrides "none"); using ${fallback}s`,
    };
  }
  // `stricter` (and any unknown mode, fail safe): only a timeout at least as long as the default.
  if (finite && (requested as number) >= fallback) return { value: requested as number, accepted: true };
  return {
    value: fallback,
    accepted: false,
    note: `requestTimeout ${describeSeconds(requested)} is shorter than the default ${fallback}s (caller overrides "stricter"); using ${fallback}s`,
  };
}

function describeSeconds(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? `${value}s` : String(value);
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
