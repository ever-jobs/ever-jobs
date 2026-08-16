import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  DescriptionFormat,
  Site,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  htmlToPlainText,
  markdownConverter,
  parseLocationList,
} from '@ever-jobs/common';
import {
  JAZZHR_DETAIL_CONCURRENCY,
  JAZZHR_HEADERS,
  jazzhrApiUrl,
  jazzhrBoardUrl,
  jazzhrDetailUrl,
} from './jazzhr.constants';
import { JazzHRJobDetail, JazzHRJobListing } from './jazzhr.types';

@SourcePlugin({
  site: Site.JAZZHR,
  name: 'JazzHR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class JazzHRService implements IScraper {
  private readonly logger = new Logger(JazzHRService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for JazzHR scraper');
      return new JobResponseDto([]);
    }

    // Per-request auth overrides env var; the API path is optional.
    const apiKey = input.auth?.jazzhr?.apiKey ?? process.env.JAZZHR_API_KEY;
    if (apiKey) {
      try {
        return await this.scrapeWithApi(apiKey, companySlug, input);
      } catch (err: any) {
        this.logger.warn(
          `JazzHR authenticated API failed for ${companySlug}: ${err.message}. Falling back to HTML scraping.`,
        );
      }
    }

    return this.scrapeBoard(companySlug, input);
  }

  /**
   * Scrape the public career board. The board renders each job once in a desktop
   * <table id="jobs_table"> and again in a mobile block; reading only the table
   * keeps one row per job. The board omits the body and employment type, so each
   * role's detail page is overlaid before mapping.
   */
  private async scrapeBoard(
    companySlug: string,
    input: ScraperInputDto,
  ): Promise<JobResponseDto> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JAZZHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;

    try {
      const url = jazzhrBoardUrl(companySlug);
      this.logger.log(`Fetching JazzHR career page for company: ${companySlug}`);
      const { data: html } = await client.get<string>(url);
      if (!html || typeof html !== 'string') {
        this.logger.warn(`JazzHR: empty response for ${companySlug}`);
        return new JobResponseDto([]);
      }

      const $ = cheerio.load(html);
      const boardCompanyName = this.organizationName($);
      const listings = this.parseBoard($, companySlug).slice(0, resultsWanted);

      const details = await this.fetchDetails(client, companySlug, listings);

      const jobs: JobPostDto[] = [];
      listings.forEach((listing, index) => {
        try {
          jobs.push(
            this.processJob(
              listing,
              companySlug,
              boardCompanyName,
              details[index],
              input.descriptionFormat,
            ),
          );
        } catch (err: any) {
          this.logger.warn(
            `Error processing JazzHR job ${listing.code}: ${err.message}`,
          );
        }
      });

      this.logger.log(`JazzHR: found ${jobs.length} jobs for ${companySlug}`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`JazzHR scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /** The board embeds a schema.org Organization carrying the display name. */
  private organizationName($: cheerio.CheerioAPI): string | null {
    let name: string | null = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (name) return;
      const raw = $(el).contents().text();
      if (!raw.trim()) return;
      try {
        const parsed = JSON.parse(raw);
        for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
          if (node && node['@type'] === 'Organization' && node.name) {
            name = String(node.name).trim() || null;
            break;
          }
        }
      } catch {
        // Non-JSON ld+json block; ignore.
      }
    });
    return name;
  }

  /**
   * Parse the desktop <table id="jobs_table"> rows. A job is an
   * <a class="job_title_link"> in a row; the second cell is the location and the
   * department is either an inline <span class="resumator_department"> or the most
   * recent <tr class="resumator_department_heading"> section row.
   */
  private parseBoard(
    $: cheerio.CheerioAPI,
    companySlug: string,
  ): JazzHRJobListing[] {
    const listings: JazzHRJobListing[] = [];
    const seen = new Set<string>();
    let currentDept: string | null = null;

    $('#jobs_table tr').each((_, row) => {
      const $row = $(row);
      if ($row.hasClass('resumator_department_heading')) {
        currentDept = $row.find('td').first().text().trim() || null;
        return;
      }

      const anchor = $row.find('a.job_title_link').first();
      if (anchor.length === 0) return;

      const title = anchor.text().trim();
      const href = anchor.attr('href') ?? '';
      const code = this.boardCode(href);
      if (!title || !code || seen.has(code)) return;
      seen.add(code);

      const cells = $row.find('td');
      const location = cells.eq(1).text().trim() || null;
      const inlineDept = $row.find('span.resumator_department').first().text().trim();

      listings.push({
        code,
        title,
        location,
        department: inlineDept || currentDept,
        jobUrl: jazzhrDetailUrl(companySlug, code),
      });
    });

    return listings;
  }

  private boardCode(href: string): string | null {
    const match = href.match(/\/details\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  private processJob(
    listing: JazzHRJobListing,
    companySlug: string,
    boardCompanyName: string | null,
    detail: JazzHRJobDetail | null | undefined,
    format?: DescriptionFormat,
  ): JobPostDto {
    const parsedLocation = listing.location
      ? parseLocationList([listing.location])
      : null;
    const location = parsedLocation?.location ?? null;
    const isRemote =
      (parsedLocation?.remoteMentioned ?? false) ||
      /\bremote\b/i.test(listing.title);

    const description = this.formatDescription(detail?.description, format);

    // The display name comes from the board's Organization ld+json (or the
    // detail's h2.job_company); the slug is only a last resort.
    const companyName =
      boardCompanyName || detail?.companyName || companySlug;

    const employmentType = detail?.employmentType ?? null;
    const mappedJobType = employmentType
      ? getJobTypeFromString(employmentType)
      : null;

    const id = `jazzhr-${companySlug}-${listing.code}`;

    return new JobPostDto({
      id,
      site: Site.JAZZHR,
      title: listing.title,
      companyName,
      jobUrl: listing.jobUrl,
      location,
      description,
      emails: extractEmails(description),
      isRemote,
      ...(mappedJobType ? { jobType: [mappedJobType] } : {}),
      department: listing.department,
      ...(employmentType ? { employmentType } : {}),
      atsId: listing.code,
      atsType: 'jazzhr',
    });
  }

  /**
   * Fetch each job's detail page under bounded concurrency and parse the body,
   * employment type, and display company out of it. A failed fetch yields `null`
   * for that job (the batch is never nuked).
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    companySlug: string,
    listings: JazzHRJobListing[],
  ): Promise<(JazzHRJobDetail | null)[]> {
    const details: (JazzHRJobDetail | null)[] = new Array(listings.length).fill(
      null,
    );

    for (
      let index = 0;
      index < listings.length;
      index += JAZZHR_DETAIL_CONCURRENCY
    ) {
      const batch = listings.slice(index, index + JAZZHR_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((listing) =>
          this.fetchDetail(client, companySlug, listing),
        ),
      );
      settled.forEach((result, batchIndex) => {
        if (result.status === 'fulfilled') {
          details[index + batchIndex] = result.value;
        }
      });
    }

    return details;
  }

  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    companySlug: string,
    listing: JazzHRJobListing,
  ): Promise<JazzHRJobDetail | null> {
    try {
      const { data: html } = await client.get<string>(
        jazzhrDetailUrl(companySlug, listing.code),
        { responseType: 'text' },
      );
      if (typeof html !== 'string') return null;
      return this.parseDetail(html);
    } catch (err: any) {
      this.logger.warn(
        `JazzHR: detail fetch failed for ${companySlug}/${listing.code}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Parse a detail page: the full body (div.job_description), the display company
   * (h2.job_company), and the "Dept - Location - Type" h3.job_meta whose trailing
   * segment is the employment type.
   */
  private parseDetail(html: string): JazzHRJobDetail {
    const $ = cheerio.load(html);
    const descriptionHtml = $('.job_description').first().html();
    const companyName = $('.job_company').first().text().trim() || null;

    let employmentType: string | null = null;
    const meta = $('.job_meta').first().text().trim();
    if (meta) {
      const segments = meta
        .split(' - ')
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (segments.length >= 2) {
        employmentType = segments[segments.length - 1];
      }
    }

    return {
      description: descriptionHtml?.trim() ? descriptionHtml : null,
      employmentType,
      companyName,
    };
  }

  private formatDescription(
    html: string | null | undefined,
    format?: DescriptionFormat,
  ): string | null {
    if (!html || !html.trim()) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.PLAIN) return htmlToPlainText(html);
    return markdownConverter(html) ?? html;
  }

  /**
   * Fetch jobs using the authenticated JazzHR REST API.
   *
   * @see https://www.jazzhr.com/api/
   */
  private async scrapeWithApi(
    apiKey: string,
    companySlug: string,
    input: ScraperInputDto,
  ): Promise<JobResponseDto> {
    this.logger.log(`JazzHR: using authenticated API for company: ${companySlug}`);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    const response = await client.get(jazzhrApiUrl(apiKey), {
      headers: { Accept: 'application/json' },
    });

    const jobs: any[] = Array.isArray(response.data) ? response.data : [];
    this.logger.log(
      `JazzHR (authenticated): found ${jobs.length} jobs for ${companySlug}`,
    );

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];

    for (const job of jobs) {
      if (jobPosts.length >= resultsWanted) break;
      try {
        const post = this.mapApiJob(job, companySlug, input.descriptionFormat);
        if (post) jobPosts.push(post);
      } catch (err: any) {
        this.logger.warn(
          `Error processing JazzHR API job ${job.id}: ${err.message}`,
        );
      }
    }

    return new JobResponseDto(jobPosts);
  }

  /**
   * Map a JazzHR API job object to a JobPostDto.
   *
   * API response fields include: id, title, city, state, zip,
   * department, description, type, original_open_date, board_code.
   */
  private mapApiJob(
    job: any,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const description = this.formatDescription(job.description, format);

    const city = job.city || null;
    const state = job.state || null;
    const location = city || state ? new LocationDto({ city, state }) : null;

    const code = job.board_code || job.id;
    const jobUrl = code ? jazzhrDetailUrl(companySlug, String(code)) : undefined;

    const employmentType = job.type ?? null;
    const mappedJobType = employmentType
      ? getJobTypeFromString(employmentType)
      : null;

    return new JobPostDto({
      id: `jazzhr-${companySlug}-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      datePosted: job.original_open_date ?? null,
      emails: extractEmails(description),
      site: Site.JAZZHR,
      ...(mappedJobType ? { jobType: [mappedJobType] } : {}),
      atsId: job.id ?? null,
      atsType: 'jazzhr',
      department: job.department ?? null,
      ...(employmentType ? { employmentType } : {}),
    });
  }
}
