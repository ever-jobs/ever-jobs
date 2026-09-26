import { CrawlPolicy, CrawlPolicyOverride, normalizeCrawlOverride } from '@ever-jobs/common';
import { CrawlPolicyDto, ScraperInputDto } from '@ever-jobs/models';

// ── Compile-time contract checks (Spec 1690 §5.2) ─────────────────────────
//
// `@ever-jobs/models` cannot import `@ever-jobs/common`, so `CrawlPolicyDto`
// re-declares the string-literal unions of `CrawlPolicy`. These aliases fail the
// build (`tsc -p apps/api/tsconfig.build.json`) the moment the two drift apart:
//   - every DTO field must be assignable to the matching policy field, and
//   - every policy field must exist on the DTO (a knob added to `CrawlPolicy`
//     without a request field would silently be unreachable per request).

type AssertTrue<T extends true> = T;
type IsAssignable<A, B> = [A] extends [B] ? true : false;

/** `CrawlPolicyDto` is a valid `CrawlPolicyOverride`. */
export type CrawlPolicyDtoIsAnOverride = AssertTrue<IsAssignable<CrawlPolicyDto, CrawlPolicyOverride>>;

/** Every `CrawlPolicy` knob is settable through `CrawlPolicyDto`. */
export type CrawlPolicyDtoCoversEveryKnob = AssertTrue<
  [Exclude<keyof CrawlPolicy, keyof CrawlPolicyDto>] extends [never] ? true : false
>;

/** `CrawlPolicyDto` declares nothing `CrawlPolicy` does not know. */
export type CrawlPolicyDtoHasNoExtraFields = AssertTrue<
  [Exclude<keyof CrawlPolicyDto, keyof CrawlPolicy>] extends [never] ? true : false
>;

// ── Caller layer ──────────────────────────────────────────────────────────

/**
 * The request fields that feed the crawl policy's caller layer: the pre-1690
 * flat fields plus the Spec 1690 `crawl` object.
 */
export type CrawlCallerInput = Pick<
  ScraperInputDto,
  'userAgent' | 'rateDelayMin' | 'rateDelayMax' | 'retries' | 'retryDelay' | 'retryBackoff' | 'retryMaxDelay' | 'crawl'
>;

const LEGACY_BACKOFFS: ReadonlySet<string> = new Set(['linear', 'exponential', 'constant']);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Seconds (possibly fractional, possibly negative) → a non-negative integer ms. */
const secondsToMs = (s: number): number => Math.max(0, Math.round(s * 1000));

const nonNegativeInt = (v: number): number => Math.max(0, Math.round(v));

/**
 * Map the pre-1690 flat `ScraperInputDto` fields onto a crawl-policy override
 * (Spec 1690 §4.1). Only fields the caller actually set produce a value — a
 * field left `undefined` never becomes a caller override.
 *
 * - `userAgent` → `userAgent`, plus `userAgentMode: 'strict'` (so the caller's
 *   UA is what goes on the wire) unless `crawl.userAgentMode` is also set.
 * - `rateDelayMin` (s) → `minIntervalMs = min × 1000`.
 * - `rateDelayMax` (s) → `jitterMs = (max − min) × 1000` (min taken as 0 when
 *   only the max was sent; a max below the min gives no jitter).
 * - `retries` / `retryDelay` / `retryBackoff` / `retryMaxDelay` → `retries` /
 *   `retryBaseDelayMs` / `retryBackoff` / `retryMaxDelayMs`.
 *
 * Values that cannot be mapped (non-finite numbers, an unknown backoff) are
 * skipped and reported in `warnings`.
 */
export function legacyCrawlOverride(input: Partial<CrawlCallerInput>): {
  value: CrawlPolicyOverride;
  warnings: string[];
} {
  const value: CrawlPolicyOverride = {};
  const warnings: string[] = [];
  const invalid = (field: string, raw: unknown): void => {
    warnings.push(`ignored ${field}=${JSON.stringify(raw)}: not a finite number`);
  };

  if (input.userAgent !== undefined && input.userAgent !== null) {
    if (typeof input.userAgent === 'string' && input.userAgent.trim() !== '') {
      value.userAgent = input.userAgent;
      if (input.crawl?.userAgentMode === undefined) {
        value.userAgentMode = 'strict';
      }
    } else {
      warnings.push('ignored userAgent: not a non-empty string');
    }
  }

  const min = input.rateDelayMin;
  const max = input.rateDelayMax;
  if (min !== undefined && min !== null) {
    if (isFiniteNumber(min)) value.minIntervalMs = secondsToMs(min);
    else invalid('rateDelayMin', min);
  }
  if (max !== undefined && max !== null) {
    if (isFiniteNumber(max)) {
      const floor = isFiniteNumber(min) ? min : 0;
      value.jitterMs = secondsToMs(max - floor);
    } else {
      invalid('rateDelayMax', max);
    }
  }

  if (input.retries !== undefined && input.retries !== null) {
    if (isFiniteNumber(input.retries)) value.retries = Math.max(0, Math.floor(input.retries));
    else invalid('retries', input.retries);
  }
  if (input.retryDelay !== undefined && input.retryDelay !== null) {
    if (isFiniteNumber(input.retryDelay)) value.retryBaseDelayMs = nonNegativeInt(input.retryDelay);
    else invalid('retryDelay', input.retryDelay);
  }
  if (input.retryBackoff !== undefined && input.retryBackoff !== null) {
    const backoff = String(input.retryBackoff);
    if (LEGACY_BACKOFFS.has(backoff)) {
      value.retryBackoff = backoff as CrawlPolicy['retryBackoff'];
    } else {
      warnings.push(`ignored retryBackoff=${JSON.stringify(input.retryBackoff)}: expected linear | exponential | constant`);
    }
  }
  if (input.retryMaxDelay !== undefined && input.retryMaxDelay !== null) {
    if (isFiniteNumber(input.retryMaxDelay)) value.retryMaxDelayMs = nonNegativeInt(input.retryMaxDelay);
    else invalid('retryMaxDelay', input.retryMaxDelay);
  }

  return { value, warnings };
}

/** Own, defined fields of a (possibly class-instance) crawl object. */
function definedFields(obj: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [key, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Everything a search caller asked for, as one validated override: the legacy
 * flat fields (see {@link legacyCrawlOverride}) overlaid by `input.crawl` (the
 * explicit Spec 1690 object wins where both set a field), then validated by
 * `normalizeCrawlOverride` (the same validator the env/file layers use, so
 * REST, GraphQL, MCP, CLI and direct callers are held to one standard).
 *
 * Returns `override: undefined` when the caller set nothing.
 *
 * The value is deliberately NOT filtered by `EVER_JOBS_CRAWL_CALLER_OVERRIDES`
 * here: `resolveCrawlPolicy` filters the caller layer per request, against the
 * policy that request's *host* would get without the caller. Filtering now,
 * with no host, would judge a caller's `maxConcurrentPerHost: 8` against the
 * generic cap of 4 and drop it, although it is stricter than the builtin 16 of
 * the bulk ATS host the request actually goes to.
 */
export function buildCallerCrawlOverride(input: Partial<CrawlCallerInput>): {
  override?: CrawlPolicyOverride;
  warnings: string[];
} {
  const legacy = legacyCrawlOverride(input);
  const explicit = definedFields(input.crawl);
  if (input.crawl !== undefined && input.crawl !== null && (typeof input.crawl !== 'object' || Array.isArray(input.crawl))) {
    legacy.warnings.push('ignored crawl: expected an object');
  }
  const merged: Record<string, unknown> = { ...legacy.value, ...explicit };
  if (Object.keys(merged).length === 0) {
    return { warnings: legacy.warnings };
  }
  const normalized = normalizeCrawlOverride(merged);
  const warnings = [...legacy.warnings, ...normalized.warnings];
  return Object.keys(normalized.value).length > 0
    ? { override: normalized.value, warnings }
    : { warnings };
}

// ── Pseudo-sites (crawl-policy site keys that are not a `Site`) ─────────────

/**
 * Crawl-policy site key for liveness enrichment (Spec 1690). The probes run in a
 * scrape context under this site, so they obey the global crawl policy (honest
 * UA, per-host pacing, back-off, egress guard) and an operator can tune them on
 * their own with `EVER_JOBS_CRAWL_POLICIES={"sites":{"liveness-http":{...}}}`.
 */
export const LIVENESS_CRAWL_SITE = 'liveness-http';

/**
 * Site keys the API runs crawl traffic under that are neither a `Site` nor a
 * registered plugin. `GET /api/sources/:site/crawl-policy` accepts them too.
 */
export const CRAWL_PSEUDO_SITES: readonly string[] = [LIVENESS_CRAWL_SITE];

/** Environment variable bounding one liveness-enrichment batch, ms. */
export const LIVENESS_DEADLINE_ENV = 'EVER_JOBS_LIVENESS_DEADLINE_MS';

/** Default bound on one liveness-enrichment batch (queued + in-flight probes), ms. */
export const DEFAULT_LIVENESS_DEADLINE_MS = 60_000;

/**
 * The liveness batch deadline: `EVER_JOBS_LIVENESS_DEADLINE_MS` (a non-negative
 * integer; `0` = no deadline), else `DEFAULT_LIVENESS_DEADLINE_MS`. When it
 * passes, probes still queued behind a paced or cooling-down host are aborted
 * (and reported `uncertain`) instead of holding the search response.
 */
export function livenessDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[LIVENESS_DEADLINE_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_LIVENESS_DEADLINE_MS;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_LIVENESS_DEADLINE_MS;
}
