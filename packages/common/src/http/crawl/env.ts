import { CrawlPolicyEnvConfig } from './types';

/**
 * Parse every `EVER_JOBS_CRAWL_*` variable (names in `CRAWL_ENV`) into a
 * `CrawlPolicyEnvConfig`. Invalid values never throw: they are skipped and
 * reported in `warnings`. When `env` is omitted, `process.env` is read once and
 * cached (see `resetCrawlPolicyEnvCache`).
 *
 * Spec 1690 — implemented by lane B1.
 */
export function readCrawlPolicyEnv(env?: NodeJS.ProcessEnv): CrawlPolicyEnvConfig {
  throw new Error('not implemented (Spec 1690 lane B1)');
}

/** Drop the cached `process.env` parse (tests, or after changing env at runtime). */
export function resetCrawlPolicyEnvCache(): void {
  throw new Error('not implemented (Spec 1690 lane B1)');
}

/**
 * Expand a configured UA: keywords (`default`, `everjobs`, `browser`, `legacy`) map
 * to `USER_AGENT_KEYWORDS`; a `contact` is inserted into the default UA's comment,
 * e.g. `Mozilla/5.0 (compatible; EverJobs/1.0; +https://...; ops@acme.example)`.
 */
export function expandUserAgent(value: string | undefined, contact?: string): string {
  throw new Error('not implemented (Spec 1690 lane B1)');
}
