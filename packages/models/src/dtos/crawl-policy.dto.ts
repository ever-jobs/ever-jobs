import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Allowed values of every enum-like crawl-policy field (Spec 1690).
 *
 * `@ever-jobs/models` cannot import from `@ever-jobs/common` (the dependency
 * points the other way: common → models), so the string-literal unions of
 * `CrawlPolicy` (`packages/common/src/http/crawl/types.ts`) are duplicated here.
 * A compile-time check in `apps/api/src/jobs/crawl-policy.mapping.ts` fails the
 * build if this DTO and `CrawlPolicy` drift apart in either direction.
 */
export const CRAWL_POLICY_DTO_VALUES = {
  userAgentMode: ['identify', 'strict', 'plugin'],
  proxyRotation: ['per-request', 'per-scrape', 'per-host', 'off'],
  rateLimitScope: ['host', 'domain', 'site'],
  retryBackoff: ['exponential', 'linear', 'constant'],
  retryAfterOverMax: ['give-up', 'cap'],
  robotsTxt: ['off', 'crawl-delay', 'respect'],
  discovery: ['auto', 'sitemap', 'listing'],
} as const;

export type CrawlDtoUserAgentMode = (typeof CRAWL_POLICY_DTO_VALUES.userAgentMode)[number];
export type CrawlDtoProxyRotation = (typeof CRAWL_POLICY_DTO_VALUES.proxyRotation)[number];
export type CrawlDtoRateLimitScope = (typeof CRAWL_POLICY_DTO_VALUES.rateLimitScope)[number];
export type CrawlDtoRetryBackoff = (typeof CRAWL_POLICY_DTO_VALUES.retryBackoff)[number];
export type CrawlDtoRetryAfterOverMax = (typeof CRAWL_POLICY_DTO_VALUES.retryAfterOverMax)[number];
export type CrawlDtoRobotsTxt = (typeof CRAWL_POLICY_DTO_VALUES.robotsTxt)[number];
export type CrawlDtoDiscovery = (typeof CRAWL_POLICY_DTO_VALUES.discovery)[number];

/** A header value must not be able to smuggle a second header line. */
const SINGLE_HEADER_LINE = /^[^\r\n\0]*$/;

/**
 * Per-request crawl policy (Spec 1690 §5.2) — `ScraperInputDto.crawl`.
 *
 * Every field is optional and mirrors one `CrawlPolicy` knob. What a caller sets
 * here is the highest-precedence layer ("caller") of the resolved policy, subject
 * to the operator's `EVER_JOBS_CRAWL_CALLER_OVERRIDES` (`any` | `stricter` |
 * `none`). Omitted fields fall through to the operator, plugin, env and preset
 * layers. The preset itself (`EVER_JOBS_CRAWL_PRESET`) is process-wide and cannot
 * be chosen per request.
 */
export class CrawlPolicyDto {
  // ── Identity ────────────────────────────────────────────────────────────

  @ApiPropertyOptional({
    description:
      'User-Agent to send. Keywords `default`/`everjobs` (the honest Ever Jobs UA) and `browser`/`legacy` (the pre-1690 Chrome/120 string) are expanded.',
    maxLength: 1024,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  @Matches(SINGLE_HEADER_LINE, { message: 'userAgent must be a single header line' })
  userAgent?: string;

  @ApiPropertyOptional({
    enum: [...CRAWL_POLICY_DTO_VALUES.userAgentMode],
    description:
      '`identify` (default): the configured UA, except for plugins that declare they need their own; `strict`: always the configured UA; `plugin`: whatever UA the plugin declares.',
  })
  @IsOptional()
  @IsIn(CRAWL_POLICY_DTO_VALUES.userAgentMode)
  userAgentMode?: CrawlDtoUserAgentMode;

  @ApiPropertyOptional({ description: 'Value of the `From:` request header (an operator contact address).', maxLength: 256 })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  @Matches(SINGLE_HEADER_LINE, { message: 'from must be a single header line' })
  from?: string;

  @ApiPropertyOptional({ description: 'Drop `sec-ch-ua*` client hints whenever the configured UA is sent.' })
  @IsOptional()
  @IsBoolean()
  stripClientHints?: boolean;

  // ── Proxies ─────────────────────────────────────────────────────────────

  @ApiPropertyOptional({
    enum: [...CRAWL_POLICY_DTO_VALUES.proxyRotation],
    description:
      '`per-host` (default): one stable proxy per rate-limit bucket; `per-scrape`: one proxy per scrape; `per-request`: round-robin on every request (pre-1690); `off`: never use a proxy.',
  })
  @IsOptional()
  @IsIn(CRAWL_POLICY_DTO_VALUES.proxyRotation)
  proxyRotation?: CrawlDtoProxyRotation;

  // ── Pacing ──────────────────────────────────────────────────────────────

  @ApiPropertyOptional({
    enum: [...CRAWL_POLICY_DTO_VALUES.rateLimitScope],
    description: 'Rate-limit bucket: exact `host` (default), registrable `domain`, or the plugin `site`.',
  })
  @IsOptional()
  @IsIn(CRAWL_POLICY_DTO_VALUES.rateLimitScope)
  rateLimitScope?: CrawlDtoRateLimitScope;

  @ApiPropertyOptional({ description: 'Max requests in flight per bucket. 0 = unlimited.', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxConcurrentPerHost?: number;

  @ApiPropertyOptional({ description: 'Minimum gap between request starts in a bucket, ms. 0 = none.', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  minIntervalMs?: number;

  @ApiPropertyOptional({ description: 'Random extra 0..jitterMs added to each gap, ms.', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  jitterMs?: number;

  @ApiPropertyOptional({ description: 'Longest a request may wait for its slot before failing fast, ms. 0 = no limit.', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxQueueWaitMs?: number;

  @ApiPropertyOptional({ description: 'Slow a bucket down on 429/503 and recover gradually on success.' })
  @IsOptional()
  @IsBoolean()
  adaptiveThrottle?: boolean;

  // ── Retries ─────────────────────────────────────────────────────────────

  @ApiPropertyOptional({ description: 'Retries per request on a retryable status (or network error when enabled).', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  retries?: number;

  @ApiPropertyOptional({
    description: 'HTTP statuses that are retried, e.g. [429, 502, 503, 504].',
    type: [Number],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(100, { each: true })
  @Max(599, { each: true })
  retryStatuses?: number[];

  @ApiPropertyOptional({ enum: [...CRAWL_POLICY_DTO_VALUES.retryBackoff], description: 'Backoff curve between retries.' })
  @IsOptional()
  @IsIn(CRAWL_POLICY_DTO_VALUES.retryBackoff)
  retryBackoff?: CrawlDtoRetryBackoff;

  @ApiPropertyOptional({ description: 'Base retry delay, ms.', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  retryBaseDelayMs?: number;

  @ApiPropertyOptional({ description: 'Cap on one computed retry delay, ms.', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  retryMaxDelayMs?: number;

  @ApiPropertyOptional({ description: 'Full jitter on the computed backoff.' })
  @IsOptional()
  @IsBoolean()
  retryJitter?: boolean;

  @ApiPropertyOptional({ description: 'Also retry connection resets / timeouts (no HTTP status).' })
  @IsOptional()
  @IsBoolean()
  retryOnNetworkError?: boolean;

  @ApiPropertyOptional({ description: 'Never retry earlier than a `Retry-After` header asks.' })
  @IsOptional()
  @IsBoolean()
  respectRetryAfter?: boolean;

  @ApiPropertyOptional({ description: 'A `Retry-After` longer than this triggers `retryAfterOverMax`, ms.', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxRetryAfterMs?: number;

  @ApiPropertyOptional({
    enum: [...CRAWL_POLICY_DTO_VALUES.retryAfterOverMax],
    description: '`give-up` (default): stop and cool the bucket for the full Retry-After; `cap`: wait maxRetryAfterMs then retry (pre-1690).',
  })
  @IsOptional()
  @IsIn(CRAWL_POLICY_DTO_VALUES.retryAfterOverMax)
  retryAfterOverMax?: CrawlDtoRetryAfterOverMax;

  @ApiPropertyOptional({
    description:
      'Back-off floor for a 429/503, ms: retry n waits at least this × 2^n (capped at max(retryMaxDelayMs, this)) when no usable `Retry-After` asks for longer, and any 429/503 cools the whole bucket at least that long. 0 = no floor.',
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  throttleRetryDelayMs?: number;

  // ── Other ───────────────────────────────────────────────────────────────

  @ApiPropertyOptional({
    enum: [...CRAWL_POLICY_DTO_VALUES.robotsTxt],
    description: '`off` (default), `crawl-delay` (use Crawl-delay as a pacing floor), or `respect` (also refuse disallowed URLs).',
  })
  @IsOptional()
  @IsIn(CRAWL_POLICY_DTO_VALUES.robotsTxt)
  robotsTxt?: CrawlDtoRobotsTxt;

  @ApiPropertyOptional({ description: 'Refuse loopback / private / link-local / cluster destinations.' })
  @IsOptional()
  @IsBoolean()
  blockPrivateNetworks?: boolean;

  @ApiPropertyOptional({
    enum: [...CRAWL_POLICY_DTO_VALUES.discovery],
    description: 'Discovery strategy for plugins that support more than one (e.g. Softy: `sitemap` or `listing`; `auto` picks).',
  })
  @IsOptional()
  @IsIn(CRAWL_POLICY_DTO_VALUES.discovery)
  discovery?: CrawlDtoDiscovery;
}
