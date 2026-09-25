import { ObjectType, Field, InputType, Int, Float, ID, registerEnumType } from '@nestjs/graphql';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import {
  CRAWL_POLICY_DTO_VALUES,
  CrawlPolicyDto,
  Site,
  type CrawlDtoDiscovery,
  type CrawlDtoProxyRotation,
  type CrawlDtoRateLimitScope,
  type CrawlDtoRetryAfterOverMax,
  type CrawlDtoRetryBackoff,
  type CrawlDtoRobotsTxt,
  type CrawlDtoUserAgentMode,
} from '@ever-jobs/models';

// ── Register the Site enum for GraphQL ───────────────────
registerEnumType(Site, {
  name: 'Site',
  description: 'Supported job board / ATS / company source',
});

// ── Input Types ──────────────────────────────────────────

/** `a | b | c` for a field description. */
const oneOf = (values: readonly string[]): string => values.join(' | ');

/**
 * Per-request crawl policy (Spec 1690 §5.2) — the GraphQL face of
 * `CrawlPolicyDto`. It extends the DTO, so it inherits the DTO's
 * class-validator rules (enums, `Min(0)`, header-safe strings); this class only
 * adds the GraphQL `@Field`s. Enum-like fields are `String`s because several
 * values (`per-request`, `give-up`, `crawl-delay`) are not valid GraphQL enum
 * names. Every field is nullable; `null` means "not set".
 */
@InputType('CrawlPolicyInput', {
  description:
    'Per-request crawl policy (Spec 1690): identity, pacing, proxy rotation, retries, robots.txt and discovery. Every field optional; subject to EVER_JOBS_CRAWL_CALLER_OVERRIDES.',
})
export class CrawlPolicyGqlInput extends CrawlPolicyDto {
  @Field(() => String, { nullable: true, description: 'User-Agent to send (keywords default | browser are expanded).' })
  userAgent?: string;

  @Field(() => String, { nullable: true, description: oneOf(CRAWL_POLICY_DTO_VALUES.userAgentMode) })
  userAgentMode?: CrawlDtoUserAgentMode;

  @Field(() => String, { nullable: true, description: 'Value of the From: request header.' })
  from?: string;

  @Field(() => Boolean, { nullable: true })
  stripClientHints?: boolean;

  @Field(() => String, { nullable: true, description: oneOf(CRAWL_POLICY_DTO_VALUES.proxyRotation) })
  proxyRotation?: CrawlDtoProxyRotation;

  @Field(() => String, { nullable: true, description: oneOf(CRAWL_POLICY_DTO_VALUES.rateLimitScope) })
  rateLimitScope?: CrawlDtoRateLimitScope;

  @Field(() => Int, { nullable: true, description: 'Max requests in flight per bucket. 0 = unlimited.' })
  maxConcurrentPerHost?: number;

  @Field(() => Int, { nullable: true, description: 'Minimum gap between request starts in a bucket, ms.' })
  minIntervalMs?: number;

  @Field(() => Int, { nullable: true, description: 'Random extra 0..jitterMs per gap, ms.' })
  jitterMs?: number;

  @Field(() => Int, { nullable: true, description: 'Longest wait for a slot, ms. 0 = no limit.' })
  maxQueueWaitMs?: number;

  @Field(() => Boolean, { nullable: true })
  adaptiveThrottle?: boolean;

  @Field(() => Int, { nullable: true })
  retries?: number;

  @Field(() => [Int], { nullable: true, description: 'HTTP statuses that are retried.' })
  retryStatuses?: number[];

  @Field(() => String, { nullable: true, description: oneOf(CRAWL_POLICY_DTO_VALUES.retryBackoff) })
  retryBackoff?: CrawlDtoRetryBackoff;

  @Field(() => Int, { nullable: true })
  retryBaseDelayMs?: number;

  @Field(() => Int, { nullable: true })
  retryMaxDelayMs?: number;

  @Field(() => Boolean, { nullable: true })
  retryJitter?: boolean;

  @Field(() => Boolean, { nullable: true })
  retryOnNetworkError?: boolean;

  @Field(() => Boolean, { nullable: true })
  respectRetryAfter?: boolean;

  @Field(() => Int, { nullable: true })
  maxRetryAfterMs?: number;

  @Field(() => String, { nullable: true, description: oneOf(CRAWL_POLICY_DTO_VALUES.retryAfterOverMax) })
  retryAfterOverMax?: CrawlDtoRetryAfterOverMax;

  @Field(() => String, { nullable: true, description: oneOf(CRAWL_POLICY_DTO_VALUES.robotsTxt) })
  robotsTxt?: CrawlDtoRobotsTxt;

  @Field(() => Boolean, { nullable: true })
  blockPrivateNetworks?: boolean;

  @Field(() => String, { nullable: true, description: oneOf(CRAWL_POLICY_DTO_VALUES.discovery) })
  discovery?: CrawlDtoDiscovery;
}

/**
 * The class-validator decorators below are what keeps these fields alive under
 * the global `ValidationPipe({ whitelist: true })`, which also runs on GraphQL
 * args: whitelisting strips every property without validation metadata, so an
 * undecorated input class arrives empty.
 */
@InputType()
export class SearchJobsInput {
  @Field(() => [Site], { nullable: true, description: 'Sources to search (omit for all)' })
  @IsOptional()
  @IsArray()
  @IsEnum(Site, { each: true })
  siteType?: Site[];

  @Field({ description: 'Search term / keywords' })
  @IsString()
  searchTerm!: string;

  @Field({ nullable: true, description: 'Location filter (city, state, country)' })
  @IsOptional()
  @IsString()
  location?: string;

  @Field(() => Int, { nullable: true, defaultValue: 20, description: 'Number of results wanted per source' })
  @IsOptional()
  @IsInt()
  resultsWanted?: number;

  @Field({ nullable: true, description: 'Country code (e.g. USA, UK, DE)' })
  @IsOptional()
  @IsString()
  country?: string;

  @Field(() => Int, { nullable: true, description: 'Search radius in miles' })
  @IsOptional()
  @IsInt()
  distance?: number;

  @Field({ nullable: true, description: 'Company slug for ATS sources' })
  @IsOptional()
  @IsString()
  companySlug?: string;

  @Field({ nullable: true, defaultValue: 'markdown', description: 'Description format: markdown, html, or text' })
  @IsOptional()
  @IsString()
  descriptionFormat?: string;

  @Field({
    nullable: true,
    defaultValue: true,
    description:
      'Cross-source deduplication. Default true — collapses identical or near-duplicate jobs surfaced by multiple sources into one record. Pass false to keep every observation as a separate result (Spec 003 / FR-1).',
  })
  @IsOptional()
  @IsBoolean()
  dedup?: boolean;

  @Field(() => CrawlPolicyGqlInput, {
    nullable: true,
    description:
      'Per-request crawl policy (Spec 1690). Same fields and rules as the REST `crawl` object; the process-wide preset (EVER_JOBS_CRAWL_PRESET) cannot be chosen here.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlPolicyGqlInput)
  crawl?: CrawlPolicyGqlInput;
}

// ── Output Types ─────────────────────────────────────────

@ObjectType()
export class LocationGql {
  @Field({ nullable: true })
  country?: string;

  @Field({ nullable: true })
  city?: string;

  @Field({ nullable: true })
  state?: string;
}

@ObjectType()
export class CompensationGql {
  @Field(() => Float, { nullable: true })
  minAmount?: number;

  @Field(() => Float, { nullable: true })
  maxAmount?: number;

  @Field({ nullable: true })
  currency?: string;

  @Field({ nullable: true })
  interval?: string;
}

@ObjectType()
export class JobPostGql {
  @Field(() => ID, { nullable: true })
  id?: string;

  @Field({ nullable: true })
  site?: string;

  @Field({ nullable: true })
  title?: string;

  @Field({ nullable: true })
  companyName?: string;

  @Field({ nullable: true })
  jobUrl?: string;

  @Field(() => LocationGql, { nullable: true })
  location?: LocationGql;

  @Field({ nullable: true })
  description?: string;

  @Field(() => [String], { nullable: true })
  jobType?: string[];

  @Field(() => CompensationGql, { nullable: true })
  compensation?: CompensationGql;

  @Field({ nullable: true })
  datePosted?: string;

  @Field(() => [String], { nullable: true })
  emails?: string[];

  @Field({ nullable: true })
  isRemote?: boolean;

  @Field({ nullable: true })
  companyUrl?: string;

  @Field({ nullable: true })
  logoUrl?: string;
}

@ObjectType({
  description:
    'Per-call dedup metrics — populated only when the dedup engine actually ran (Spec 003 / FR-3).',
})
export class DedupMetricsGql {
  @Field(() => Int, { description: 'Number of raw jobs fed into the engine.' })
  inputCount!: number;

  @Field(() => Int, { description: 'Number of canonical clusters emitted.' })
  outputCount!: number;

  @Field(() => Int, {
    description: 'Number of raw-pair merges performed across all stages.',
  })
  mergedPairs!: number;

  @Field(() => Float, {
    description: 'Wall-clock cost of the dedup pass, in milliseconds.',
  })
  elapsedMs!: number;
}

@ObjectType()
export class SearchJobsResult {
  @Field(() => Int, { description: 'Number of jobs in the response (post-dedup when applicable).' })
  count!: number;

  @Field(() => [JobPostGql])
  jobs!: JobPostGql[];

  @Field()
  cached!: boolean;

  @Field({
    description:
      'True iff the dedup engine actually ran. False when no engine is bound or the caller passed dedup: false.',
  })
  deduped!: boolean;

  @Field(() => Int, {
    description: 'Pre-dedup count. Equals raw fan-out length.',
  })
  rawCount!: number;

  @Field(() => DedupMetricsGql, {
    nullable: true,
    description: 'Populated only when deduped=true.',
  })
  dedupMetrics?: DedupMetricsGql;
}

@ObjectType()
export class SiteSourceGql {
  @Field()
  name!: string;

  @Field()
  value!: string;
}

@ObjectType()
export class SourceListResult {
  @Field(() => Int)
  total!: number;

  @Field(() => [SiteSourceGql])
  sources!: SiteSourceGql[];
}
