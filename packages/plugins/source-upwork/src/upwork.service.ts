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

// The Upwork SDK (`@upwork/node-upwork-oauth2`) pulls in the deprecated `request`
// stack (request/tough-cookie/uuid) with unpatchable advisories. This fork does
// not use Upwork, so the dependency is removed from package.json and the SDK is
// loaded lazily — only if a caller actually configures Upwork credentials.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadUpworkSdk(): { UpworkApi: any; Graphql: any } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const UpworkApi = require('@upwork/node-upwork-oauth2');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Graphql } = require('@upwork/node-upwork-oauth2/lib/routers/graphql');
    return { UpworkApi, Graphql };
  } catch {
    throw new Error(
      'Upwork source is disabled in this fork: the @upwork/node-upwork-oauth2 ' +
        'dependency was removed for security (deprecated request/tough-cookie/uuid). ' +
        'Reinstall it to re-enable Upwork.',
    );
  }
}

/**
 * Upwork job search service using the official Upwork Node.js SDK.
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
  private defaultApi: any;
  private defaultIsConfigured = false;
  private defaultGrantType: UpworkGrantType = UpworkGrantType.CLIENT_CREDENTIALS;

  constructor() {
    const envAuth = this.readEnvAuth();
    if (envAuth) {
      try {
        this.defaultApi = this.createApiClient(envAuth);
        this.defaultGrantType = this.inferGrantType(envAuth);
        this.defaultIsConfigured = true;
      } catch (err: any) {
        // SDK not installed in this fork — degrade instead of crashing DI startup.
        this.logger.warn(err.message);
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
    const { api, grantType } = this.resolveApi(input);

    if (!api) {
      this.logger.warn('Skipping Upwork scrape — no credentials available');
      return new JobResponseDto([]);
    }

    const numResults = input.resultsWanted ?? DEFAULT_NUM_RESULTS;
    const searchTerm = input.searchTerm ?? '';

    this.logger.log(
      `Upwork search (${grantType}): "${searchTerm}" (${numResults} results)`,
    );

    try {
      // Authenticate based on grant type
      if (grantType === UpworkGrantType.CLIENT_CREDENTIALS) {
        await this.obtainClientCredentialsToken(api);
      } else {
        await this.setAccessToken(api);
      }

      const { Graphql } = loadUpworkSdk();
      const graphql = new Graphql(api);

      const variables = {
        searchTerm: searchTerm || '',
        first: numResults,
        sortField: DEFAULT_SORT_FIELD,
      };

      const data = await this.executeGraphql(graphql, {
        query: JOB_SEARCH_QUERY,
        variables: JSON.stringify(variables),
      });

      const edges =
        data?.data?.marketplaceJobPostings?.edges ?? [];
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
      this.logger.error(`Upwork scrape error: ${err.message}`);
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
   * Resolve which API client and grant type to use for this request.
   * Per-request auth (`input.auth.upwork`) takes precedence over env-var defaults.
   */
  private resolveApi(input: ScraperInputDto): { api: any; grantType: UpworkGrantType } {
    const requestAuth = input.auth?.upwork;

    if (requestAuth?.clientId && requestAuth?.clientSecret) {
      const grantType = this.inferGrantType(requestAuth);
      const api = this.createApiClient(requestAuth);
      return { api, grantType };
    }

    if (this.defaultIsConfigured && this.defaultApi) {
      return { api: this.defaultApi, grantType: this.defaultGrantType };
    }

    return { api: null, grantType: UpworkGrantType.CLIENT_CREDENTIALS };
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

  /**
   * Create a new UpworkApi SDK instance from auth credentials.
   */
  private createApiClient(auth: UpworkAuthDto): any {
    const grantType = this.inferGrantType(auth);
    const config: any = {
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
    };

    if (grantType === UpworkGrantType.CLIENT_CREDENTIALS) {
      config.grantType = 'client_credentials';
    } else {
      config.accessToken = auth.accessToken;
      config.refreshToken = auth.refreshToken;
    }

    const { UpworkApi } = loadUpworkSdk();
    return new UpworkApi(config);
  }

  /**
   * Obtain an access token via the client_credentials grant.
   */
  private obtainClientCredentialsToken(api: any): Promise<any> {
    return new Promise((resolve, reject) => {
      api.getToken(null, (error: any, tokenPair: any) => {
        if (error) {
          reject(new Error(`Upwork client_credentials token failed: ${error}`));
        } else {
          resolve(tokenPair);
        }
      });
    });
  }

  /**
   * Set up access token on the API instance (authorization_code flow).
   * The SDK automatically refreshes expired tokens.
   */
  private setAccessToken(api: any): Promise<any> {
    return new Promise((resolve, reject) => {
      api.setAccessToken((error: any, tokenPair: any) => {
        if (error) {
          reject(new Error(`Upwork token setup failed: ${error}`));
        } else {
          resolve(tokenPair);
        }
      });
    });
  }

  // ── GraphQL ───────────────────────────────────────────────

  /**
   * Execute a GraphQL request via the Upwork SDK.
   */
  private executeGraphql(graphql: any, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      graphql.execute(params, (error: any, httpStatus: number, data: any) => {
        if (error) {
          reject(new Error(`Upwork GraphQL error: ${error}`));
        } else if (httpStatus >= 400) {
          reject(
            new Error(
              `Upwork API returned HTTP ${httpStatus}: ${JSON.stringify(data)}`,
            ),
          );
        } else {
          resolve(data);
        }
      });
    });
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
