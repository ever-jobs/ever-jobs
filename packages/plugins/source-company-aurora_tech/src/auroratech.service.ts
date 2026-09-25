import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  CompensationDto,
  DescriptionFormat,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
  getCompensationInterval,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  aggregateCompensation,
  createHttpClient,
  extractEmails,
  htmlToPlainText,
  parseLocationList,
  resolveCompensation,
  toDateOnly,
} from '@ever-jobs/common';
import {
  ASHBY_API_URL,
  ASHBY_INCLUDE_COMPENSATION_QUERY,
  AURORA_BOARD_SLUG,
  AURORA_COMPANY_NAME,
  AURORA_COMPANY_URL,
} from './auroratech.constants';
import {
  AuroraCompensation,
  AuroraJob,
  AuroraResponse,
  AuroraCompensationTier,
  AuroraFlatCompensationComponent,
} from './auroratech.types';

/**
 * Aurora — Aurora (Aurora Innovation, Inc., NASDAQ: AUR) is a self-driving
 * vehicle technology company headquartered in Pittsburgh, Pennsylvania. Its
 * live careers board is hosted on Ashby under the slug `aurora-operations-inc`.
 *
 * This plugin provides a stable `Site.AURORA_TECH` token for `aurora.tech`
 * while delegating to the Ashby public job-board API.
 */
@SourcePlugin({
  site: Site.AURORA_TECH,
  name: 'Aurora',
  category: 'company',
  companyDomains: ['aurora.tech'],
})
@Injectable()
export class AuroraTechService implements IScraper {
  private readonly logger = new Logger(AuroraTechService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const boardSlug = input.companySlug?.trim() || AURORA_BOARD_SLUG;
    const resultsWanted = input.resultsWanted ?? 15;
    const offset = input.offset ?? 0;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        timeout: input.requestTimeout,
      });
      client.setHeaders({
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
      });

      const url = this.buildBoardUrl(boardSlug);
      this.logger.log(`Aurora: fetching ${url}`);

      const { data } = await client.get<AuroraResponse>(url);
      const listings = data?.jobs ?? [];
      let skipped = 0;

      for (const job of listings) {
        if (jobs.length >= resultsWanted) break;
        if (job.isListed === false) continue;

        try {
          const post = this.processJob(job, boardSlug, input.descriptionFormat);
          if (!post) continue;

          if (input.searchTerm && !this.matchesSearchTerm(post, input.searchTerm)) {
            continue;
          }
          if (input.location && !this.matchesLocation(post, input.location)) {
            continue;
          }
          if (input.isRemote && !post.isRemote) continue;
          if (input.jobType && !post.jobType?.includes(input.jobType)) continue;

          if (skipped < offset) {
            skipped++;
            continue;
          }

          jobs.push(post);
        } catch (err: any) {
          this.logger.warn(`Aurora: failed to process job ${job.id}: ${err.message}`);
        }
      }

      this.logger.log(`Aurora: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Aurora scrape failed: ${err.message}`);
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }

  private buildBoardUrl(boardSlug: string): string {
    return `${ASHBY_API_URL}/${encodeURIComponent(boardSlug)}?${ASHBY_INCLUDE_COMPENSATION_QUERY}`;
  }

  private processJob(
    job: AuroraJob,
    boardSlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = (job.title ?? '').trim();
    if (!title) return null;

    let description: string | null = null;
    if (format === DescriptionFormat.HTML && job.descriptionHtml) {
      description = job.descriptionHtml;
    } else if (job.descriptionPlain) {
      description = job.descriptionPlain;
    } else if (job.descriptionHtml) {
      description = htmlToPlainText(job.descriptionHtml);
    }

    const parsedLocations = parseLocationList(this.locationLabels(job));

    const isRemote =
      job.workplaceType?.toLowerCase() === 'remote' ||
      (job.workplaceType == null && Boolean(job.isRemote)) ||
      parsedLocations.remoteMentioned;

    const workFromHomeType = this.mergeWorkFromHomeType(
      parsedLocations.workFromHomeType,
      this.workFromHomeTypeFromWorkplace(job.workplaceType),
    );

    const salaryText =
      job.descriptionPlain ??
      (job.descriptionHtml ? htmlToPlainText(job.descriptionHtml) : null);
    const compensation = resolveCompensation({
      structured: this.extractCompensation(job),
      text: salaryText,
    });

    const datePosted = toDateOnly(job.publishedAt ?? job.publishedDate) ?? null;
    const jobType = this.resolveJobType(job.employmentType);

    return new JobPostDto({
      id: `aurora_tech-${job.id}`,
      title,
      companyName: AURORA_COMPANY_NAME,
      companyUrl: AURORA_COMPANY_URL,
      jobUrl:
        job.jobUrl ??
        `https://jobs.ashbyhq.com/${encodeURIComponent(boardSlug)}/${job.id}`,
      location: parsedLocations.location,
      ...(parsedLocations.locations.length > 0
        ? { locations: parsedLocations.locations }
        : {}),
      description,
      compensation,
      datePosted,
      isRemote,
      workFromHomeType,
      emails: extractEmails(description),
      site: Site.AURORA_TECH,
      atsId: job.id ?? null,
      atsType: 'ashby',
      department: job.department ?? job.departmentName ?? null,
      team: job.team ?? job.teamName ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? null,
      jobType: jobType ? [jobType] : null,
    });
  }

  private locationLabels(job: AuroraJob): string[] {
    const labels: string[] = [];

    const primaryAddress = this.postalAddressLabel(job.address);
    if (primaryAddress) {
      labels.push(primaryAddress);
    } else if (job.location) {
      labels.push(job.location);
    }

    for (const secondary of job.secondaryLocations ?? []) {
      const secondaryAddress = this.postalAddressLabel(secondary?.address);
      if (secondaryAddress) {
        labels.push(secondaryAddress);
      } else if (secondary?.location) {
        labels.push(secondary.location);
      }
    }

    return labels;
  }

  private postalAddressLabel(
    address: AuroraJob['address'],
  ): string | null {
    const postal = address?.postalAddress;
    if (!postal) return null;
    const parts = [
      postal.addressLocality,
      postal.addressRegion,
      postal.addressCountry,
    ].filter((part): part is string => Boolean(part?.trim()));
    return parts.length > 0 ? parts.join(', ') : null;
  }

  private workFromHomeTypeFromWorkplace(
    workplaceType: string | null | undefined,
  ): string | null {
    switch (workplaceType?.toLowerCase()) {
      case 'hybrid':
        return 'Hybrid';
      case 'remote':
        return 'Remote';
      default:
        return null;
    }
  }

  private mergeWorkFromHomeType(
    a: string | null,
    b: string | null,
  ): string | null {
    if (!a) return b;
    if (!b || a === b) return a;
    return 'Hybrid or Remote';
  }

  private resolveJobType(employmentType: string | null | undefined): JobType | null {
    if (!employmentType) return null;
    return getJobTypeFromString(employmentType);
  }

  private matchesSearchTerm(post: JobPostDto, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    return (
      post.title?.toLowerCase().includes(term) ||
      post.department?.toLowerCase().includes(term) ||
      false
    );
  }

  private matchesLocation(post: JobPostDto, location: string): boolean {
    const term = location.toLowerCase();
    const parts = [post.location?.city, post.location?.state, post.location?.country]
      .filter((p): p is string => Boolean(p))
      .join(', ')
      .toLowerCase();
    return parts.includes(term);
  }

  /**
   * Extract compensation from an Ashby payload. Supports the public job-board
   * flat shape (`summaryComponents[]` and `compensationTiers[].components[]`).
   */
  private extractCompensation(job: AuroraJob): CompensationDto | null {
    const comp: AuroraCompensation | undefined = job.compensation;
    if (!comp) return null;

    const candidates: AuroraFlatCompensationComponent[] = [
      ...(comp.summaryComponents ?? []),
      ...(comp.compensationTiers ?? []).flatMap((t) => t.components ?? []),
    ].filter((c) => c.minValue != null || c.maxValue != null);

    if (candidates.length === 0) return null;

    const salaryComponent =
      candidates.find(
        (c) =>
          c.compensationType?.toLowerCase().includes('salary') ||
          c.compensationType?.toLowerCase() === 'base',
      ) ?? candidates[0];

    const salaryBands = candidates.filter(
      (c) =>
        (c.compensationType ?? null) ===
        (salaryComponent.compensationType ?? null),
    );

    return aggregateCompensation(
      salaryBands.map((c) => ({
        minAmount: c.minValue,
        maxAmount: c.maxValue,
        currency: c.currencyCode ?? 'USD',
        interval: getCompensationInterval(c.interval ?? ''),
      })),
    );
  }
}
