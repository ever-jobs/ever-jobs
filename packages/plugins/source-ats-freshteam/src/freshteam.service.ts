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
  toDateOnly,
} from '@ever-jobs/common';
import { FRESHTEAM_HEADERS } from './freshteam.constants';
import { FreshteamJobPosting } from './freshteam.types';

@SourcePlugin({
  site: Site.FRESHTEAM,
  name: 'Freshteam',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class FreshteamService implements IScraper {
  private readonly logger = new Logger(FreshteamService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Freshteam scraper');
      return new JobResponseDto([]);
    }

    // Check for API key: per-request auth overrides env var
    const authAny = input.auth as Record<string, any> | undefined;
    const apiKey =
      authAny?.freshteam?.apiKey ?? process.env.FRESHTEAM_API_KEY;
    if (!apiKey) {
      this.logger.warn(
        `Freshteam: no API key available for ${companySlug}. ` +
          'Provide FRESHTEAM_API_KEY env var or input.auth.freshteam.apiKey.',
      );
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(FRESHTEAM_HEADERS);

    const url = `https://${encodeURIComponent(companySlug)}.freshteam.com/api/job_postings`;

    try {
      this.logger.log(`Fetching Freshteam jobs for company: ${companySlug}`);
      const response = await client.get(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      const postings: FreshteamJobPosting[] = response.data ?? [];

      this.logger.log(
        `Freshteam: found ${postings.length} job postings for ${companySlug}`,
      );

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const posting of postings) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processPosting(
            posting,
            companySlug,
            input.descriptionFormat,
          );
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error processing Freshteam posting ${posting.id}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(
        `Freshteam scrape error for ${companySlug}: ${err.message}`,
      );
      return new JobResponseDto([]);
    }
  }

  private processPosting(
    posting: FreshteamJobPosting,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = posting.title;
    if (!title) return null;

    // Description is HTML
    let description: string | null = null;
    if (posting.description) {
      if (format === DescriptionFormat.HTML) {
        description = posting.description;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description =
          markdownConverter(posting.description) ?? posting.description;
      } else {
        description = htmlToPlainText(posting.description);
      }
    }

    // Location from branch field (Freshteam uses "branch" for office/location)
    const location = new LocationDto({
      city: posting.branch ?? null,
    });

    // Job URL from applicant_apply_link or constructed URL
    const jobUrl =
      posting.applicant_apply_link ??
      `https://${companySlug}.freshteam.com/jobs/${posting.id}`;

    // Date posted
    const datePosted = posting.created_at
      ? toDateOnly(posting.created_at)
      : null;

    return new JobPostDto({
      id: `freshteam-${posting.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      datePosted,
      isRemote: posting.remote ?? false,
      emails: extractEmails(description),
      site: Site.FRESHTEAM,
      // ATS-specific fields
      atsId: String(posting.id),
      atsType: 'freshteam',
      department: posting.department ?? null,
      employmentType: posting.type ?? null,
    });
  }
}
