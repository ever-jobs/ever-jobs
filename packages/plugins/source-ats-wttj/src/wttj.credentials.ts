/**
 * Public search credentials for the Welcome to the Jungle (WTTJ) job index, and their
 * self-heal (Spec 1705 work item C).
 *
 * The index is queried with a search-only key the site's own front-end publishes. When
 * that key rotates, every query is refused; before Spec 1705 the refusal looked exactly
 * like an empty board. This module keeps one in-process copy of the credentials, seeded
 * from the built-in constants, and re-reads them from a public job detail page (which
 * embeds them in its inline `window.env = {...}` script) when the index refuses a key.
 *
 * - Single-flight: concurrent refusals share one refresh.
 * - At most one refresh per {@link WTTJ_CREDENTIAL_REFRESH_COOLDOWN_MS}, so a key that
 *   stays refused cannot turn into a stream of page fetches.
 * - Only https detail paths on the site's own host, without a query string (the site's
 *   robots.txt disallows `/*?`), are fetched.
 * - The key is public, but only its first 6 characters are ever logged.
 */
import { Logger } from '@nestjs/common';
import { pinUrlToHosts } from '@ever-jobs/common';
import {
  WTTJ_ALGOLIA_API_KEY,
  WTTJ_ALGOLIA_APP_ID,
  WTTJ_ALGOLIA_JOBS_INDEX_PREFIX,
  WTTJ_CREDENTIAL_HOSTS,
  WTTJ_CREDENTIAL_REFRESH_COOLDOWN_MS,
  WTTJ_CREDENTIAL_REJECTION_REGEX,
  WTTJ_DEFAULT_CREDENTIALS_SEED_URL,
  WTTJ_ENV,
  WTTJ_RUNTIME_API_KEY_REGEX,
  WTTJ_RUNTIME_APP_ID_REGEX,
  WTTJ_RUNTIME_INDEX_PREFIX_REGEX,
} from './wttj.constants';

/** The credentials a query is sent with. */
export interface WttjCredentials {
  /** Algolia application id (also names the DSN host). */
  appId: string;
  /** Public search-only key. */
  apiKey: string;
  /** Job index prefix (`{prefix}_{locale}`). */
  indexPrefix: string;
  /** When these were read from a page (epoch ms); 0 for the built-in constants. */
  fetchedAt: number;
}

/** What a credential page yielded. `indexPrefix` is null when the page did not carry it. */
export interface WttjRuntimeCredentials {
  appId: string;
  apiKey: string;
  indexPrefix: string | null;
}

/** Fetches one page as text; resolves null (or throws) when it cannot. */
export type WttjHtmlFetcher = (url: string) => Promise<string | null>;

const logger = new Logger('WttjCredentials');

function builtInCredentials(): WttjCredentials {
  return {
    appId: WTTJ_ALGOLIA_APP_ID,
    apiKey: WTTJ_ALGOLIA_API_KEY,
    indexPrefix: WTTJ_ALGOLIA_JOBS_INDEX_PREFIX,
    fetchedAt: 0,
  };
}

let current: WttjCredentials = builtInCredentials();
let inFlight: Promise<WttjCredentials | null> | null = null;
let lastRefreshStartedAt = 0;
let lastDetailUrl: string | null = null;

/** A copy of the credentials queries should use now. */
export function currentWttjCredentials(): WttjCredentials {
  return { ...current };
}

/** True when two credential sets would send the same query. */
export function sameWttjCredentials(a: WttjCredentials, b: WttjCredentials): boolean {
  return a.appId === b.appId && a.apiKey === b.apiKey && a.indexPrefix === b.indexPrefix;
}

/** The first 6 characters of a key, for a log line. */
export function maskWttjKey(key: string): string {
  return `${key.slice(0, 6)}...`;
}

/** The request headers that carry a credential set. */
export function wttjCredentialHeaders(creds: WttjCredentials): Record<string, string> {
  return {
    'x-algolia-application-id': creds.appId,
    'x-algolia-api-key': creds.apiKey,
  };
}

/**
 * Does this response mean the key (or the referer) was refused? HTTP 401 / 403 always
 * does; HTTP 400, or a response with no error status (`status` undefined), does when its
 * message says so.
 */
export function isWttjCredentialRejection(status: number | undefined, message: unknown): boolean {
  if (status === 401 || status === 403) return true;
  if (status !== undefined && status !== 400) return false;
  return typeof message === 'string' && WTTJ_CREDENTIAL_REJECTION_REGEX.test(message);
}

/**
 * Read the runtime search config from a detail page's HTML, or null when the app id or
 * key is missing. Every pattern is anchored on a fixed key name, so the scan is linear.
 */
export function extractWttjCredentials(html: string | null | undefined): WttjRuntimeCredentials | null {
  if (typeof html !== 'string' || html.length === 0) return null;
  const appId = WTTJ_RUNTIME_APP_ID_REGEX.exec(html)?.[1];
  const apiKey = WTTJ_RUNTIME_API_KEY_REGEX.exec(html)?.[1];
  if (!appId || !apiKey) return null;
  const indexPrefix = WTTJ_RUNTIME_INDEX_PREFIX_REGEX.exec(html)?.[1] ?? null;
  return { appId, apiKey, indexPrefix };
}

/**
 * A credential page URL we are willing to fetch: https, on the site's own host (or a
 * subdomain), no credentials, no explicit port, no query string, no fragment. Returns the
 * normalised URL or null.
 */
export function allowedWttjSeedUrl(raw: string | null | undefined): string | null {
  const pinned = pinUrlToHosts(raw, WTTJ_CREDENTIAL_HOSTS);
  if (!pinned) return null;
  try {
    const url = new URL(pinned);
    if (url.search || url.hash) return null;
    if (url.pathname === '/' || url.pathname === '') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Remember a detail URL built from a hit the index just served (the preferred seed). */
export function rememberWttjDetailUrl(url: string | null | undefined): void {
  const allowed = allowedWttjSeedUrl(url);
  if (allowed) lastDetailUrl = allowed;
}

/**
 * Pages to read the credentials from, in order: the last detail URL this process built
 * from a served hit, then `WTTJ_CREDENTIALS_SEED_URL`, then the built-in seed page.
 * Unsafe or duplicate URLs are dropped.
 */
export function wttjCredentialSeedUrls(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const candidates = [lastDetailUrl, env[WTTJ_ENV.CREDENTIALS_SEED_URL], WTTJ_DEFAULT_CREDENTIALS_SEED_URL];
  const out: string[] = [];
  for (const candidate of candidates) {
    const allowed = allowedWttjSeedUrl(candidate);
    if (allowed && !out.includes(allowed)) out.push(allowed);
  }
  return out;
}

/**
 * Re-read the credentials after the index refused `stale`.
 *
 * - If the credentials already changed since `stale` was used (another scrape refreshed
 *   them), the current ones are returned without fetching anything.
 * - If a refresh is running, its result is shared.
 * - If a refresh started within the cooldown, nothing is fetched and null is returned.
 * - Otherwise the seed pages are tried one at a time (the fetcher paces them) until one
 *   carries an app id and key. Those become the current credentials, even when they equal
 *   `stale` (the caller then knows a retry cannot help). Null when no page yields them.
 *
 * Never throws.
 */
export function refreshWttjCredentials(
  stale: WttjCredentials,
  fetchHtml: WttjHtmlFetcher,
  nowMs: number = Date.now(),
): Promise<WttjCredentials | null> {
  if (!sameWttjCredentials(stale, current)) return Promise.resolve(currentWttjCredentials());
  if (inFlight) return inFlight;
  if (lastRefreshStartedAt > 0 && nowMs - lastRefreshStartedAt < WTTJ_CREDENTIAL_REFRESH_COOLDOWN_MS) {
    return Promise.resolve(null);
  }
  lastRefreshStartedAt = nowMs;

  const run = async (): Promise<WttjCredentials | null> => {
    for (const url of wttjCredentialSeedUrls()) {
      let html: string | null = null;
      try {
        html = await fetchHtml(url);
      } catch (err: unknown) {
        logger.warn(
          `WelcomeToTheJungle credential page could not be read: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const found = extractWttjCredentials(html);
      if (!found) continue;
      const next: WttjCredentials = {
        appId: found.appId,
        apiKey: found.apiKey,
        indexPrefix: found.indexPrefix ?? current.indexPrefix,
        fetchedAt: Date.now(),
      };
      if (!sameWttjCredentials(next, current)) {
        logger.log(
          `WelcomeToTheJungle search credentials changed: app ${next.appId}, key ${maskWttjKey(next.apiKey)}, index prefix ${next.indexPrefix}`,
        );
      }
      current = next;
      return currentWttjCredentials();
    }
    logger.warn('WelcomeToTheJungle search credentials could not be rediscovered from any seed page');
    return null;
  };

  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Restore the built-in credentials and forget the refresh state and the remembered detail
 * URL. For tests, and for an operator who wants a clean slate.
 */
export function resetWttjCredentialCache(): void {
  current = builtInCredentials();
  inFlight = null;
  lastRefreshStartedAt = 0;
  lastDetailUrl = null;
}
