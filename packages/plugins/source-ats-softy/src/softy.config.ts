import { Logger } from '@nestjs/common';
import {
  SOFTY_DETAIL_ATTEMPT_SLACK,
  SOFTY_DETAIL_CACHE_MAX,
  SOFTY_DETAIL_CACHE_TTL_MS,
  SOFTY_ENV,
  SOFTY_LASTMOD_AS_DATE_POSTED,
  SOFTY_LEGACY_TOKENS,
  SOFTY_LISTING_DETAIL_CACHE_TTL_MS,
  SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES,
  SOFTY_MAX_DETAIL_FETCHES,
  SOFTY_MAX_LIST_PAGES,
  SOFTY_MIN_INTERVAL_FLOOR_MS,
  SOFTY_SITEMAP_CACHE_TTL_MS,
  SOFTY_SITEMAP_FALLBACK,
  SOFTY_SITEMAP_FALLBACKS,
  SOFTY_UNKNOWN_TENANT_TTL_MAX_MS,
  SOFTY_UNKNOWN_TENANT_TTL_MS,
  SoftyLegacyToken,
  SoftySitemapFallback,
} from './softy.constants';
import { SoftyConfig } from './softy.types';

const logger = new Logger('SoftyConfig');

/** Invalid values already warned about (a bad env value is reported once, not per scrape). */
const warned = new Set<string>();

function warnOnceMessage(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

function warnOnce(name: string, raw: string, fallback: unknown): void {
  warnOnceMessage(`${name}=${raw}`, `Ignoring invalid ${name}=${JSON.stringify(raw)}; using ${String(fallback)}`);
}

/** Forget which invalid values were already reported (tests). */
export function resetSoftyConfigWarnings(): void {
  warned.clear();
}

/** The integer in `env[name]`, or undefined when unset / empty / invalid (invalid is warned once). */
function readOptionalInt(env: NodeJS.ProcessEnv, name: string, min: number, fallbackLabel: unknown): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (!/^\d+$/.test(value) || Number(value) < min || !Number.isSafeInteger(Number(value))) {
    warnOnce(name, raw, fallbackLabel);
    return undefined;
  }
  return Number(value);
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  return readOptionalInt(env, name, min, fallback) ?? fallback;
}

/** `readInt`, then clamped to `max` with a one-time warning. */
function readClampedInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const value = readInt(env, name, fallback, min);
  if (value <= max) return value;
  warnOnceMessage(`${name}=${env[name]}:clamp`, `${name}=${JSON.stringify(env[name])} is above the maximum; using ${max}`);
  return max;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  warnOnce(name, raw, fallback);
  return fallback;
}

function readSitemapFallback(env: NodeJS.ProcessEnv): SoftySitemapFallback {
  const raw = env[SOFTY_ENV.SITEMAP_FALLBACK];
  if (raw === undefined || raw.trim() === '') return SOFTY_SITEMAP_FALLBACK;
  const value = raw.trim().toLowerCase().replace(/_/g, '-');
  if ((SOFTY_SITEMAP_FALLBACKS as readonly string[]).includes(value)) return value as SoftySitemapFallback;
  warnOnce(SOFTY_ENV.SITEMAP_FALLBACK, raw, SOFTY_SITEMAP_FALLBACK);
  return SOFTY_SITEMAP_FALLBACK;
}

/**
 * `SOFTY_LEGACY`: a comma (or whitespace) separated list of `SOFTY_LEGACY_TOKENS`,
 * case-insensitive; `all` = every token. Unknown tokens are warned about once and
 * ignored. Unset / empty = none (the Spec 1715 defaults).
 */
export function readSoftyLegacy(env: NodeJS.ProcessEnv = process.env): ReadonlySet<SoftyLegacyToken> {
  const raw = env[SOFTY_ENV.LEGACY];
  const tokens = new Set<SoftyLegacyToken>();
  if (raw === undefined || raw.trim() === '') return tokens;
  for (const part of raw.split(/[\s,]+/)) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    if (token === 'all') {
      for (const t of SOFTY_LEGACY_TOKENS) tokens.add(t);
      continue;
    }
    if ((SOFTY_LEGACY_TOKENS as readonly string[]).includes(token)) {
      tokens.add(token as SoftyLegacyToken);
      continue;
    }
    warnOnceMessage(
      `${SOFTY_ENV.LEGACY}:${token}`,
      `Ignoring unknown ${SOFTY_ENV.LEGACY} token ${JSON.stringify(part.trim())} ` +
        `(known: ${SOFTY_LEGACY_TOKENS.join(', ')}, all)`,
    );
  }
  return tokens;
}

/**
 * The Softy knobs for one scrape: the constants in `softy.constants.ts`, each
 * overridable by the environment variable of the same name (`SOFTY_ENV`). Invalid
 * values are ignored with a one-time warning, never a crash. Read per scrape, so a
 * changed environment applies without a restart.
 *
 * | Variable | Default | Accepted | Pre-1715 behaviour |
 * |---|---|---|---|
 * | `SOFTY_MAX_LIST_PAGES` | 50 | integer >= 0 (0 disables list pages) | — (minimum was 1) |
 * | `SOFTY_MAX_DETAIL_FETCHES` | 100 | integer >= 0 | — |
 * | `SOFTY_DETAIL_CACHE_MAX` | 500 | integer >= 0 (0 disables the cache) | — |
 * | `SOFTY_DETAIL_CACHE_TTL_MS` | unset: sitemap entries never expire, listing entries 6 h | integer >= 0 (set: every entry, 0 = no expiry) | `21600000` |
 * | `SOFTY_LASTMOD_AS_DATE_POSTED` | true | true/false/1/0/yes/no/on/off | — |
 * | `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` | 1 | integer >= 0 (0 = never stop early) | `3` |
 * | `SOFTY_SITEMAP_FALLBACK` | `empty` | `empty` / `missing` / `any-error` (case-insensitive) | `any-error` |
 * | `SOFTY_UNKNOWN_TENANT_TTL_MS` | 3600000 (1 h) | integer 0..86400000 (above: clamped; 0 disables) | `0` |
 * | `SOFTY_DETAIL_ATTEMPT_SLACK` | 5 | integer >= 0 | a value >= `SOFTY_MAX_DETAIL_FETCHES` |
 * | `SOFTY_SITEMAP_CACHE_TTL_MS` | 600000 (10 min) | integer >= 0 (0 disables) | `0` |
 * | `SOFTY_LEGACY` | (none) | comma list of `SOFTY_LEGACY_TOKENS`, or `all` | `all` |
 *
 * Derived: `listingDetailCacheTtlMs` (FR-13) and `minIntervalFloorMs` (1000, or 0
 * with `SOFTY_LEGACY=no-interval-floor`; FR-2).
 *
 * Which path `auto` discovery takes (Spec 1715 FR-11, D5; round 2, A1):
 *
 * | Request | Path | Why |
 * |---|---|---|
 * | `descriptionDepth: 'board'` | list pages (unless an OPERATOR chose `sitemap`) | Kept on purpose (D5): a board-only result needs no detail page, and one list page carries 21 offers, so `/offers?page=1..N` is FEWER requests than `/sitemap.xml` plus one detail page per offer — the sitemap entries carry nothing but a URL. |
 * | detail budget (`detail-25`, `SOFTY_MAX_DETAIL_FETCHES`) < `resultsWanted`, under a caller lock (`callerOverrides` `stricter` / `none`, the Softy default) | sitemap, up to the budget, with a `partial` note | Softy asked for sitemap discovery; `resultsWanted` / `descriptionDepth` are caller parameters, so a caller must not be able to steer the scrape to list pages with them. `SOFTY_LEGACY=caller-listing` restores the listing. |
 * | the same, but the `auto` itself came from an operator layer (`EVER_JOBS_CRAWL_DISCOVERY=auto`, `sites.softy` / `hosts[…]` `discovery: 'auto'`), the lock is lifted (`callerOverrides: 'any'`), or `SOFTY_MAX_DETAIL_FETCHES=0` (the operator turned detail pages off) | list pages, board-only beyond the budget (as before round 2) | The operator's choice. |
 * | anything else | sitemap | — |
 */
export function readSoftyConfig(env: NodeJS.ProcessEnv = process.env): SoftyConfig {
  const legacy = readSoftyLegacy(env);
  // FR-13: an explicit SOFTY_DETAIL_CACHE_TTL_MS keeps its pre-1715 meaning for every
  // entry; unset, sitemap entries (keyed url|lastmod) never expire and listing
  // entries (keyed url) keep 6 h.
  const envTtl = readOptionalInt(
    env,
    SOFTY_ENV.DETAIL_CACHE_TTL_MS,
    0,
    `the default (sitemap entries ${SOFTY_DETAIL_CACHE_TTL_MS}, listing entries ${SOFTY_LISTING_DETAIL_CACHE_TTL_MS})`,
  );
  return {
    maxListPages: readInt(env, SOFTY_ENV.MAX_LIST_PAGES, SOFTY_MAX_LIST_PAGES, 0),
    maxDetailFetches: readInt(env, SOFTY_ENV.MAX_DETAIL_FETCHES, SOFTY_MAX_DETAIL_FETCHES, 0),
    detailCacheMax: readInt(env, SOFTY_ENV.DETAIL_CACHE_MAX, SOFTY_DETAIL_CACHE_MAX, 0),
    detailCacheTtlMs: envTtl ?? SOFTY_DETAIL_CACHE_TTL_MS,
    listingDetailCacheTtlMs: envTtl ?? SOFTY_LISTING_DETAIL_CACHE_TTL_MS,
    lastmodAsDatePosted: readBool(env, SOFTY_ENV.LASTMOD_AS_DATE_POSTED, SOFTY_LASTMOD_AS_DATE_POSTED),
    maxConsecutiveDetailFailures: readInt(
      env,
      SOFTY_ENV.MAX_CONSECUTIVE_DETAIL_FAILURES,
      SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES,
      0,
    ),
    sitemapFallback: readSitemapFallback(env),
    unknownTenantTtlMs: readClampedInt(
      env,
      SOFTY_ENV.UNKNOWN_TENANT_TTL_MS,
      SOFTY_UNKNOWN_TENANT_TTL_MS,
      0,
      SOFTY_UNKNOWN_TENANT_TTL_MAX_MS,
    ),
    detailAttemptSlack: readInt(env, SOFTY_ENV.DETAIL_ATTEMPT_SLACK, SOFTY_DETAIL_ATTEMPT_SLACK, 0),
    sitemapCacheTtlMs: readInt(env, SOFTY_ENV.SITEMAP_CACHE_TTL_MS, SOFTY_SITEMAP_CACHE_TTL_MS, 0),
    minIntervalFloorMs: legacy.has('no-interval-floor') ? 0 : SOFTY_MIN_INTERVAL_FLOOR_MS,
    legacy,
  };
}
