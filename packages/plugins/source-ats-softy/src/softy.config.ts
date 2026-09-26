import { Logger } from '@nestjs/common';
import {
  SOFTY_DETAIL_CACHE_MAX,
  SOFTY_DETAIL_CACHE_TTL_MS,
  SOFTY_ENV,
  SOFTY_LASTMOD_AS_DATE_POSTED,
  SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES,
  SOFTY_MAX_DETAIL_FETCHES,
  SOFTY_MAX_LIST_PAGES,
} from './softy.constants';
import { SoftyConfig } from './softy.types';

const logger = new Logger('SoftyConfig');

/** Invalid values already warned about (a bad env value is reported once, not per scrape). */
const warned = new Set<string>();

function warnOnce(name: string, raw: string, fallback: unknown): void {
  const key = `${name}=${raw}`;
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(`Ignoring invalid ${name}=${JSON.stringify(raw)}; using ${String(fallback)}`);
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim();
  if (!/^\d+$/.test(value) || Number(value) < min || !Number.isSafeInteger(Number(value))) {
    warnOnce(name, raw, fallback);
    return fallback;
  }
  return Number(value);
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

/**
 * The Softy knobs for one scrape: the constants in `softy.constants.ts`, each
 * overridable by the environment variable of the same name (`SOFTY_ENV`). Invalid
 * values are ignored with a one-time warning, never a crash. Read per scrape, so a
 * changed environment applies without a restart.
 *
 * | Variable | Default | Accepted |
 * |---|---|---|
 * | `SOFTY_MAX_LIST_PAGES` | 50 | integer >= 1 |
 * | `SOFTY_MAX_DETAIL_FETCHES` | 100 | integer >= 0 |
 * | `SOFTY_DETAIL_CACHE_MAX` | 500 | integer >= 0 (0 disables the cache) |
 * | `SOFTY_DETAIL_CACHE_TTL_MS` | 21600000 (6 h) | integer >= 0 (0 = no expiry) |
 * | `SOFTY_LASTMOD_AS_DATE_POSTED` | true | true/false/1/0/yes/no/on/off |
 * | `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES` | 3 | integer >= 0 (0 = never stop early) |
 */
export function readSoftyConfig(env: NodeJS.ProcessEnv = process.env): SoftyConfig {
  return {
    maxListPages: readInt(env, SOFTY_ENV.MAX_LIST_PAGES, SOFTY_MAX_LIST_PAGES, 1),
    maxDetailFetches: readInt(env, SOFTY_ENV.MAX_DETAIL_FETCHES, SOFTY_MAX_DETAIL_FETCHES, 0),
    detailCacheMax: readInt(env, SOFTY_ENV.DETAIL_CACHE_MAX, SOFTY_DETAIL_CACHE_MAX, 0),
    detailCacheTtlMs: readInt(env, SOFTY_ENV.DETAIL_CACHE_TTL_MS, SOFTY_DETAIL_CACHE_TTL_MS, 0),
    lastmodAsDatePosted: readBool(env, SOFTY_ENV.LASTMOD_AS_DATE_POSTED, SOFTY_LASTMOD_AS_DATE_POSTED),
    maxConsecutiveDetailFailures: readInt(
      env,
      SOFTY_ENV.MAX_CONSECUTIVE_DETAIL_FAILURES,
      SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES,
      0,
    ),
  };
}
