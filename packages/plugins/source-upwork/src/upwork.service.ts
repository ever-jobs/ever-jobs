import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  DescriptionFormat,
  JobType,
  Site,
  UpworkAuthDto,
  UpworkGrantType,
} from '@ever-jobs/models';
import {
  markdownConverter,
  plainConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  JOB_SEARCH_QUERY,
  DEFAULT_NUM_RESULTS,
  DEFAULT_SORT_FIELD,
} from './upwork.constants';
import {
  UpworkTokenProvider,
  executeUpworkGraphql,
  UpworkApiError,
} from './upwork.client';

/**
 * Upwork job search service.
 *
 * Talks to Upwork's OAuth2 + GraphQL endpoints directly via
 * {@link UpworkTokenProvider} / {@link executeUpworkGraphql}. The official
 * `@upwork/node-upwork-oauth2` SDK is deliberately NOT used: its latest
 * release (2.3.0, 2024-11-27) still pins `request@2.88.2`, whose advisories
 * have no upstream fix. See `upwork.client.ts` for the full rationale.
 *
 * Supports two OAuth2 grant types:
 *   - `client_credentials`  — server-to-server (clientId + clientSecret only)
 *   - `authorization_code`  — user-delegated (clientId + clientSecret + accessToken + refreshToken)
 *
 * Credentials can be provided in two ways (per-request takes precedence):
 *   1. Per-request via `ScraperInputDto.auth.upwork`
 *   2. Environment variables:
 *        UPWORK_CLIENT_ID, UPWORK_CLIENT_SECRET,
 *        UPWORK_GRANT_TYPE (optional, auto-detected),
 *        UPWORK_ACCESS_TOKEN, UPWORK_REFRESH_TOKEN (authorization_code only)
 *
 * If no credentials are available the scraper logs a warning
 * and returns empty results (graceful degradation).
 */
@SourcePlugin({
  site: Site.UPWORK,
  name: 'Upwork',
  category: 'freelance',
})
@Injectable()
export class UpworkService implements IScraper {
  private readonly logger = new Logger(UpworkService.name);
  private defaultTokens?: UpworkTokenProvider;
  private defaultIsConfigured = false;
  private defaultGrantType: UpworkGrantType = UpworkGrantType.CLIENT_CREDENTIALS;

  constructor() {
    const envAuth = this.readEnvAuth();
    if (envAuth) {
      try {
        this.defaultGrantType = this.inferGrantType(envAuth);
        this.defaultTokens = new UpworkTokenProvider(
          envAuth,
          this.defaultGrantType,
        );
        this.defaultIsConfigured = true;
      } catch (err: any) {
        // Never let a credential problem crash DI startup — degrade to "no
        // Upwork" exactly as an unconfigured deployment does.
        this.logger.warn(`Upwork credentials rejected at startup: ${err.message}`);
      }
    } else {
      this.logger.warn(
        'Upwork credentials not configured via env vars. ' +
          'Set UPWORK_CLIENT_ID + UPWORK_CLIENT_SECRET (for client_credentials) ' +
          'or also set UPWORK_ACCESS_TOKEN + UPWORK_REFRESH_TOKEN (for authorization_code). ' +
          'Per-request auth via input.auth.upwork is still available. ' +
          'Get your API keys at https://developers.upwork.com',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const { tokens, grantType } = this.resolveTokens(input);

    if (!tokens) {
      this.logger.warn('Skipping Upwork scrape — no credentials available');
      return new JobResponseDto([]);
    }

    const numResults = input.resultsWanted ?? DEFAULT_NUM_RESULTS;
    const searchTerm = input.searchTerm ?? '';

    this.logger.log(
      `Upwork search (${grantType}): "${searchTerm}" (${numResults} results)`,
    );

    try {
      // The token provider handles both grants and caches the result, so a
      // fan-out of searches costs one token request rather than one per search.
      const variables = {
        searchTerm: searchTerm || '',
        first: numResults,
        sortField: DEFAULT_SORT_FIELD,
      };

      const data = await executeUpworkGraphql<{
        marketplaceJobPostings?: { edges?: { node: any }[] };
      }>(
        tokens,
        { query: JOB_SEARCH_QUERY, variables: JSON.stringify(variables) },
        this.logger,
      );

      // `executeUpworkGraphql` already unwraps the GraphQL envelope's `data`,
      // so this reads one level shallower than the SDK path did.
      const edges = data?.marketplaceJobPostings?.edges ?? [];
      this.logger.log(`Upwork returned ${edges.length} results`);

      const jobs: JobPostDto[] = [];

      for (const edge of edges) {
        try {
          const job = this.processNode(edge.node, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error processing Upwork result: ${err.message}`);
        }
      }

      return new JobResponseDto(jobs);
    } catch (err: any) {
      // Distinguish "Upwork said no" from an unexpected fault. A 401 here means
      // the credentials are wrong or revoked (the client already retried once
      // with a refreshed token), which is operator-actionable; anything else is
      // a bug or a transient network failure.
      if (err instanceof UpworkApiError) {
        this.logger.error(
          err.status === 401
            ? 'Upwork rejected the credentials (HTTP 401) even after refreshing — check UPWORK_CLIENT_ID/SECRET and any refresh token'
            : `Upwork API error: ${err.message}`,
        );
      } else {
        this.logger.error(`Upwork scrape error: ${err.message}`);
      }
      // Graceful degradation: a failing source must never fail the fan-out.
      return new JobResponseDto([]);
    }
  }

  // ── Auth helpers ──────────────────────────────────────────

  /**
   * Read Upwork auth credentials from environment variables.
   * Returns null if the minimum (clientId + clientSecret) are missing.
   */
  private readEnvAuth(): UpworkAuthDto | null {
    const clientId = process.env.UPWORK_CLIENT_ID;
    const clientSecret = process.env.UPWORK_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    const accessToken = process.env.UPWORK_ACCESS_TOKEN;
    const refreshToken = process.env.UPWORK_REFRESH_TOKEN;
    const envGrantType = process.env.UPWORK_GRANT_TYPE;

    let grantType: UpworkGrantType | undefined;
    if (envGrantType === 'client_credentials') {
      grantType = UpworkGrantType.CLIENT_CREDENTIALS;
    } else if (envGrantType === 'authorization_code') {
      grantType = UpworkGrantType.AUTHORIZATION_CODE;
    }

    return new UpworkAuthDto({
      grantType,
      clientId,
      clientSecret,
      accessToken: accessToken || undefined,
      refreshToken: refreshToken || undefined,
    });
  }

  /**
   * Resolve which token provider and grant type to use for this request.
   * Per-request auth (`input.auth.upwork`) takes precedence over env-var defaults.
   *
   * A per-request provider is built fresh each time (credentials differ per
   * caller); the env-var provider is a singleton so its token cache is shared.
   */
  private resolveTokens(input: ScraperInputDto): {
    tokens: UpworkTokenProvider | null;
    grantType: UpworkGrantType;
  } {
    const requestAuth = input.auth?.upwork;

    if (requestAuth?.clientId && requestAuth?.clientSecret) {
      const grantType = this.inferGrantType(requestAuth);
      return { tokens: new UpworkTokenProvider(requestAuth, grantType), grantType };
    }

    if (this.defaultIsConfigured && this.defaultTokens) {
      return { tokens: this.defaultTokens, grantType: this.defaultGrantType };
    }

    return { tokens: null, grantType: UpworkGrantType.CLIENT_CREDENTIALS };
  }

  /**
   * Infer the OAuth2 grant type from the auth DTO.
   *
   * Priority:
   *   1. Explicit `grantType` field
   *   2. If accessToken + refreshToken present → authorization_code
   *   3. Otherwise → client_credentials
   */
  private inferGrantType(auth: UpworkAuthDto): UpworkGrantType {
    if (auth.grantType) return auth.grantType;
    return (auth.accessToken && auth.refreshToken)
      ? UpworkGrantType.AUTHORIZATION_CODE
      : UpworkGrantType.CLIENT_CREDENTIALS;
  }

  // ── Result processing ─────────────────────────────────────

  /**
   * Convert an Upwork GraphQL job posting node into a JobPostDto.
   */
  private processNode(
    node: any,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    if (!node || !node.id) return null;

    const title = node.title ?? null;
    if (!title) return null;

    // Build the Upwork job URL from the ciphertext
    const jobUrl = node.ciphertext
      ? `https://www.upwork.com/jobs/${node.ciphertext}`
      : `https://www.upwork.com/jobs/${node.id}`;

    // Process description
    let description: string | null = node.description ?? null;
    if (description && format === DescriptionFormat.MARKDOWN) {
      if (/<[^>]+>/.test(description)) {
        description = markdownConverter(description) ?? description;
      }
    } else if (description && format === DescriptionFormat.PLAIN) {
      if (/<[^>]+>/.test(description)) {
        description = plainConverter(description) ?? description;
      }
    }

    // Parse compensation from budget fields
    let compensation = null;
    if (node.amount?.amount) {
      compensation = {
        minAmount: parseFloat(node.amount.amount),
        maxAmount: parseFloat(node.amount.amount),
        currency: node.amount.currencyCode ?? 'USD',
        interval: 'fixed' as any,
      };
    } else if (node.weeklyBudget?.amount) {
      compensation = {
        minAmount: parseFloat(node.weeklyBudget.amount),
        maxAmount: parseFloat(node.weeklyBudget.amount),
        currency: node.weeklyBudget.currencyCode ?? 'USD',
        interval: 'weekly' as any,
      };
    }

    // Parse date
    const datePosted = node.createdDateTime
      ? toDateOnly(node.createdDateTime)
      : null;

    // Detect remote from title or description
    const titleAndDesc = `${title} ${description ?? ''}`.toLowerCase();
    const isRemote =
      titleAndDesc.includes('remote') ||
      titleAndDesc.includes('work from home') ||
      titleAndDesc.includes('wfh');

    // Map engagement/duration to job type
    let jobType: JobType[] | null = null;
    if (node.engagement) {
      const eng = node.engagement.toLowerCase();
      if (eng.includes('full')) jobType = [JobType.FULL_TIME];
      else if (eng.includes('part')) jobType = [JobType.PART_TIME];
      else if (eng.includes('contract') || eng.includes('hourly'))
        jobType = [JobType.CONTRACT];
    }

    // Extract skills as a comma-separated string appended to description
    const skills = node.skills?.map((s: any) => s.name).filter(Boolean) ?? [];
    const category = node.category?.name ?? null;

    // Build a richer description with metadata
    let enrichedDescription = description ?? '';
    const meta: string[] = [];
    if (category) meta.push(`Category: ${category}`);
    if (node.subcategory?.name) meta.push(`Subcategory: ${node.subcategory.name}`);
    if (skills.length > 0) meta.push(`Skills: ${skills.join(', ')}`);
    if (node.contractorTier) meta.push(`Experience Level: ${this.humanizeTier(node.contractorTier)}`);
    if (node.duration) meta.push(`Duration: ${node.duration}`);
    if (node.client) {
      const clientMeta: string[] = [];
      if (node.client.totalPostedJobs != null) clientMeta.push(`${node.client.totalPostedJobs} jobs posted`);
      if (node.client.totalHires != null) clientMeta.push(`${node.client.totalHires} hires`);
      if (clientMeta.length > 0) meta.push(`Client: ${clientMeta.join(', ')}`);
    }

    if (meta.length > 0) {
      enrichedDescription = enrichedDescription
        ? `${enrichedDescription}\n\n---\n${meta.join('\n')}`
        : meta.join('\n');
    }

    return new JobPostDto({
      id: `upwork-${node.id}`,
      title,
      companyName: 'Upwork Client', // Upwork doesn't expose client company names in search
      companyUrl: null,
      jobUrl,
      location: new LocationDto({}),
      description: enrichedDescription || null,
      compensation,
      datePosted,
      jobType,
      isRemote,
      emails: extractEmails(enrichedDescription),
      site: Site.UPWORK,
    });
  }

  /**
   * Humanize the contractor tier enum value.
   */
  private humanizeTier(tier: string): string {
    switch (tier) {
      case 'ENTRY':
        return 'Entry Level';
      case 'INTERMEDIATE':
        return 'Intermediate';
      case 'EXPERT':
        return 'Expert';
      default:
        return tier;
    }
  }
}
