import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
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
  toDateOnly,
} from '@ever-jobs/common';
import {
  SOFTGARDEN_HOST_TEMPLATE,
  SOFTGARDEN_CAREER_APEX,
  SOFTGARDEN_FEED_PATH,
  SOFTGARDEN_JOB_PAGE_TEMPLATE,
  SOFTGARDEN_DEFAULT_RESULTS,
  SOFTGARDEN_HEADERS,
} from './softgarden.constants';
import {
  SoftgardenFeedResponse,
  SoftgardenFeedElement,
  SoftgardenJobPosting,
  SoftgardenPlace,
} from './softgarden.types';

/**
 * Softgarden career-page scraper — generic, multi-tenant.
 *
 * Softgarden is a German cloud ATS / e-recruiting platform. Every customer
 * tenant operates its own public, branded career page. The modern (React)
 * career page is served from a per-tenant host (e.g.
 * `https://{slug}.career.softgarden.de/`, or a custom domain) and exposes a
 * fully anonymous, no-auth schema.org **JobPosting DataFeed** at
 * `GET {tenantOrigin}/jobs.feed.json`.
 *
 * The feed is the same machine-readable document the career page publishes for
 * search engines / aggregators, so it needs no API key, channel id, or client
 * token (unlike the documented authenticated jobboard REST APIs, which are not
 * used). Each `dataFeedElement[].item` is a schema.org `JobPosting` with the
 * full HTML description embedded inline — so a single fetch per tenant yields
 * complete records and NO per-job detail fan-out is required.
 *
 * Tenant resolution: `companySlug` maps to `{slug}.career.softgarden.de`; a
 * `companyUrl` is used by its origin verbatim (custom domains, `*.softgarden.io`,
 * `*.softgarden.de`). A single fetch error, an unknown tenant (HTTP 404), or a
 * malformed payload degrades to an empty/partial result rather than throwing,
 * so a single tenant never aborts a batch run.
 */
@SourcePlugin({
  site: Site.SOFTGARDEN,
  name: 'Softgarden',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SoftgardenService implements IScraper {
  private readonly logger = new Logger(SoftgardenService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Softgarden scraper');
      return new JobResponseDto([]);
    }

    const origin = this.resolveOrigin(input.companySlug, input.companyUrl);
    if (!origin) {
      this.logger.warn('Could not resolve a Softgarden tenant origin from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(SOFTGARDEN_HEADERS);

    const resultsWanted = input.resultsWanted ?? SOFTGARDEN_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Softgarden jobs for origin: ${origin}`);

      const feed = await this.fetchFeed(client, origin);
      if (!feed) {
        this.logger.warn(`Softgarden: no feed available for ${origin}`);
        return new JobResponseDto([]);
      }

      const elements = Array.isArray(feed.dataFeedElement) ? feed.dataFeedElement : [];
      const fallbackCompany = this.deriveCompanyName(input.companySlug ?? origin);

      for (const element of elements) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processElement(
            element,
            origin,
            fallbackCompany,
            input.descriptionFormat,
          );
          if (!post) continue;
          const key = post.atsId as string;
          if (seen.has(key)) continue;
          seen.add(key);
          jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Softgarden: error processing job element: ${err.message}`);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Softgarden total: ${trimmed.length} jobs for ${origin}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Softgarden scrape error for ${origin}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Fetch and parse the anonymous JobPosting DataFeed for a tenant origin.
   * Returns null when the tenant is unknown (HTTP 404) or the body is unusable.
   */
  private async fetchFeed(
    client: ReturnType<typeof createHttpClient>,
    origin: string,
  ): Promise<SoftgardenFeedResponse | null> {
    const url = `${origin}${SOFTGARDEN_FEED_PATH}`;
    try {
      const response = await client.get<SoftgardenFeedResponse | string>(url);
      const body = response.data;
      // Some hosts answer 200 with an HTML error/landing page for the legacy
      // board; only a parsed object with `dataFeedElement` is a real feed.
      const parsed = this.coerceFeed(body);
      if (!parsed || !Array.isArray(parsed.dataFeedElement)) {
        this.logger.warn(`Softgarden: feed at ${url} was not a JobPosting DataFeed`);
        return null;
      }
      return parsed;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 400 || status === 403) {
        this.logger.warn(`Softgarden tenant feed not found (HTTP ${status}) for ${origin}`);
        return null;
      }
      throw err;
    }
  }

  /** Tolerate a string-typed JSON body by parsing it; pass objects through. */
  private coerceFeed(body: SoftgardenFeedResponse | string | undefined): SoftgardenFeedResponse | null {
    if (!body) return null;
    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (!trimmed.startsWith('{')) return null;
      try {
        return JSON.parse(trimmed) as SoftgardenFeedResponse;
      } catch {
        return null;
      }
    }
    return body;
  }

  /** Map one `dataFeedElement` wrapper into a `JobPostDto`. */
  private processElement(
    element: SoftgardenFeedElement,
    origin: string,
    fallbackCompany: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const item = element?.item;
    if (!item) return null;

    const title = item.title?.trim();
    if (!title) return null;

    const atsId = this.extractId(item);
    if (!atsId) return null;

    const jobUrl = item.url?.trim() || this.buildJobUrl(origin, atsId);
    const companyName = item.hiringOrganization?.name?.trim()
      || item.identifier?.name?.trim()
      || fallbackCompany;

    const rawDescription = item.description ?? null;
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

    return new JobPostDto({
      id: `softgarden-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(item),
      description,
      datePosted: this.parseDate(item.datePosted),
      isRemote: this.detectRemote(item),
      emails: extractEmails(description),
      site: Site.SOFTGARDEN,
      atsId,
      atsType: 'softgarden',
      department: this.extractDepartment(item),
      applyUrl: jobUrl,
    });
  }

  /**
   * Extract the stable numeric ATS id from `identifier.value`, falling back to
   * the first numeric path segment of the job URL (`/jobs/{id}/...`).
   */
  private extractId(item: SoftgardenJobPosting): string {
    const idValue = item.identifier?.value;
    if (idValue !== null && idValue !== undefined && `${idValue}`.trim()) {
      return `${idValue}`.trim();
    }
    const url = item.url ?? '';
    const match = url.match(/\/jobs\/(\d+)\b/);
    if (match) return match[1];
    return '';
  }

  /**
   * Resolve the tenant origin (scheme + host) from an explicit slug — mapped to
   * the shared career apex — or from a fully qualified `companyUrl`.
   */
  private resolveOrigin(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A slug containing dots is treated as a bare hostname.
      if (slug.includes('.')) {
        const host = slug.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        return host ? `https://${host}` : '';
      }
      return SOFTGARDEN_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
    }
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        return u.origin;
      } catch {
        // Malformed URL — no origin recoverable.
      }
    }
    return '';
  }

  /** Build the public job-detail page URL for this tenant. */
  private buildJobUrl(origin: string, atsId: string): string {
    const path = SOFTGARDEN_JOB_PAGE_TEMPLATE.replace('{id}', encodeURIComponent(atsId));
    return `${origin}${path}`;
  }

  /** Derive a display company name from the slug or origin host. */
  private deriveCompanyName(slugOrOrigin: string): string {
    const cleaned = slugOrOrigin
      .replace(/^https?:\/\//, '')
      .replace(new RegExp(`\\.${SOFTGARDEN_CAREER_APEX.replace(/\./g, '\\.')}.*$`), '')
      .replace(/\.(softgarden|career)\..*$/, '')
      .replace(/\/.*$/, '')
      .replace(/\..*$/, '');
    return cleaned
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Pick the first `Place` from a `jobLocation` that may be a single value or array. */
  private firstPlace(
    jobLocation: SoftgardenPlace | SoftgardenPlace[] | null | undefined,
  ): SoftgardenPlace | null {
    if (!jobLocation) return null;
    if (Array.isArray(jobLocation)) return jobLocation[0] ?? null;
    return jobLocation;
  }

  /** Build a `LocationDto` from the structured `jobLocation.address`. */
  private extractLocation(item: SoftgardenJobPosting): LocationDto | null {
    const place = this.firstPlace(item.jobLocation);
    const address = place?.address;
    if (!address) return null;

    const city = address.addressLocality?.trim() || null;
    const region = address.addressRegion?.trim() || null;
    const country = address.addressCountry?.trim() || null;

    if (!city && !region && !country) return null;

    // Avoid duplicating the city as the region when both carry the same value.
    const state = region && region !== city ? region : null;

    return new LocationDto({ city, state, country });
  }

  /** Department is best approximated by the schema.org employment-type token. */
  private extractDepartment(item: SoftgardenJobPosting): string | null {
    const type = item.employmentType;
    if (Array.isArray(type)) {
      const first = type.find((t) => typeof t === 'string' && t.trim());
      return first ? this.humaniseToken(first) : null;
    }
    if (typeof type === 'string' && type.trim()) return this.humaniseToken(type);
    return null;
  }

  /** Turn a SCREAMING_SNAKE schema.org token into a readable label. */
  private humaniseToken(token: string): string {
    return token
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Detect remote roles from the schema.org `jobLocationType` token or from
   * keywords in the title / employment type.
   */
  private detectRemote(item: SoftgardenJobPosting): boolean {
    if ((item.jobLocationType ?? '').toUpperCase() === 'TELECOMMUTE') return true;
    const haystack = [
      item.title,
      Array.isArray(item.employmentType) ? item.employmentType.join(' ') : item.employmentType,
    ]
      .filter((v): v is string => typeof v === 'string')
      .join(' ')
      .toLowerCase();
    return (
      haystack.includes('remote')
      || haystack.includes('home office')
      || haystack.includes('homeoffice')
      || haystack.includes('work from home')
      || haystack.includes('wfh')
    );
  }

  /** Parse an ISO-8601 timestamp into a `YYYY-MM-DD` string. */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const parsed = new Date(value.trim());
      if (!isNaN(parsed.getTime())) return toDateOnly(value.trim());
    } catch {
      // ignore
    }
    return null;
  }
}
