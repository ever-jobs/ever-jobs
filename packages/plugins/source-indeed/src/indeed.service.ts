import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  ScrapeDiagnostics,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
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
  postedFromTimestamp,
  postedTimeFields,
} from '@ever-jobs/common';
import {
  INDEED_HEADERS,
  JOB_SEARCH_QUERY,
  IndeedMappingOptions,
  readIndeedMappingOptions,
  readIndeedMaxPages,
} from './indeed.constants';
import { buildLocation, detectWorkplace, getJobType, getCompensation } from './indeed.utils';
import {
  diagnoseGraphqlErrors,
  diagnoseHttpError,
  diagnoseMissingJobSearch,
} from './indeed.diagnostics';

const MAX_DIAGNOSTIC_DETAIL = 300;

/**
 * The job's posting value: `datePublished` (an epoch timestamp, so the instant
 * is exact), else `dateOnSite`. An empty or zero value counts as absent, as it
 * did when the value went through a truthiness check.
 */
function postedValue(job: { datePublished?: unknown; dateOnSite?: unknown }): unknown {
  for (const value of [job.datePublished, job.dateOnSite]) {
    if (value === null || value === undefined || value === '' || value === 0) continue;
    return value;
  }
  return null;
}

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

    // Spec 1702 switches, read per scrape (see indeed.constants.ts).
    const mapping = readIndeedMappingOptions();
    const maxPages = readIndeedMaxPages();

    const jobList: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    // GraphQL errors that arrived next to usable data: reported only when no job results.
    let dataErrorDiagnostics: ScrapeDiagnostics | undefined;
    const resultsWanted = input.resultsWanted ?? 15;
    let cursor: string | null = null;
    const seenIds = new Set<string>();
    let pages = 0;

    while (jobList.length < resultsWanted) {
      pages += 1;
      this.logger.log(`Fetching Indeed jobs, page ${pages}, cursor: ${cursor ?? 'initial'}`);

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

        const fetchedAt = Date.now();
        const body = response.data;

        const data = body?.data?.jobSearch;
        if (!data) {
          // A block page, a GraphQL error envelope or an empty body: never a silent empty.
          diagnostics = diagnoseMissingJobSearch(body);
          this.logger.warn(
            `No data in Indeed response: ${diagnostics.reason}${diagnostics.detail ? ` - ${diagnostics.detail}` : ''}`,
          );
          break;
        }

        const dataErrors = diagnoseGraphqlErrors(body);
        if (dataErrors) {
          dataErrorDiagnostics = dataErrorDiagnostics ?? dataErrors;
          this.logger.warn(`Indeed response carried GraphQL errors next to data: ${dataErrors.detail}`);
        }

        cursor = data.pageInfo?.nextCursor ?? null;
        const results = data.results ?? [];

        if (results.length === 0) break;

        let attempted = 0;
        let failed = 0;
        let firstFailure: string | null = null;
        for (const result of results) {
          if (jobList.length >= resultsWanted) break;

          const job = result?.job;
          if (!job) continue;

          const jobKey = job.key;
          if (seenIds.has(jobKey)) continue;
          seenIds.add(jobKey);
          attempted += 1;

          try {
            const jobPost = this.processJob(job, subdomain, input.descriptionFormat, mapping, fetchedAt);
            if (jobPost) {
              jobList.push(jobPost);
            }
          } catch (err: any) {
            failed += 1;
            firstFailure = firstFailure ?? String(err?.message ?? err);
            this.logger.warn(`Error processing Indeed job ${jobKey}: ${err?.message ?? err}`);
          }
        }

        if (attempted > 0 && failed === attempted && !diagnostics) {
          // Every job on the page failed to map: the response shape has changed.
          diagnostics = new ScrapeDiagnostics(
            'unknown',
            `every job on page ${pages} failed to map: ${firstFailure}`.slice(0, MAX_DIAGNOSTIC_DETAIL),
          );
        }

        // Sleep only when another page will actually be fetched.
        if (!cursor || jobList.length >= resultsWanted) break;
        if (maxPages > 0 && pages >= maxPages) {
          this.logger.log(
            `Indeed page cap reached (${maxPages} pages): returning ${jobList.length} of ${resultsWanted} wanted`,
          );
          break;
        }
        await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
      } catch (err: any) {
        diagnostics = diagnoseHttpError(err);
        this.logger.error(`Indeed scrape error: ${diagnostics.detail ?? err?.message ?? err}`);
        break;
      }
    }

    if (!diagnostics && jobList.length === 0 && dataErrorDiagnostics) {
      diagnostics = dataErrorDiagnostics;
    }

    return new JobResponseDto(jobList, diagnostics);
  }

  private processJob(
    job: any,
    subdomain: string,
    format?: DescriptionFormat,
    mapping: IndeedMappingOptions = {},
    fetchedAt: number = Date.now(),
  ): JobPostDto | null {
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

    const location = buildLocation(job.location, mapping);

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
    const jobType = getJobType(attributes, mapping);
    const workplace = detectWorkplace(job, mapping);
    const comp = getCompensation(job.compensation);
    const compensation = comp
      ? new CompensationDto({
          interval: comp.interval ?? undefined,
          minAmount: comp.minAmount,
          maxAmount: comp.maxAmount,
          currency: comp.currency ?? 'USD',
        })
      : null;

    // Spec 1696: `datePublished` is an epoch timestamp, so keep the exact
    // instant next to the date. A numeric string no longer becomes null.
    const posted = postedFromTimestamp(postedValue(job), fetchedAt);

    return new JobPostDto({
      id: `in-${job.key}`,
      title,
      companyName,
      companyUrl,
      jobUrl: `https://${subdomain}.indeed.com/viewjob?jk=${job.key}`,
      location,
      description,
      compensation,
      ...postedTimeFields(posted),
      jobType,
      isRemote: workplace.isRemote,
      ...(workplace.workFromHomeType ? { workFromHomeType: workplace.workFromHomeType } : {}),
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
