import {
  CallerOverridePolicy,
  CrawlPolicy,
  CrawlPolicyEnvConfig,
  CrawlPolicyOverride,
  CrawlPolicyResolveInput,
  ResolvedCrawlPolicy,
} from './types';

/**
 * Merge the policy layers (see `types.ts` header) for one request.
 * Spec 1690 — implemented by lane B1.
 */
export function resolveCrawlPolicy(
  input: CrawlPolicyResolveInput,
  env?: CrawlPolicyEnvConfig,
): ResolvedCrawlPolicy {
  throw new Error('not implemented (Spec 1690 lane B1)');
}

/**
 * Apply `EVER_JOBS_CRAWL_CALLER_OVERRIDES` to what a search caller asked for:
 * `any` accepts everything, `none` nothing, `stricter` only values at least as
 * polite as `base` (per-field comparators).
 */
export function filterCallerOverride(
  caller: CrawlPolicyOverride | undefined,
  base: CrawlPolicy,
  mode: CallerOverridePolicy,
): { accepted: CrawlPolicyOverride; rejected: string[] } {
  throw new Error('not implemented (Spec 1690 lane B1)');
}

/** Validate an untrusted object (env JSON, file, API body) into an override. */
export function normalizeCrawlOverride(raw: unknown): { value: CrawlPolicyOverride; warnings: string[] } {
  throw new Error('not implemented (Spec 1690 lane B1)');
}

/** `pattern` is an exact host or `*.suffix` (matches any subdomain, not the apex). */
export function matchHostPattern(pattern: string, host: string): boolean {
  throw new Error('not implemented (Spec 1690 lane B1)');
}
