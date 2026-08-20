import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  DescriptionFormat,
  Country,
  Site,
  getIndeedDomain,
} from '@ever-jobs/models';
import {
  createHttpClient,
  IndeedException,
  markdownConverter,
  plainConverter,
  extractEmails,
  randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import { INDEED_HEADERS, JOB_SEARCH_QUERY } from './indeed.constants';
import { getJobType, getCompensation, isJobRemote } from './indeed.utils';

@SourcePlugin({
  site: Site.INDEED,
  name: 'Indeed',
  category: 'job-board',
})
@Injectable()
export class IndeedService implements IScraper {
  private readonly logger = new Logger(IndeedService.name);
  private readonly delay = 5;
  private readonly bandDelay = 5;

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const client = createHttpClient(input);

    const country = input.country ?? Country.USA;
    const { subdomain, apiCountryCode } = getIndeedDomain(country);

    const headers = { ...INDEED_HEADERS, 'indeed-co': apiCountryCode };
    client.setHeaders(headers);

    const apiUrl = `https://apis.indeed.com/graphql`;

    const jobList: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const resultsWanted = input.resultsWanted ?? 15;
    let cursor: string | null = null;
    const seenIds = new Set<string>();

    while (jobList.length < resultsWanted) {
      this.logger.log(`Fetching Indeed jobs, cursor: ${cursor ?? 'initial'}`);

      try {
        const variables: any = {
          what: input.searchTerm ?? '',
          location: input.location ?? '',
          radius: input.distance ?? 50,
        };
        if (cursor) variables.cursor = cursor;
        if (input.hoursOld) variables.fromAge = String(Math.ceil(input.hoursOld / 24));

        const filters: any[] = [];
        if (input.jobType) filters.push({ name: 'jobtype', value: input.jobType });
        if (input.isRemote) filters.push({ name: 'remotejob', value: 'true' });
        if (filters.length > 0) variables.filters = filters;

        const response = await client.post(apiUrl, {
          query: JOB_SEARCH_QUERY,
          variables,
        });

        const data = response.data?.data?.jobSearch;
        if (!data) {
          this.logger.warn('No data in Indeed response');
          break;
        }

        cursor = data.pageInfo?.nextCursor ?? null;
        const results = data.results ?? [];

        if (results.length === 0) break;

        for (const result of results) {
          if (jobList.length >= resultsWanted) break;

          const job = result.job;
          if (!job) continue;

          const jobKey = job.key;
          if (seenIds.has(jobKey)) continue;
          seenIds.add(jobKey);

          try {
            const jobPost = this.processJob(job, subdomain, input.descriptionFormat);
            if (jobPost) {
              jobList.push(jobPost);
            }
          } catch (err: any) {
            this.logger.warn(`Error processing Indeed job ${jobKey}: ${err.message}`);
          }
        }

        if (!cursor) break;
        await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
      } catch (err: any) {
        this.logger.error(`Indeed scrape error: ${err.message}`);
        break;
        diagnostics = classifyScrapeError(err);
      }
    }

    return new JobResponseDto(jobList, diagnostics);
  }

  private processJob(job: any, subdomain: string, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const employer = job.employer ?? {};
    const companyName = employer.name ?? null;
    const companyUrl = employer.companyProfile?.pageUrl
      ? `https://${subdomain}.indeed.com${employer.companyProfile.pageUrl}`
      : null;
    const companyLogo = employer.companyProfile?.images?.squareLogoUrl ?? null;
    const bannerPhotoUrl = employer.companyProfile?.images?.bannerUrl ?? null;
    const companyDescription = employer.companyProfile?.description ?? null;
    const overview = employer.companyProfile?.overview ?? {};
    const companyIndustry = overview.industryName ?? null;
    const companyNumEmployees = overview.employeeCount?.toString() ?? null;
    const companyRevenue = overview.revenue ?? null;
    const companyAddresses = employer.companyProfile?.locations?.join(', ') ?? null;

    const loc = job.location ?? {};
    const location = new LocationDto({
      city: loc.city ?? null,
      state: loc.state ?? null,
      country: loc.country ?? null,
    });

    const rawDescription = job.description?.html ?? null;
    let description = rawDescription;
    if (description) {
      if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      } else if (format === DescriptionFormat.PLAIN) {
        description = plainConverter(description) ?? description;
      }
    }

    const attributes = job.attributes ?? [];
    const jobType = getJobType(attributes);
    const remote = isJobRemote(attributes);
    const comp = getCompensation(job.compensation);
    const compensation = comp
      ? new CompensationDto({
          interval: comp.interval ?? undefined,
          minAmount: comp.minAmount,
          maxAmount: comp.maxAmount,
          currency: comp.currency ?? 'USD',
        })
      : null;

    const datePosted = job.datePublished ?? job.dateOnSite ?? null;

    return new JobPostDto({
      id: `in-${job.key}`,
      title,
      companyName,
      companyUrl,
      jobUrl: `https://${subdomain}.indeed.com/viewjob?jk=${job.key}`,
      location,
      description,
      compensation,
      datePosted: datePosted ? toDateOnly(datePosted) : null,
      jobType,
      isRemote: remote,
      emails: extractEmails(description),
      companyIndustry,
      companyLogo,
      bannerPhotoUrl,
      companyDescription,
      companyNumEmployees,
      companyRevenue,
      companyAddresses,
      site: Site.INDEED,
    });
  }
}
