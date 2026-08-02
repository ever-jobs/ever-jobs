import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  DescriptionFormat,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { JOINRISE_API_URL, JOINRISE_HEADERS, JOINRISE_DEFAULT_RESULTS, JOINRISE_MAX_RESULTS } from './joinrise.constants';
import { JoinRiseResponse, JoinRiseJob } from './joinrise.types';

@SourcePlugin({
  site: Site.JOINRISE,
  name: 'JoinRise',
  category: 'niche',
})
@Injectable()
export class JoinRiseService implements IScraper {
  private readonly logger = new Logger(JoinRiseService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = Math.min(
      input.resultsWanted ?? JOINRISE_DEFAULT_RESULTS,
      JOINRISE_MAX_RESULTS,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JOINRISE_HEADERS);

    const params: Record<string, string> = {
      page: '1',
      limit: String(resultsWanted),
      sort: 'desc',
      sortedBy: 'createdAt',
    };

    if (input.location) {
      params.jobLoc = input.location;
    }

    const queryString = new URLSearchParams(params).toString();
    const url = `${JOINRISE_API_URL}?${queryString}`;

    this.logger.log(`Fetching JoinRise jobs: ${JOINRISE_API_URL}?...`);

    try {
      const response = await client.get(url);
      const data = response.data as JoinRiseResponse;

      const rawJobs = data?.result?.jobs ?? [];
      if (rawJobs.length === 0) {
        this.logger.log('No JoinRise jobs available');
        return new JobResponseDto([]);
      }

      this.logger.log(
        `JoinRise returned ${rawJobs.length} jobs (total: ${data?.result?.count ?? 'unknown'})`,
      );

      const jobs: JobPostDto[] = [];

      for (const raw of rawJobs) {
        if (jobs.length >= resultsWanted) break;

        try {
          if (input.searchTerm && !this.matchesSearch(raw, input.searchTerm)) {
            continue;
          }

          const job = this.mapJob(raw);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping JoinRise job ${raw._id}: ${err.message}`);
        }
      }

      this.logger.log(`JoinRise returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`JoinRise scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private matchesSearch(job: JoinRiseJob, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (job.title ?? '').toLowerCase();
    const summary = (job.descriptionBreakdown?.oneSentenceJobSummary ?? '').toLowerCase();
    const company = (job.owner?.companyName ?? '').toLowerCase();
    const keywords = (job.descriptionBreakdown?.keywords ?? []).join(' ').toLowerCase();
    return title.includes(term) || summary.includes(term) || company.includes(term) || keywords.includes(term);
  }

  private mapJob(raw: JoinRiseJob): JobPostDto | null {
    if (!raw.title || !raw.url) return null;

    const description = raw.descriptionBreakdown?.oneSentenceJobSummary ?? null;

    let compensation: CompensationDto | null = null;
    const minSalary = raw.descriptionBreakdown?.salaryRangeMinYearly;
    const maxSalary = raw.descriptionBreakdown?.salaryRangeMaxYearly;
    if (minSalary || maxSalary) {
      compensation = new CompensationDto({
        interval: CompensationInterval.YEARLY,
        minAmount: minSalary ?? null,
        maxAmount: maxSalary ?? null,
        currency: 'USD',
      });
    }

    const location = new LocationDto({
      city: raw.locationAddress ?? null,
    });

    let datePosted: string | null = null;
    if (raw.createdAt) {
      try {
        datePosted = toDateOnly(raw.createdAt);
      } catch {
        datePosted = null;
      }
    }

    const isRemote = raw.type === 'Remote' || raw.descriptionBreakdown?.workModel === 'Remote';

    return new JobPostDto({
      id: `joinrise-${raw._id}`,
      title: raw.title,
      companyName: raw.owner?.companyName ?? null,
      companyLogo: raw.owner?.photo ?? null,
      jobUrl: raw.url,
      location,
      description,
      compensation,
      datePosted,
      isRemote,
      emails: extractEmails(description),
      site: Site.JOINRISE,
    });
  }
}
