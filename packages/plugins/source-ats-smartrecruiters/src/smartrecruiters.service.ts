import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  classifyScrapeError,
  ScrapeDiagnostics,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  randomSleep,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
  firstPublicUrl,
} from '@ever-jobs/common';
import {
  SMARTRECRUITERS_API_URL,
  SMARTRECRUITERS_HEADERS,
  SMARTRECRUITERS_PAGE_SIZE,
  SMARTRECRUITERS_PUBLIC_JOBS_URL,
} from './smartrecruiters.constants';
import { SmartRecruitersJob, SmartRecruitersResponse } from './smartrecruiters.types';

@SourcePlugin({
  site: Site.SMARTRECRUITERS,
  name: 'SmartRecruiters',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SmartRecruitersService implements IScraper {
  private readonly logger = new Logger(SmartRecruitersService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for SmartRecruiters scraper');
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('bad_input', 'no companySlug provided'),
      );
    }

    // Check for API key: per-request auth overrides env var
    const apiKey =
      input.auth?.smartrecruiters?.apiKey ?? process.env.SMARTRECRUITERS_API_KEY;
    if (apiKey) {
      try {
        const result = await this.scrapeWithApi(apiKey, companySlug, input);
        return result;
      } catch (err: any) {
        this.logger.warn(
          `SmartRecruiters authenticated API failed for ${companySlug}: ${err.message}. Falling back to public scraping.`,
        );
      }
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(SMARTRECRUITERS_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];
    let offset = 0;

    try {
      this.logger.log(`Fetching SmartRecruiters jobs for company: ${companySlug}`);

      while (jobPosts.length < resultsWanted) {
        const url =
          `${SMARTRECRUITERS_API_URL}/${encodeURIComponent(companySlug)}/postings` +
          `?offset=${offset}&limit=${SMARTRECRUITERS_PAGE_SIZE}`;

        const response = await client.get(url);
        const data: SmartRecruitersResponse = response.data ?? { content: [] };
        const jobs = data.content ?? [];

        if (jobs.length === 0) break;

        this.logger.log(
          `SmartRecruiters: fetched ${jobs.length} jobs at offset ${offset} for ${companySlug}`,
        );

        for (const job of jobs) {
          if (jobPosts.length >= resultsWanted) break;

          try {
            const post = this.processJob(job, companySlug, input.descriptionFormat);
            if (post) {
              jobPosts.push(post);
            }
          } catch (err: any) {
            this.logger.warn(
              `Error processing SmartRecruiters job ${job.id}: ${err.message}`,
            );
          }
        }

        offset += jobs.length;

        // If we got less than page size, there are no more results
        if (jobs.length < SMARTRECRUITERS_PAGE_SIZE) break;

        // Delay between pagination requests
        await randomSleep(500, 1500);
      }

      this.logger.log(`SmartRecruiters total: ${jobPosts.length} jobs for ${companySlug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`SmartRecruiters scrape error for ${companySlug}: ${err.message}`);
      // Partial results WITH a reason: `jobs.length > 0` plus a diagnostic is
      // inferred as `partial` upstream, so a page-2 failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch jobs using the authenticated SmartRecruiters API.
   * Uses X-SmartToken header auth and reuses processJob() for mapping.
   *
   * @see https://dev.smartrecruiters.com/customer-api/live-docs/
   */
  private async scrapeWithApi(
    apiKey: string,
    companySlug: string,
    input: ScraperInputDto,
  ): Promise<JobResponseDto> {
    this.logger.log(
      `SmartRecruiters: using authenticated API for company: ${companySlug}`,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];
    let offset = 0;

    while (jobPosts.length < resultsWanted) {
      const url =
        `${SMARTRECRUITERS_API_URL}/${encodeURIComponent(companySlug)}/postings` +
        `?offset=${offset}&limit=${SMARTRECRUITERS_PAGE_SIZE}`;

      const response = await client.get(url, {
        headers: {
          Accept: 'application/json',
          'X-SmartToken': apiKey,
        },
      });

      const data: SmartRecruitersResponse = response.data ?? { content: [] };
      const jobs = data.content ?? [];

      if (jobs.length === 0) break;

      this.logger.log(
        `SmartRecruiters (authenticated): fetched ${jobs.length} jobs at offset ${offset} for ${companySlug}`,
      );

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJob(job, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error processing SmartRecruiters API job ${job.id}: ${err.message}`,
          );
        }
      }

      offset += jobs.length;

      // If we got less than page size, there are no more results
      if (jobs.length < SMARTRECRUITERS_PAGE_SIZE) break;

      // Delay between pagination requests
      await randomSleep(500, 1500);
    }

    this.logger.log(
      `SmartRecruiters (authenticated) total: ${jobPosts.length} jobs for ${companySlug}`,
    );
    return new JobResponseDto(jobPosts);
  }

  private processJob(
    job: SmartRecruitersJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.name;
    if (!title) return null;

    // Identity. `ref` is the posting's API resource
    // (`…/v1/companies/<Co>/postings/<id>`): it is read only as a fallback
    // source of the id and the company identifier, never used as a link.
    const fromRef = this.parseRef(job.ref);
    const postingId = this.nonEmpty(job.id) ?? fromRef?.postingId ?? null;
    if (!postingId) return null;

    // Location
    const loc = job.location;
    const location = loc
      ? new LocationDto({
          city: loc.city ?? null,
          state: loc.region ?? null,
          country: loc.country ?? null,
        })
      : null;

    const isRemote = loc?.remote ?? false;

    // Date
    const datePosted = job.releasedDate ?? null;

    // Job URL (Spec 1750): the public posting page. The detail endpoint's
    // `postingUrl` when present; otherwise the public pattern built from the
    // company identifier the API returned (case-sensitive: `AbbVie`, not the
    // caller's `abbvie`). `applyUrl` exists on the detail endpoint only.
    const identifier =
      this.nonEmpty(job.company?.identifier) ??
      fromRef?.companyIdentifier ??
      companySlug.trim();
    const jobUrl =
      firstPublicUrl(job.postingUrl) ??
      `${SMARTRECRUITERS_PUBLIC_JOBS_URL}/${encodeURIComponent(identifier)}/${encodeURIComponent(postingId)}`;
    const applyUrl = firstPublicUrl(job.applyUrl);

    // Description from jobAd sections
    let description: string | null = null;
    const sections = job.jobAd?.sections;
    if (sections) {
      const parts = [
        sections.jobDescription?.text,
        sections.qualifications?.text,
        sections.additionalInformation?.text,
      ].filter(Boolean);

      if (parts.length > 0) {
        const rawHtml = parts.join('\n');
        if (format === DescriptionFormat.HTML) {
          description = rawHtml;
        } else if (format === DescriptionFormat.MARKDOWN) {
          description = markdownConverter(rawHtml) ?? rawHtml;
        } else {
          description = htmlToPlainText(rawHtml);
        }
      }
    }

    return new JobPostDto({
      id: `sr-${postingId}`,
      title,
      companyName: job.company?.name ?? companySlug,
      jobUrl,
      applyUrl,
      location,
      description,
      datePosted: datePosted
        ? toDateOnly(datePosted)
        : null,
      isRemote,
      emails: extractEmails(description),
      site: Site.SMARTRECRUITERS,
      // ATS-specific fields — `atsId` is the same posting id `id` and `jobUrl` carry.
      atsId: postingId,
      atsType: 'smartrecruiters',
      department: job.department?.label ?? null,
      employmentType: job.typeOfEmployment?.label ?? null,
    });
  }

  /** A trimmed non-empty string (numbers are stringified), else `null`. */
  private nonEmpty(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  /**
   * Read the company identifier and posting id out of an API `ref`
   * (`https://api.smartrecruiters.com/v1/companies/<Co>/postings/<id>`).
   * Returns `null` for anything else.
   */
  private parseRef(
    ref: string | null | undefined,
  ): { companyIdentifier: string; postingId: string } | null {
    if (typeof ref !== 'string' || !ref.trim()) return null;
    let path: string;
    try {
      path = new URL(ref.trim()).pathname;
    } catch {
      return null;
    }
    const match = /\/companies\/([^/]+)\/postings\/([^/?#]+)/.exec(path);
    if (!match) return null;
    try {
      return {
        companyIdentifier: decodeURIComponent(match[1]),
        postingId: decodeURIComponent(match[2]),
      };
    } catch {
      return null;
    }
  }
}
