import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import { createHttpClient, htmlToPlainText, markdownConverter, extractEmails } from '@ever-jobs/common';
import { WEB3CAREER_API_URL, WEB3CAREER_HEADERS } from './web3career.constants';
import { Web3CareerJob, Web3CareerResponse } from './web3career.types';

@SourcePlugin({
  site: Site.WEB3CAREER,
  name: 'Web3Career',
  category: 'niche',
})
@Injectable()
export class Web3CareerService implements IScraper {
  private readonly logger = new Logger(Web3CareerService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const limit = input.resultsWanted ?? 100;

    this.logger.log(
      `Web3Career scrape: search="${input.searchTerm ?? ''}" limit=${limit}`,
    );

    try {
      const http = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        timeout: input.requestTimeout,
      });

      const response = await http.get<Web3CareerJob[] | Web3CareerResponse>(WEB3CAREER_API_URL, {
        headers: WEB3CAREER_HEADERS,
        params: { token: 'public' },
      });

      const raw = response.data;

      // Handle response format (may be array or object with data/jobs field)
      let jobEntries: Web3CareerJob[];
      if (Array.isArray(raw)) {
        jobEntries = raw;
      } else if (raw && typeof raw === 'object') {
        const obj = raw as Web3CareerResponse;
        jobEntries = obj.data ?? obj.jobs ?? [];
      } else {
        this.logger.warn('Web3Career returned empty or invalid response');
        return new JobResponseDto([]);
      }

      // Filter by searchTerm if provided
      let filtered = jobEntries;
      if (input.searchTerm) {
        const term = input.searchTerm.toLowerCase();
        filtered = jobEntries.filter((job) => {
          const titleMatch = job.title?.toLowerCase().includes(term);
          const tagsMatch = job.tags?.some((tag) =>
            tag.toLowerCase().includes(term),
          );
          return titleMatch || tagsMatch;
        });
      }

      // Limit results
      const limited = filtered.slice(0, limit);

      this.logger.log(
        `Web3Career: ${jobEntries.length} total, ${filtered.length} after filter, returning ${limited.length}`,
      );

      const jobs: JobPostDto[] = [];

      for (const entry of limited) {
        try {
          const job = this.mapJob(entry, input.descriptionFormat);
          if (job) {
            jobs.push(job);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error mapping Web3Career job ${entry.id}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Web3Career scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Map a raw Web3Career API job object to a JobPostDto.
   */
  private mapJob(
    entry: Web3CareerJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    const jobUrl = entry.url || entry.link || null;
    if (!entry.title || !jobUrl) {
      return null;
    }

    // Process description (Web3Career may return HTML)
    let description: string | null = entry.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build compensation if salary data is present
    let compensation: CompensationDto | null = null;
    if (entry.salary_min && entry.salary_max && entry.salary_min > 0 && entry.salary_max > 0) {
      compensation = new CompensationDto({
        interval: CompensationInterval.YEARLY,
        minAmount: entry.salary_min,
        maxAmount: entry.salary_max,
        currency: entry.salary_currency ?? 'USD',
      });
    }

    // Build location
    const location = new LocationDto({
      city: entry.location || null,
    });

    // Parse date
    const rawDate = entry.date_posted || entry.created_at;
    const datePosted = rawDate ? rawDate.split('T')[0] : null;

    return new JobPostDto({
      id: `web3career-${entry.id}`,
      title: entry.title,
      companyName: entry.company || null,
      companyLogo: entry.company_logo || null,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      isRemote: entry.is_remote ?? entry.remote ?? false,
      emails: extractEmails(description),
      site: Site.WEB3CAREER,
      skills: entry.tags?.length ? entry.tags : null,
    });
  }
}
