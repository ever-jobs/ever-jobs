import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
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
  toDateOnly,
  parseJobPostingLd,
  jobPostingLdToCompensation,
} from '@ever-jobs/common';
import {
  JOBVITE_ROOT_DOMAIN,
  JOBVITE_DEFAULT_RESULTS,
  JOBVITE_MAX_DETAIL_FETCHES,
  JOBVITE_DETAIL_CONCURRENCY,
  JOBVITE_DEFAULT_TIMEOUT_SECONDS,
  JOBVITE_HEADERS,
  JOBVITE_JOB_ID_REGEX,
  JOBVITE_TITLE_COMPANY_REGEX,
  JOBVITE_REMOTE_REGEX,
  jobviteBoardUrl,
  jobviteJobDetailUrl,
} from './jobvite.constants';
import { JobviteListItem, JobviteDetailData } from './jobvite.types';

/**
 * Jobvite ATS careers scraper — generic, multi-tenant.
 *
 * Jobvite career boards live at `https://jobs.jobvite.com/{slug}/`. Although the
 * board is an Angular SPA, Jobvite serves fully server-rendered HTML for the two
 * views this adapter needs: the `/{slug}/jobs` list (job rows grouped under
 * `<h3>` department headings) and each `/{slug}/job/{jobId}` detail page (a
 * schema.org `JobPosting` JSON-LD block). The adapter parses the list for the
 * department grouping + job ids, then fans out to the detail pages and consumes
 * the shared JSON-LD extractor for description, date, employment type,
 * structured location, remote flag, and compensation.
 *
 * The caller addresses a tenant by `companySlug` (the board slug, e.g.
 * `nuscale-power`) or by `companyUrl` (any `jobs.jobvite.com/{slug}` URL). A
 * fetch error, an unknown tenant, or a tenant that has moved off Jobvite (its
 * board 3xx-redirects away) degrades to an empty result rather than throwing, so
 * a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.JOBVITE,
  name: 'Jobvite',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class JobviteService implements IScraper {
  private readonly logger = new Logger(JobviteService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Jobvite scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveTenant(input.companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a Jobvite tenant slug from input');
      return new JobResponseDto([]);
    }

    const timeoutSeconds = Math.min(
      input.requestTimeout ?? JOBVITE_DEFAULT_TIMEOUT_SECONDS,
      JOBVITE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(JOBVITE_HEADERS);

    const resultsWanted = input.resultsWanted ?? JOBVITE_DEFAULT_RESULTS;

    try {
      this.logger.log(`Fetching Jobvite jobs for tenant: ${slug}`);

      const boardHtml = await this.fetchText(client, jobviteBoardUrl(slug), slug);
      if (!boardHtml) {
        this.logger.log(`Jobvite: no server-rendered board for tenant "${slug}"`);
        return new JobResponseDto([]);
      }

      const { items, companyName } = this.parseBoard(boardHtml, slug);
      if (items.length === 0) {
        this.logger.log(`Jobvite tenant "${slug}" has no open roles`);
        return new JobResponseDto([]);
      }

      const wanted = Math.min(resultsWanted, JOBVITE_MAX_DETAIL_FETCHES);
      const selected = items.slice(0, wanted);

      const detailMap = await this.fetchDetails(client, slug, selected);

      const resolvedCompany = companyName ?? this.deriveCompanyName(slug);
      const jobPosts: JobPostDto[] = [];

      for (const item of selected) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const detail = detailMap.get(item.jobId) ?? null;
          jobPosts.push(this.toJobPost(item, slug, resolvedCompany, detail, input.descriptionFormat));
        } catch (err: any) {
          this.logger.warn(`Error processing Jobvite role ${item.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`Jobvite total: ${jobPosts.length} jobs for ${slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Jobvite scrape error for ${slug}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Parse the server-rendered `/{slug}/jobs` board into a de-duped list of rows.
   * Rows are grouped under `<h3 class="h2">{department}</h3>` headings, each
   * followed by a `table.jv-job-list`; the department for a row is the nearest
   * preceding heading.
   */
  private parseBoard(html: string, slug: string): { items: JobviteListItem[]; companyName: string | null } {
    const $ = cheerio.load(html);

    const titleText = $('title').first().text();
    const companyMatch = JOBVITE_TITLE_COMPANY_REGEX.exec(titleText.trim());
    const companyName = companyMatch ? this.cleanText(companyMatch[1]) : null;

    const items: JobviteListItem[] = [];
    const seen = new Set<string>();

    $('table.jv-job-list').each((_, table) => {
      const $table = $(table);
      const department = this.cleanText($table.prevAll('h3').first().text());

      $table.find('tbody tr').each((__, row) => {
        const item = this.parseRow($, $(row), slug, department);
        if (!item || seen.has(item.jobId)) return;
        seen.add(item.jobId);
        items.push(item);
      });
    });

    return { items, companyName };
  }

  /** Parse a single job row into a normalised list item. */
  private parseRow(
    $: cheerio.CheerioAPI,
    row: cheerio.Cheerio<any>,
    slug: string,
    department: string | null,
  ): JobviteListItem | null {
    const anchor = row.find('td.jv-job-list-name a').first();
    const href = anchor.attr('href');
    if (!href) return null;

    const title = this.cleanText(anchor.text());
    if (!title) return null;

    const idMatch = JOBVITE_JOB_ID_REGEX.exec(href);
    const jobId = idMatch ? idMatch[1] : null;
    if (!jobId) return null;

    const locationText = this.cleanText(row.find('td.jv-job-list-location').first().text());

    return {
      jobId,
      title,
      jobUrl: jobviteJobDetailUrl(slug, jobId),
      department,
      locationText,
    };
  }

  /**
   * Fan out to detail pages in bounded batches, extracting the JSON-LD
   * `JobPosting` fields. Returns a Map keyed by jobId.
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    items: JobviteListItem[],
  ): Promise<Map<string, JobviteDetailData>> {
    const result = new Map<string, JobviteDetailData>();

    for (let i = 0; i < items.length; i += JOBVITE_DETAIL_CONCURRENCY) {
      const batch = items.slice(i, i + JOBVITE_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (item) => {
          const html = await this.fetchText(client, jobviteJobDetailUrl(slug, item.jobId), slug);
          return { jobId: item.jobId, data: html ? this.parseDetail(html) : null };
        }),
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value.data) {
          result.set(r.value.jobId, r.value.data);
        }
      }
    }

    return result;
  }

  /** Extract the JSON-LD `JobPosting` fields from a detail page. */
  private parseDetail(html: string): JobviteDetailData | null {
    const posting = parseJobPostingLd(html)[0];
    if (!posting) return null;

    const loc = posting.locations[0] ?? null;
    return {
      descriptionHtml: posting.description,
      datePosted: posting.datePosted,
      employmentType: posting.employmentType,
      hiringOrganizationName: posting.hiringOrganizationName,
      isRemote: posting.remote,
      city: loc?.city ?? null,
      state: loc?.region ?? null,
      country: loc?.country ?? null,
      compensation: jobPostingLdToCompensation(posting.baseSalary),
    };
  }

  /** Map a list item + detail data → JobPostDto. */
  private toJobPost(
    item: JobviteListItem,
    slug: string,
    companyName: string,
    detail: JobviteDetailData | null,
    format: DescriptionFormat | undefined,
  ): JobPostDto {
    const isRemote =
      (detail?.isRemote ?? false) ||
      (item.locationText != null && JOBVITE_REMOTE_REGEX.test(item.locationText)) ||
      JOBVITE_REMOTE_REGEX.test(item.title);

    return new JobPostDto({
      id: `jobvite-${slug}-${item.jobId}`,
      title: item.title,
      companyName: detail?.hiringOrganizationName ?? companyName,
      jobUrl: item.jobUrl,
      location: this.buildLocation(item, detail, isRemote),
      description: this.formatDescription(detail?.descriptionHtml ?? null, format),
      datePosted: detail?.datePosted ? toDateOnly(detail.datePosted) : null,
      isRemote,
      emails: extractEmails(detail?.descriptionHtml ?? ''),
      site: Site.JOBVITE,
      atsId: item.jobId,
      atsType: 'jobvite',
      department: item.department,
      employmentType: detail?.employmentType ?? null,
      compensation: detail?.compensation ?? null,
      applyUrl: item.jobUrl,
    });
  }

  /**
   * Build a LocationDto from the detail JSON-LD structured location, falling back
   * to the list cell text, then to a bare "Remote" marker.
   */
  private buildLocation(
    item: JobviteListItem,
    detail: JobviteDetailData | null,
    isRemote: boolean,
  ): LocationDto | null {
    if (detail && (detail.city || detail.state || detail.country)) {
      return new LocationDto({ city: detail.city, state: detail.state, country: detail.country });
    }
    const parsed = this.parseLocationText(item.locationText);
    if (parsed.city || parsed.state || parsed.country) {
      return new LocationDto(parsed);
    }
    return isRemote ? new LocationDto({ city: 'Remote' }) : null;
  }

  /**
   * Parse a list location cell into parts — a comma-separated
   * "City, Region[, Country]" string. A single part becomes the city.
   */
  private parseLocationText(raw: string | null): {
    city: string | null;
    state: string | null;
    country: string | null;
  } {
    if (!raw) return { city: null, state: null, country: null };
    const parts = raw.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length === 0) return { city: null, state: null, country: null };
    if (parts.length === 1) return { city: parts[0], state: null, country: null };
    return { city: parts[0], state: parts[1], country: parts.slice(2).join(', ') || null };
  }

  /** Convert the HTML job-ad body per `descriptionFormat`. */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * GET a board URL as text. Does NOT follow redirects: a live tenant serves a
   * direct 200; a tenant that has moved off Jobvite 3xx-redirects away. Any 3xx,
   * 4xx, 5xx, DNS, or network error degrades to null (logged warn, no throw).
   */
  private async fetchText(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    slug: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, {
        responseType: 'text',
        maxRedirects: 0,
      });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        this.logger.warn(`Jobvite board returned HTTP ${status} for ${slug}`);
        return null;
      }
      this.logger.warn(`Jobvite board fetch failed for ${slug}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Resolve the tenant slug from companySlug or companyUrl. Accepts a bare slug,
   * a full board URL, or a companyUrl on the `jobs.jobvite.com` host (the first
   * path segment is the slug).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    const slug = companySlug?.trim();
    if (slug) {
      if (/^https?:\/\//i.test(slug) || slug.includes(JOBVITE_ROOT_DOMAIN)) {
        const fromUrl = this.slugFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.replace(/^\/+|\/+$/g, '').toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.slugFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /** Extract the first path segment (the slug) from a jobs.jobvite.com URL. */
  private slugFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      if (u.hostname.toLowerCase() !== JOBVITE_ROOT_DOMAIN) return '';
      const segment = u.pathname.split('/').filter((p) => p.length > 0)[0];
      return segment ? segment.toLowerCase() : '';
    } catch {
      return '';
    }
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(slug: string): string {
    return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }

  /** Trim a string, collapsing whitespace; null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.replace(/\s+/g, ' ').trim();
    return v.length > 0 ? v : null;
  }
}
