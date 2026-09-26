/**
 * Errors raised by the crawl-policy layer (Spec 1690). Each carries a stable
 * `code` so `classifyScrapeError` can turn it into a per-source diagnostic
 * instead of an opaque failure.
 */

export abstract class CrawlPolicyError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A request waited longer than `maxQueueWaitMs` for its rate-limit slot. */
export class CrawlQueueTimeoutError extends CrawlPolicyError {
  readonly code = 'ERR_CRAWL_QUEUE_TIMEOUT';

  constructor(readonly bucket: string, readonly waitedMs: number) {
    super(`Rate-limit slot for ${bucket} not granted within ${waitedMs}ms`);
  }
}

/**
 * The server asked us to back off for longer than we are willing to wait
 * (`Retry-After` over `maxRetryAfterMs` with `retryAfterOverMax: 'give-up'`), or the
 * bucket is still cooling down from that request.
 */
export class HostCoolingDownError extends CrawlPolicyError {
  readonly code = 'ERR_CRAWL_HOST_COOLING_DOWN';

  constructor(readonly bucket: string, readonly retryAfterMs: number, readonly status?: number) {
    super(
      `${bucket} asked us to back off for ${Math.round(retryAfterMs / 1000)}s` +
        (status ? ` (HTTP ${status})` : '') +
        '; not retrying early',
    );
  }
}

/** robots.txt disallows the URL for our User-Agent (`robotsTxt: 'respect'`). */
export class RobotsDisallowedError extends CrawlPolicyError {
  readonly code = 'ERR_CRAWL_ROBOTS_DISALLOWED';

  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`);
  }
}

/** The destination resolves to a loopback / private / link-local address. */
export class EgressBlockedError extends CrawlPolicyError {
  readonly code = 'ERR_CRAWL_EGRESS_BLOCKED';

  constructor(readonly target: string, readonly reason: string) {
    super(`Refusing to connect to ${target}: ${reason}`);
  }
}

export function isCrawlPolicyError(err: unknown): err is CrawlPolicyError {
  return err instanceof CrawlPolicyError;
}
