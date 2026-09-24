import { CrawlPolicyOverride, ResolvedCrawlPolicy, ScrapeContext } from './types';

/**
 * Run `fn` with a per-scrape context. Nested inside the request context, so the
 * request id stays visible. Spec 1690 — implemented by lane B1.
 */
export function runWithScrapeContext<T>(ctx: ScrapeContext, fn: () => T): T {
  throw new Error('not implemented (Spec 1690 lane B1)');
}

/** The scrape context in scope, if any (undefined for CLI/test direct calls). */
export function getScrapeContext(): ScrapeContext | undefined {
  throw new Error('not implemented (Spec 1690 lane B1)');
}

/** Resolve the policy for `host` using the scrape context in scope. */
export function getEffectiveCrawlPolicy(host?: string, explicit?: CrawlPolicyOverride): ResolvedCrawlPolicy {
  throw new Error('not implemented (Spec 1690 lane B1)');
}
