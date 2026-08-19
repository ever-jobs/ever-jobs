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
  randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import {
  DAYFORCE_HOST,
  DAYFORCE_TENANT_HOST_TEMPLATE,
  DAYFORCE_SEARCH_PATH,
  DAYFORCE_JOB_BOARD_CODE,
  DAYFORCE_CULTURE_CODE,
  DAYFORCE_PAGE_SIZE,
  DAYFORCE_MAX_CONCURRENCY,
  DAYFORCE_REQUEST_DELAY_MS,
  DAYFORCE_HEADERS,
} from './dayforce.constants';
import {
  DayforceJobPosting,
  DayforceSearchResponse,
  DayforcePostingLocation,
} from './dayforce.types';

/**
 * Ceridian Dayforce HCM candidate-portal careers scraper — generic, multi-tenant.
 *
 * Resolves a tenant "client namespace" from `companySlug` / `siteNumber` (or an
 * explicit `companyUrl`), then pages the public geo job-posting search feed at
 * `https://jobs.dayforcehcm.com/api/geo/{client}/jobposting/search`. The first
 * page yields the total `maxCount`; remaining pages are fanned out concurrently
 * (bounded) and merged with `Promise.allSettled` so a single transient page
 * failure never nukes the batch.
 */
@SourcePlugin({
  site: Site.DAYFORCE,
  name: 'Dayforce',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class DayforceService implements IScraper {
  private readonly logger = new Logger(DayforceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Dayforce scraper');
      return new JobResponseDto([]);
    }

    const client = this.resolveClientNamespace(companySlug, input.siteNumber, input.companyUrl);
    const companyName = this.deriveCompanyName(client);
    const cultureCode = DAYFORCE_CULTURE_CODE;

    const http = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    http.setHeaders(DAYFORCE_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Dayforce jobs for tenant: ${client}`);

      // First page → postings + true total count.
      const first = await this.fetchPage(http, client, cultureCode, 0);
      this.collect(first.postings, client, companyName, cultureCode, input.descriptionFormat, seen, jobPosts);

      const total = Math.min(first.count || jobPosts.length, resultsWanted);

      if (jobPosts.length < total && first.postings.length === DAYFORCE_PAGE_SIZE) {
        const offsets: number[] = [];
        for (let start = DAYFORCE_PAGE_SIZE; start < total; start += DAYFORCE_PAGE_SIZE) {
          offsets.push(start);
        }

        // Bounded concurrent fan-out over the remaining pages.
        for (let i = 0; i < offsets.length; i += DAYFORCE_MAX_CONCURRENCY) {
          const chunk = offsets.slice(i, i + DAYFORCE_MAX_CONCURRENCY);
          const settled = await Promise.allSettled(
            chunk.map((start) => this.fetchPage(http, client, cultureCode, start)),
          );
          for (const result of settled) {
            if (result.status === 'fulfilled') {
              this.collect(
                result.value.postings,
                client,
                companyName,
                cultureCode,
                input.descriptionFormat,
                seen,
                jobPosts,
              );
            } else {
              this.logger.warn(`Dayforce page fetch failed: ${result.reason?.message ?? result.reason}`);
            }
          }
          if (i + DAYFORCE_MAX_CONCURRENCY < offsets.length) {
            await randomSleep(DAYFORCE_REQUEST_DELAY_MS, DAYFORCE_REQUEST_DELAY_MS * 2);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Dayforce total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Dayforce scrape error for ${client}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /** Fetch one search page; returns its postings and the tenant total count. */
  private async fetchPage(
    http: ReturnType<typeof createHttpClient>,
    client: string,
    cultureCode: string,
    start: number,
  ): Promise<{ postings: DayforceJobPosting[]; count: number }> {
    const url = `${DAYFORCE_HOST}${DAYFORCE_SEARCH_PATH.replace('{client}', encodeURIComponent(client))}`;
    const body = {
      clientNamespace: client,
      jobBoardCode: DAYFORCE_JOB_BOARD_CODE,
      cultureCode,
      distanceUnit: 1,
      paginationStart: start,
    };
    const response = await http.post(url, body);
    const data: DayforceSearchResponse = response.data ?? {};
    const postings = data.jobPostings ?? data.JobPostings ?? [];
    const total = data.maxCount ?? data.MaxCount ?? data.count ?? data.Count ?? 0;
    return { postings, count: total };
  }

  /** Map raw postings → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    postings: DayforceJobPosting[],
    client: string,
    companyName: string,
    cultureCode: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const posting of postings) {
      try {
        const post = this.processJob(posting, client, companyName, cultureCode, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Dayforce posting ${posting?.jobPostingId}: ${err.message}`);
      }
    }
  }

  private processJob(
    posting: DayforceJobPosting,
    client: string,
    companyName: string,
    cultureCode: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = posting.jobTitle ?? posting.Title ?? posting.title;
    if (!title) return null;

    const atsId = String(
      posting.jobPostingId ??
        posting.Id ??
        posting.id ??
        posting.jobReqId ??
        posting.ReferenceNumber ??
        posting.ParentRequisitionCode ??
        '',
    );
    if (!atsId) return null;

    const culture = posting.CultureCode ?? posting.cultureCode ?? cultureCode;
    const jobUrl = this.buildJobUrl(posting, client, culture, atsId);
    const applyUrl =
      this.absolutize(posting.ApplyUrl ?? posting.applyUrl ?? null) ?? jobUrl;

    const rawDescription = posting.jobDescription ?? posting.Description ?? posting.description ?? null;
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
      posting.JobFunction ?? posting.jobFunction ?? posting.department ?? posting.Department ?? posting.category ?? null;

    return new JobPostDto({
      id: `dayforce-${atsId}`,
      title,
      companyName: posting.CompanyName ?? posting.companyName ?? posting.ClientSiteName ?? companyName,
      jobUrl,
      location: this.extractLocation(posting),
      description,
      datePosted: this.parseDate(
        posting.postingStartTimestampUTC ?? posting.DatePosted ?? posting.datePosted ?? posting.LastUpdated,
      ),
      isRemote: this.detectRemote(posting),
      emails: extractEmails(description),
      site: Site.DAYFORCE,
      atsId,
      atsType: 'dayforce',
      department,
      employmentType: posting.JobType ?? posting.jobType ?? posting.EmploymentIndicator ?? null,
      applyUrl,
    });
  }

  /**
   * Resolve the Dayforce "client namespace" — the path segment that selects the
   * tenant. Prefer an explicit `companyUrl` (the second path segment after the
   * locale, or the subdomain of a legacy `{client}.dayforcehcm.com` host); fall
   * back to `companySlug`, then `siteNumber`.
   */
  private resolveClientNamespace(
    companySlug: string | undefined,
    siteNumber: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companyUrl) {
      const fromUrl = this.clientFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return (companySlug ?? siteNumber ?? '').trim();
  }

  /** Extract the client namespace from a Dayforce careers URL. */
  private clientFromUrl(companyUrl: string): string | null {
    try {
      const u = new URL(companyUrl);
      // Legacy per-tenant host: {client}.dayforcehcm.com
      const hostParts = u.host.split('.');
      if (hostParts.length >= 3 && hostParts[0] && hostParts[0] !== 'jobs' && hostParts[0] !== 'www') {
        return hostParts[0];
      }
      // Shared host: /CandidatePortal/{locale}/{client}/... or /{locale}/{client}/{board}
      const segments = u.pathname.split('/').map((s) => s.trim()).filter(Boolean);
      const idx = segments.findIndex((s) => /^[a-z]{2}-[a-z]{2}$/i.test(s));
      if (idx >= 0 && segments[idx + 1]) return segments[idx + 1];
      // Fallback: skip a leading "CandidatePortal" segment and take the next.
      const portalIdx = segments.findIndex((s) => /candidateportal/i.test(s));
      if (portalIdx >= 0 && segments[portalIdx + 1]) return segments[portalIdx + 1];
      if (segments.length > 0) return segments[0];
    } catch {
      // Fall through to slug-based resolution.
    }
    return null;
  }

  private deriveCompanyName(client: string): string {
    const base = client || 'Dayforce';
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Build an absolute job-detail URL, resolving root-relative canonical paths. */
  private buildJobUrl(
    posting: DayforceJobPosting,
    client: string,
    cultureCode: string,
    atsId: string,
  ): string {
    const canonical = this.absolutize(posting.JobDetailsUrl ?? posting.jobDetailsUrl ?? null);
    if (canonical) return canonical;
    // Synthesize the legacy candidate-portal detail view.
    const tenantHost = DAYFORCE_TENANT_HOST_TEMPLATE.replace('{client}', encodeURIComponent(client));
    return `${tenantHost}/CandidatePortal/${cultureCode}/${encodeURIComponent(client)}/Posting/View/${encodeURIComponent(atsId)}`;
  }

  /** Absolutize a possibly root-relative URL against the shared Dayforce host. */
  private absolutize(url: string | null): string | null {
    if (!url) return null;
    if (url.startsWith('/')) return `${DAYFORCE_HOST}${url}`;
    if (/^https?:\/\//i.test(url)) return url;
    return null;
  }

  /** Dayforce returns a `postingLocations` array (geo) or flat fields (RESTful). */
  private extractLocation(posting: DayforceJobPosting): LocationDto | null {
    const locs = posting.postingLocations ?? posting.PostingLocations;
    if (Array.isArray(locs) && locs.length > 0) {
      const loc = this.locationFromObject(locs[0]);
      if (loc) return loc;
    }
    const city = posting.City ?? posting.city ?? null;
    const state = posting.State ?? posting.state ?? null;
    const country = posting.Country ?? posting.country ?? null;
    if (city || state || country) {
      return new LocationDto({ city, state, country });
    }
    return null;
  }

  private locationFromObject(obj: DayforcePostingLocation): LocationDto | null {
    const city = obj.city ?? obj.City ?? null;
    const state = obj.state ?? obj.stateCode ?? obj.State ?? null;
    const country = obj.country ?? obj.countryCode ?? obj.Country ?? null;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote from telecommute percentage or an explicit remote flag. */
  private detectRemote(posting: DayforceJobPosting): boolean {
    if (posting.isRemote === true) return true;
    const tele = posting.TelecommutePercentage;
    if (typeof tele === 'number' && tele >= 100) return true;
    if (typeof tele === 'string' && /^100/.test(tele.trim())) return true;
    const locs = posting.postingLocations ?? posting.PostingLocations;
    if (Array.isArray(locs) && locs.some((l) => l?.isRemote === true)) return true;
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
