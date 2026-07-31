import { Resolver, Query, Args } from '@nestjs/graphql';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobPostDto, Site } from '@ever-jobs/models';
import { JobsService } from './jobs.service';
import { JobsAggregator } from './jobs.aggregator';
import { CacheService } from '../cache/cache.service';
import {
  SearchJobsInput,
  SearchJobsResult,
  SourceListResult,
} from './gql-types';

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
    this.logger.log(
      `GraphQL searchJobs: term="${input.searchTerm}", location="${input.location ?? ''}"`,
    );

    // Cache stores RAW fan-out — dedup runs per-request.
    // The endpoint key is bumped to v2 so any v1 entries (which were
    // written before T15 wired dedup into the resolver) are invalidated.
    const dedup = input.dedup ?? true;
    const cacheParams = { ...input, endpoint: 'graphql-search-v2', dedup: undefined };
    const cached = await this.cacheService.get<JobPostDto[]>(cacheParams);

    let rawJobs: JobPostDto[];
    let fromCache = false;
    if (cached) {
      rawJobs = cached;
      fromCache = true;
      this.logger.log(`Cache hit — ${rawJobs.length} raw cached results`);
    } else {
      // Map GraphQL input to the service DTO shape.
      const scraperInput: any = {
        searchTerm: input.searchTerm,
        location: input.location,
        resultsWanted: input.resultsWanted ?? 20,
        country: input.country,
        distance: input.distance,
        companySlug: input.companySlug,
        descriptionFormat: input.descriptionFormat ?? 'markdown',
        siteType: input.siteType,
      };
      rawJobs = await this.jobsService.searchJobs(scraperInput);
      await this.cacheService.set(cacheParams, rawJobs);
    }

    // Spec 5024 — same opt-out as the REST path (`EVER_JOBS_PERSIST_SEARCH`).
    const persist = this.configService.get<boolean>('store.persistSearch', true);
    const aggregated = await this.aggregator.aggregateRaw(rawJobs, { dedup, persist });

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
