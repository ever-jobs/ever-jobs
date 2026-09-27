import {
  CallerOverridesResolution,
  CallerRequestTimeoutDecision,
  CrawlPolicy,
  CrawlPolicyEnvConfig,
  CrawlPolicyOverride,
  DEFAULT_REQUEST_TIMEOUT_SECONDS,
  crawlStricterRules,
  gateCallerRequestTimeout,
  normalizeCrawlOverride,
  readCrawlPolicyEnv,
} from '@ever-jobs/common';
import { Logger } from '@nestjs/common';
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

// ── Spec 1714 API switches ──────────────────────────────────────────────────
//
// Each switch below defaults to its NEW behaviour, except under
// `EVER_JOBS_CRAWL_PRESET=legacy`, where it defaults to its pre-1714 value, like
// the crawl switches of `CRAWL_EXTRA_ENV` (Spec 1715 review F7). An explicit value
// always wins over the preset. An unrecognised value keeps the default and is
// logged once per variable and value (review F8).

const switchLogger = new Logger('SearchSwitches');

/** `name=raw` pairs already reported as invalid, so each is logged once per process. */
const reportedInvalidSwitches = new Set<string>();

/** Forget which invalid switch values were reported (tests). */
export function resetSwitchWarnings(): void {
  reportedInvalidSwitches.clear();
}

/**
 * Log `name=raw` as invalid once per process (per variable and value), naming the
 * value used instead. Returns whether this call logged it.
 */
export function warnInvalidSwitchOnce(name: string, raw: string, expected: string, used: string): boolean {
  const key = `${name}=${raw}`;
  if (reportedInvalidSwitches.has(key)) return false;
  reportedInvalidSwitches.add(key);
  switchLogger.warn(`${name}=${JSON.stringify(raw)} is not ${expected}; using ${used}`);
  return true;
}

/**
 * Whether `EVER_JOBS_CRAWL_PRESET` resolves to `legacy` — read through the crawl
 * policy env parse, so a spelling the crawl layer accepts (`LEGACY`, ` legacy `)
 * counts here too, and an invalid preset (which the crawl layer replaces with
 * `polite`, with a warning) does not. `process.env` is parsed once per process
 * (`resetCrawlPolicyEnvCache()` after changing it); an explicit `env` is parsed fresh.
 */
export function crawlPresetIsLegacy(env: NodeJS.ProcessEnv = process.env): boolean {
  return readCrawlPolicyEnv(env).preset === 'legacy';
}

const TRUE_SWITCH_WORDS: readonly string[] = ['true', '1', 'yes', 'on'];
const FALSE_SWITCH_WORDS: readonly string[] = ['false', '0', 'no', 'off'];

/**
 * A boolean switch: `true` / `1` / `yes` / `on` → true, `false` / `0` / `no` /
 * `off` → false (case-insensitive); unset or empty → `fallback`; anything else →
 * `fallback`, logged once ({@link warnInvalidSwitchOnce}). Never throws, like every
 * crawl env value.
 */
function boolEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '') return fallback;
  if (TRUE_SWITCH_WORDS.includes(value)) return true;
  if (FALSE_SWITCH_WORDS.includes(value)) return false;
  warnInvalidSwitchOnce(name, raw, 'a boolean (true/false/1/0/yes/no/on/off)', String(fallback));
  return fallback;
}

/**
 * Environment variable: in a multi-location search, a source answering 503
 * (thrown, or a resolved `fetch_error` diagnostic whose detail names 503 /
 * "Service Unavailable") is a refusal, so its remaining locations are not
 * attempted (Spec 1714 FR-14, audit G17). Default `true` (`false` under
 * `EVER_JOBS_CRAWL_PRESET=legacy`). **`false` restores the pre-1714 behaviour**
 * (only 429, `rate_limited`, `blocked` and an open circuit stop the loop; a 503
 * source is asked again for every location).
 */
export const SEARCH_STOP_ON_503_ENV = 'EVER_JOBS_SEARCH_STOP_ON_503';

/** `EVER_JOBS_SEARCH_STOP_ON_503` (default `true`, `false` under the `legacy` preset; `false` = pre-1714). */
export function searchStopOn503(env: NodeJS.ProcessEnv = process.env): boolean {
  return boolEnv(env, SEARCH_STOP_ON_503_ENV, !crawlPresetIsLegacy(env));
}

/**
 * Environment variable: `?liveness=true` trusts a fresh plugin fetch (Spec 1714
 * FR-16, audit G4/G28). A job whose `jobUrlFetchedAt` is not older than the start
 * of this request — the plugin itself fetched and parsed its `jobUrl` during this
 * very search — is marked `liveness: { state: 'active', reason: 'fresh-fetch' }`
 * instead of being probed again (a second GET of the same page moments later,
 * outside the source's own pacing). A search-cache hit never counts as fresh.
 * Default `true` (`false` under `EVER_JOBS_CRAWL_PRESET=legacy`). **`false`
 * restores the pre-1714 behaviour** for this evidence; a job whose listing is
 * trusted instead ({@link LIVENESS_TRUST_LISTED_MAX_AGE_ENV}) is still not probed,
 * so every URL is probed only with that switch at `0` too.
 */
export const LIVENESS_TRUST_FRESH_FETCH_ENV = 'EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH';

/** `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH` (default `true`, `false` under the `legacy` preset; `false` = pre-1714). */
export function livenessTrustFreshFetch(env: NodeJS.ProcessEnv = process.env): boolean {
  return boolEnv(env, LIVENESS_TRUST_FRESH_FETCH_ENV, !crawlPresetIsLegacy(env));
}

/**
 * Environment variable: how old, at most, a job's `jobUrlListedAt` may be for
 * `?liveness=true` to trust it instead of probing `jobUrl`, ms (Spec 1715 review
 * A3). `jobUrlListedAt` is the instant the source's own index (Softy: the tenant's
 * `/sitemap.xml`) that lists the offer was fetched from the network, whether this
 * request fetched it or read it from the plugin's sitemap cache. The age is
 * measured against NOW, not against the request start, so a search-cache hit is
 * trusted too while the listing is young enough. A trusted job is marked
 * `liveness: { state: 'active', checkedAt: jobUrlListedAt, reason: 'listed' }`.
 *
 * Default {@link DEFAULT_LIVENESS_TRUST_LISTED_MAX_AGE_MS} (10 min, the Softy
 * sitemap cache TTL); `0` under `EVER_JOBS_CRAWL_PRESET=legacy`. **`0` turns it
 * off** (the pre-fix behaviour: only a fresh fetch is trusted). A non-negative
 * integer; anything else keeps the default and is logged once.
 */
export const LIVENESS_TRUST_LISTED_MAX_AGE_ENV = 'EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS';

/** Default of {@link LIVENESS_TRUST_LISTED_MAX_AGE_ENV}, ms (10 min). */
export const DEFAULT_LIVENESS_TRUST_LISTED_MAX_AGE_MS = 600_000;

/**
 * `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS`: unset or empty → 600 000 (`0`
 * under the `legacy` preset); a non-negative integer → that value (`0` = off);
 * anything else → the default, logged once.
 */
export function livenessTrustListedMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const fallback = crawlPresetIsLegacy(env) ? 0 : DEFAULT_LIVENESS_TRUST_LISTED_MAX_AGE_MS;
  const raw = env[LIVENESS_TRUST_LISTED_MAX_AGE_ENV];
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (/^\d+$/.test(trimmed) && Number.isSafeInteger(value)) return value;
  warnInvalidSwitchOnce(LIVENESS_TRUST_LISTED_MAX_AGE_ENV, raw, 'a non-negative integer (ms; 0 = off)', String(fallback));
  return fallback;
}

/**
 * The `requestTimeout` (seconds) one source gets, gated by that source's
 * effective caller-override mode (Spec 1714 FR-7, audit K3):
 *
 * - `any` → the caller's value unchanged (pre-1714);
 * - `stricter` → the caller's value only when it is ≥ the default
 *   ({@link DEFAULT_REQUEST_TIMEOUT_SECONDS}, 60 s), else the default — a tiny
 *   timeout abandons a request client-side while the server is still rendering
 *   it, so the next paced request overlaps it on the server;
 * - `none` → the default (the caller's value is ignored).
 *
 * `EVER_JOBS_CRAWL_STRICTER_RULES=1690` leaves `requestTimeout` ungated (the
 * pre-1714 behaviour). `lock` is `resolveCallerOverrides({ site, plugin })`.
 */
export function callerRequestTimeout(
  input: Pick<ScraperInputDto, 'requestTimeout'>,
  lock: Pick<CallerOverridesResolution, 'mode'>,
  env: CrawlPolicyEnvConfig = readCrawlPolicyEnv(),
): CallerRequestTimeoutDecision {
  return gateCallerRequestTimeout(input.requestTimeout, lock.mode, DEFAULT_REQUEST_TIMEOUT_SECONDS, crawlStricterRules(env));
}
