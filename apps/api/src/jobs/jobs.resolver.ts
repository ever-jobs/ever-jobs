import { Resolver, Query, Args } from '@nestjs/graphql';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CrawlPolicyDto, JobPostDto, Site } from '@ever-jobs/models';
import { exclusionSpecFromInput, hasExclusionInput } from '@ever-jobs/common';
import { JobsService, readMaxSearchLocations } from './jobs.service';
import { JobsAggregator } from './jobs.aggregator';
import { CacheService } from '../cache/cache.service';
import { describeTerm, normalizeSearchInput } from './search-input';
import { DEFAULT_CACHE_MAX_JOBS, isCacheableJobCount } from '../config/search-config';
import { searchCacheParams } from './search-cache-params';
import {
  CrawlPolicyGqlInput,
  SearchJobsInput,
  SearchJobsResult,
  SourceListResult,
  resolveSearchCountry,
} from './gql-types';

/**
 * Map the GraphQL `crawl` input onto the service DTO (Spec 1690 §5.2): copy
 * the fields the caller set, drop `null`/`undefined` (GraphQL "not set"), and
 * return `undefined` when nothing is left so an empty object never reaches the
 * policy layer. Values are validated again by the policy layer, like every
 * other entry point's.
 */
export function toCrawlPolicyDto(
  crawl: CrawlPolicyGqlInput | null | undefined,
): CrawlPolicyDto | undefined {
  if (!crawl || typeof crawl !== 'object') return undefined;
  const dto = new CrawlPolicyDto();
  const fields = dto as unknown as Record<string, unknown>;
  let set = 0;
  for (const [key, value] of Object.entries(crawl)) {
    if (value === null || value === undefined) continue;
    fields[key] = Array.isArray(value) ? [...value] : value;
    set++;
  }
  return set > 0 ? dto : undefined;
}

/**
 * GraphQL resolver exposing the same job search functionality as the REST API.
 *
 * Endpoint: POST /graphql
 *
 * Mirrors `JobsController.searchJobs` (Spec 003 / Phase 6 / T15): the cache
 * stores the **raw** fan-out so the dedup engine version is decoupled from
 * cache invalidation, and the dedup pass runs per-request even on cache
 * hits. Dedup defaults to `true` and can be opted out with
 * `input: { dedup: false }`.
 *
 * Example query:
 *   query {
 *     searchJobs(input: { searchTerm: "engineer", location: "New York" }) {
 *       count
 *       rawCount
 *       deduped
 *       jobs { title companyName jobUrl location { city state } }
 *     }
 *   }
 */
@Resolver()
export class JobsResolver {
  private readonly logger = new Logger(JobsResolver.name);

  constructor(
    private readonly jobsService: JobsService,
    private readonly aggregator: JobsAggregator,
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
  ) {}

  @Query(() => SearchJobsResult, {
    name: 'searchJobs',
    description: 'Search for jobs across multiple sources',
  })
  async searchJobs(
    @Args('input') input: SearchJobsInput,
  ): Promise<SearchJobsResult> {
    // Spec 1720 — list mode: null / "" / whitespace mean "no keyword".
    // Normalised before the cache key so they share one entry.
    normalizeSearchInput(input);
    this.logger.log(
      `GraphQL searchJobs: term=${describeTerm(input)}, location="${input.location ?? ''}"` +
        (input.locations ? `, locations=${JSON.stringify(input.locations)}` : ''),
    );

    // Cache stores RAW fan-out — dedup runs per-request.
    // The endpoint key is bumped to v2 so any v1 entries (which were
    // written before T15 wired dedup into the resolver) are invalidated.
    // Spec 1700: exclusion fields stay out of the key and `locations` keys
    // case-insensitively in the caller's order, exactly as on the REST path.
    const dedup = input.dedup ?? true;
    const cacheParams = searchCacheParams(
      input,
      { endpoint: 'graphql-search-v2', dedup: undefined },
      readMaxSearchLocations(this.configService),
    );
    const cached = await this.cacheService.get<JobPostDto[]>(cacheParams);

    let rawJobs: JobPostDto[];
    let fromCache = false;
    if (cached) {
      rawJobs = cached;
      fromCache = true;
      this.logger.log(`Cache hit — ${rawJobs.length} raw cached results`);
    } else {
      // Spec 1689 — the free-form GraphQL country becomes a `Country`
      // (what the REST DTO validates); an unrecognised one is dropped, as
      // the whitelist pipe used to drop every GraphQL field.
      const country = resolveSearchCountry(input.country);
      if (input.country && !country) {
        this.logger.warn(
          `GraphQL searchJobs: ignoring unrecognised country ${JSON.stringify(input.country.slice(0, 64))}`,
        );
      }
      // Map GraphQL input to the service DTO shape.
      const scraperInput: any = {
        searchTerm: input.searchTerm,
        location: input.location,
        resultsWanted: input.resultsWanted ?? 20,
        country,
        distance: input.distance,
        companySlug: input.companySlug,
        descriptionFormat: input.descriptionFormat ?? 'markdown',
        siteType: input.siteType,
        siteCategories: input.siteCategories,
      };
      // Spec 1700 — only when supplied, so the service sees the legacy input otherwise.
      if (input.locations != null) scraperInput.locations = input.locations;
      // Spec 1690 §5.2 — per-request crawl policy. Only set fields are
      // forwarded (GraphQL `null` = not set), and only when there is one.
      const crawl = toCrawlPolicyDto(input.crawl);
      if (crawl) {
        scraperInput.crawl = crawl;
      }
      const result = await this.jobsService.searchJobsWithDiagnostics(scraperInput);
      rawJobs = result.jobs;
      // Spec 1721 / FR-20 — like the REST path, an incomplete crawl (the
      // deadline or the job ceiling left sources unscraped) is served but never
      // cached: a retry within the TTL must get a fresh chance at those sources.
      // Spec 1720 / FR-13 — and the same size bound.
      if (result.completeness?.complete === false) {
        this.logger.log(`Not caching an incomplete crawl (${result.completeness.stopReason})`);
      } else if (
        isCacheableJobCount(
          rawJobs.length,
          this.configService.get<number>('cache.maxJobs', DEFAULT_CACHE_MAX_JOBS),
        )
      ) {
        await this.cacheService.set(cacheParams, rawJobs);
      }
    }

    // Spec 5024 — same opt-out as the REST path (`EVER_JOBS_PERSIST_SEARCH`).
    const persist = this.configService.get<boolean>('store.persistSearch', true);
    // Spec 1700 — exclusions are passed only when supplied.
    const aggregated = await this.aggregator.aggregateRaw(
      rawJobs,
      hasExclusionInput(input)
        ? { dedup, persist, exclusions: exclusionSpecFromInput(input) }
        : { dedup, persist },
    );

    this.logger.log(
      `GraphQL searchJobs: returning ${aggregated.jobs.length} jobs (raw=${aggregated.rawCount}, deduped=${aggregated.deduped}, cached=${fromCache})`,
    );

    return {
      count: aggregated.jobs.length,
      jobs: aggregated.jobs as any[],
      cached: fromCache,
      deduped: aggregated.deduped,
      rawCount: aggregated.rawCount,
      dedupMetrics: aggregated.dedupMetrics,
      ...(aggregated.exclusionMetrics ? { exclusionMetrics: aggregated.exclusionMetrics } : {}),
    };
  }

  @Query(() => SourceListResult, {
    name: 'listSources',
    description: 'List all available job sources',
  })
  listSources(): SourceListResult {
    const sources = Object.entries(Site).map(([name, value]) => ({
      name,
      value,
    }));
    return { total: sources.length, sources };
  }
}
