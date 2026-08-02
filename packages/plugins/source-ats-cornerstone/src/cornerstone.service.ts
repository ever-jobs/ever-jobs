import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import {
  CORNERSTONE_HOST_TEMPLATE,
  CORNERSTONE_HOME_PATH,
  CORNERSTONE_SEARCH_PATH,
  CORNERSTONE_REQUISITION_PATH,
  CORNERSTONE_DEFAULT_SITE_ID,
  CORNERSTONE_DEFAULT_CULTURE_ID,
  CORNERSTONE_DEFAULT_CULTURE_NAME,
  CORNERSTONE_PAGE_SIZE,
  CORNERSTONE_MAX_CONCURRENCY,
  CORNERSTONE_REQUEST_DELAY_MS,
  CORNERSTONE_TOKEN_REGEX,
  CORNERSTONE_CLOUD_HOST_REGEX,
  CORNERSTONE_FALLBACK_CLOUD_HOST,
  CORNERSTONE_HEADERS,
} from './cornerstone.constants';
import {
  CornerstoneBootstrap,
  CornerstoneRequisition,
  CornerstoneLocation,
  CornerstoneSearchResponse,
} from './cornerstone.types';

/**
 * Cornerstone OnDemand (CSOD) Recruiting careers scraper — generic, multi-tenant.
 *
 * Resolves a tenant from `companySlug` (→ `https://{slug}.csod.com`) or an
 * explicit `companyUrl`, then performs a two-step public bootstrap:
 *   1. GET the public career-site page → scrape the anonymous JWT and the
 *      regional cloud API host the front-end uses.
 *   2. POST `{cloud}/rec-job-search/external/jobs` (bearer = that token) to page
 *      the requisitions. The first page yields the true `totalCount`; remaining
 *      pages are fanned out concurrently (bounded) and merged with
 *      `Promise.allSettled` so a single transient page failure never nukes the
 *      batch.
 *
 * No operator/OAuth credentials are required — the token is the same anonymous
 * one the candidate browser uses, and its `rurls` claim whitelists the search
 * endpoint.
 */
@SourcePlugin({
  site: Site.CORNERSTONE,
  name: 'Cornerstone',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class CornerstoneService implements IScraper {
  private readonly logger = new Logger(CornerstoneService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Cornerstone scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    const slug = this.resolveSlug(host, companySlug);
    const siteId = input.siteNumber || CORNERSTONE_DEFAULT_SITE_ID;
    const companyName = this.deriveCompanyName(companySlug, host);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(CORNERSTONE_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Cornerstone jobs for tenant: ${host} (siteId=${siteId})`);

      // Step 1 — bootstrap an anonymous token + regional cloud host from the page.
      const bootstrap = await this.bootstrap(client, host, slug, siteId);
      if (!bootstrap) {
        this.logger.warn(`Cornerstone bootstrap failed for ${host}; no public token available`);
        return new JobResponseDto([]);
      }

      // Step 2 — first search page → requisitions + true total count.
      const first = await this.fetchPage(client, bootstrap, siteId, 1);
      this.collect(first.requisitions, companyName, host, slug, siteId, input.descriptionFormat, seen, jobPosts);

      const total = Math.min(first.totalCount || jobPosts.length, resultsWanted);

      if (jobPosts.length < total && first.requisitions.length === CORNERSTONE_PAGE_SIZE) {
        const lastPage = Math.ceil(total / CORNERSTONE_PAGE_SIZE);
        const pages: number[] = [];
        for (let page = 2; page <= lastPage; page++) pages.push(page);

        // Bounded concurrent fan-out over the remaining pages.
        for (let i = 0; i < pages.length; i += CORNERSTONE_MAX_CONCURRENCY) {
          const chunk = pages.slice(i, i + CORNERSTONE_MAX_CONCURRENCY);
          const settled = await Promise.allSettled(
            chunk.map((page) => this.fetchPage(client, bootstrap, siteId, page)),
          );
          for (const result of settled) {
            if (result.status === 'fulfilled') {
              this.collect(
                result.value.requisitions,
                companyName,
                host,
                slug,
                siteId,
                input.descriptionFormat,
                seen,
                jobPosts,
              );
            } else {
              this.logger.warn(
                `Cornerstone page fetch failed: ${result.reason?.message ?? result.reason}`,
              );
            }
          }
          if (i + CORNERSTONE_MAX_CONCURRENCY < pages.length) {
            await randomSleep(CORNERSTONE_REQUEST_DELAY_MS, CORNERSTONE_REQUEST_DELAY_MS * 2);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Cornerstone total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Cornerstone scrape error for ${host}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /**
   * Step 1 of the public flow: GET the candidate-facing career-site page and
   * scrape the anonymous bearer token plus the regional cloud API host.
   */
  private async bootstrap(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    slug: string,
    siteId: string,
  ): Promise<CornerstoneBootstrap | null> {
    const path = CORNERSTONE_HOME_PATH.replace('{siteId}', encodeURIComponent(siteId)).replace(
      '{slug}',
      encodeURIComponent(slug),
    );
    const response = await client.get<string>(`${host}${path}`, { responseType: 'text' });
    const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');

    const tokenMatch = html.match(CORNERSTONE_TOKEN_REGEX);
    if (!tokenMatch || !tokenMatch[1]) return null;

    const hostMatch = html.match(CORNERSTONE_CLOUD_HOST_REGEX);
    const cloudHost = hostMatch?.[1] ?? CORNERSTONE_FALLBACK_CLOUD_HOST;

    return { token: tokenMatch[1], cloudHost };
  }

  /** Fetch one requisition search page; returns its requisitions and the total. */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    bootstrap: CornerstoneBootstrap,
    siteId: string,
    pageNumber: number,
  ): Promise<{ requisitions: CornerstoneRequisition[]; totalCount: number }> {
    const url = `${bootstrap.cloudHost}${CORNERSTONE_SEARCH_PATH}`;
    const payload = {
      careerSiteId: Number(siteId) || 1,
      careerSitePageId: 1,
      pageNumber,
      pageSize: CORNERSTONE_PAGE_SIZE,
      cultureId: CORNERSTONE_DEFAULT_CULTURE_ID,
      cultureName: CORNERSTONE_DEFAULT_CULTURE_NAME,
      searchText: '',
      states: [] as string[],
      countryCodes: [] as string[],
      cities: [] as string[],
      placeID: '',
      radius: null as number | null,
      postingsWithinDays: null as number | null,
      customFieldCheckboxKeys: [] as string[],
      customFieldDropdowns: [] as string[],
      customFieldRadios: [] as string[],
    };
    const response = await client.post<CornerstoneSearchResponse>(url, payload, {
      headers: {
        Authorization: `Bearer ${bootstrap.token}`,
        'Content-Type': 'application/json',
      },
    });
    const body: CornerstoneSearchResponse = response.data ?? {};
    const data = body.data ?? body;
    return {
      requisitions: data.requisitions ?? [],
      totalCount: data.totalCount ?? 0,
    };
  }

  /** Map raw requisitions → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    requisitions: CornerstoneRequisition[],
    companyName: string,
    host: string,
    slug: string,
    siteId: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const requisition of requisitions) {
      try {
        const post = this.processJob(requisition, companyName, host, slug, siteId, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(
          `Error processing Cornerstone requisition ${requisition?.requisitionId}: ${err.message}`,
        );
      }
    }
  }

  private processJob(
    requisition: CornerstoneRequisition,
    companyName: string,
    host: string,
    slug: string,
    siteId: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = requisition.displayJobTitle ?? requisition.jobTitle ?? requisition.title;
    if (!title) return null;

    const atsId = String(requisition.requisitionId ?? requisition.externalId ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(host, slug, siteId, atsId);

    const rawDescription = this.composeDescription(requisition);
    let description: string | null = null;
    if (rawDescription) {
      if (format === DescriptionFormat.HTML) {
        description = rawDescription;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawDescription) ?? rawDescription;
      } else {
        description = htmlToPlainText(rawDescription);
      }
    }

    const department =
      requisition.department ?? requisition.division ?? requisition.businessUnit ?? null;

    return new JobPostDto({
      id: `cornerstone-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(requisition),
      description,
      datePosted: this.parseDate(
        requisition.postingEffectiveDate ??
          requisition.postingStartDate ??
          requisition.postedDate,
      ),
      isRemote: this.detectRemote(requisition),
      emails: extractEmails(description),
      site: Site.CORNERSTONE,
      atsId,
      atsType: 'cornerstone',
      department,
      employmentType: requisition.employmentType ?? requisition.employmentStatus ?? null,
      applyUrl: jobUrl,
    });
  }

  /** Concatenate the external description and qualifications blocks, if present. */
  private composeDescription(requisition: CornerstoneRequisition): string | null {
    const parts = [
      requisition.externalDescription ?? requisition.description,
      requisition.externalQualifications ?? requisition.qualifications,
    ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  /** Resolve the tenant host from an explicit URL or the slug subdomain. */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        return `${u.protocol}//${u.host}`;
      } catch {
        // Fall through to slug-based host if the URL is malformed.
      }
    }
    return CORNERSTONE_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(companySlug ?? ''));
  }

  /** The `{client}` slug CSOD threads through URLs — derived from the host or slug. */
  private resolveSlug(host: string, companySlug: string | undefined): string {
    if (companySlug) return companySlug;
    try {
      return new URL(host).host.split('.')[0];
    } catch {
      return host;
    }
  }

  private deriveCompanyName(companySlug: string | undefined, host: string): string {
    let base = companySlug;
    if (!base) {
      try {
        base = new URL(host).host.split('.')[0];
      } catch {
        base = host;
      }
    }
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Build the canonical public job-detail URL. */
  private buildJobUrl(host: string, slug: string, siteId: string, atsId: string): string {
    const path = CORNERSTONE_REQUISITION_PATH.replace('{siteId}', encodeURIComponent(siteId))
      .replace('{reqId}', encodeURIComponent(atsId))
      .replace('{slug}', encodeURIComponent(slug));
    return `${host}${path}`;
  }

  /** CSOD returns locations as an array of objects, a single object, or a string. */
  private extractLocation(requisition: CornerstoneRequisition): LocationDto | null {
    const locs = requisition.locations;
    if (Array.isArray(locs) && locs.length > 0 && locs[0]) {
      return this.locationFromObject(locs[0]);
    }
    const single = requisition.location;
    if (single && typeof single === 'object') return this.locationFromObject(single);
    const display =
      (typeof single === 'string' ? single : null) ?? requisition.displayLocation;
    if (typeof display === 'string' && display.trim()) {
      const parts = display.split(',').map((p) => p.trim()).filter(Boolean);
      return new LocationDto({
        city: parts[0] ?? null,
        state: parts[1] ?? null,
        country: parts[2] ?? null,
      });
    }
    return null;
  }

  private locationFromObject(obj: CornerstoneLocation): LocationDto {
    if (typeof obj.displayName === 'string' && obj.displayName.trim() && !obj.city) {
      const parts = obj.displayName.split(',').map((p) => p.trim()).filter(Boolean);
      return new LocationDto({
        city: parts[0] ?? null,
        state: parts[1] ?? null,
        country: parts[2] ?? null,
      });
    }
    return new LocationDto({
      city: obj.city ?? null,
      state: obj.state ?? obj.stateName ?? null,
      country: obj.country ?? obj.countryName ?? obj.countryCode ?? null,
    });
  }

  /** Detect remote/hybrid from explicit flags or the workplace type string. */
  private detectRemote(requisition: CornerstoneRequisition): boolean {
    if (requisition.remoteFlag === true || requisition.isRemote === true) return true;
    const workplace = requisition.workplaceType;
    if (typeof workplace === 'string') {
      const v = workplace.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }

  /** Parse epoch-seconds, epoch-ms, or ISO strings into a YYYY-MM-DD string. */
  private parseDate(value: string | number | null | undefined): string | null {
    if (value == null) return null;
    try {
      if (typeof value === 'number') {
        const ms = value > 1e12 ? value : value > 1e10 ? value : value * 1000;
        return toDateOnly(ms);
      }
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
