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
  JobType,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  HABRCAREER_API_URL,
  HABRCAREER_DEFAULT_RESULTS,
  HABRCAREER_HEADERS,
} from './habrcareer.constants';
import { HabrcareerVacancy, HabrcareerApiResponse } from './habrcareer.types';

/**
 * Map Habr Career currency codes to standard ISO currency codes.
 */
const CURRENCY_MAP: Record<string, string> = {
  rur: 'RUB',
  usd: 'USD',
  eur: 'EUR',
  kzt: 'KZT',
  uah: 'UAH',
  gbp: 'GBP',
};

/**
 * Map Habr Career employment type strings to JobType.
 */
const EMPLOYMENT_MAP: Record<string, JobType> = {
  full_time: JobType.FULL_TIME,
  part_time: JobType.PART_TIME,
  contract: JobType.CONTRACT,
  internship: JobType.INTERNSHIP,
  volunteer: JobType.VOLUNTEER,
};

@SourcePlugin({
  site: Site.HABRCAREER,
  name: 'HabrCareer',
  category: 'regional',
})
@Injectable()
export class HabrcareerService implements IScraper {
  private readonly logger = new Logger(HabrcareerService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? HABRCAREER_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(HABRCAREER_HEADERS);

    this.logger.log(
      `Fetching Habrcareer vacancies (resultsWanted=${resultsWanted})`,
    );

    try {
      let url = `${HABRCAREER_API_URL}?page=1&per_page=${resultsWanted}&type=all&sort=date`;

      if (input.searchTerm) {
        url += `&q=${encodeURIComponent(input.searchTerm)}`;
      }

      const response = await client.get(url);
      const data = response.data as HabrcareerApiResponse;

      const vacancies = data?.list ?? [];
      if (vacancies.length === 0) {
        this.logger.log('No vacancies returned from Habrcareer');
        return new JobResponseDto([]);
      }

      this.logger.log(
        `Habrcareer returned ${vacancies.length} vacancies (total: ${data?.meta?.totalResults ?? 'unknown'})`,
      );

      const jobs: JobPostDto[] = [];

      for (const raw of vacancies) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(raw, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping Habrcareer vacancy ${raw.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Habrcareer returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Habrcareer scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Map a Habr Career vacancy to a JobPostDto.
   */
  private mapJob(
    raw: HabrcareerVacancy,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!raw.title) return null;

    const jobUrl = raw.href
      ? `https://career.habr.com${raw.href}`
      : null;
    if (!jobUrl) return null;

    // Build description from divisions, skills, employment, and qualification
    const descParts: string[] = [];

    if (raw.divisions && raw.divisions.length > 0) {
      const divisionTitles = raw.divisions
        .map((d) => d.title)
        .filter(Boolean)
        .join(', ');
      if (divisionTitles) descParts.push(`Role: ${divisionTitles}`);
    }

    if (raw.skills && raw.skills.length > 0) {
      const skillTitles = raw.skills
        .map((s) => s.title)
        .filter(Boolean)
        .join(', ');
      if (skillTitles) descParts.push(`Skills: ${skillTitles}`);
    }

    if (raw.employment) {
      descParts.push(`Employment: ${raw.employment}`);
    }

    if (raw.salaryQualification?.title) {
      descParts.push(`Level: ${raw.salaryQualification.title}`);
    }

    let description: string | null =
      descParts.length > 0 ? descParts.join('\n') : null;

    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    // Build location from first locations entry
    const location = new LocationDto({
      city: raw.locations?.[0]?.title ?? null,
      country: null,
    });

    // Build compensation from salary
    let compensation: CompensationDto | null = null;
    if (raw.salary) {
      const hasFrom = raw.salary.from != null && raw.salary.from > 0;
      const hasTo = raw.salary.to != null && raw.salary.to > 0;
      if (hasFrom || hasTo) {
        const rawCurrency = (raw.salary.currency ?? 'rur').toLowerCase();
        compensation = new CompensationDto({
          interval: CompensationInterval.MONTHLY,
          minAmount: hasFrom ? raw.salary.from : null,
          maxAmount: hasTo ? raw.salary.to : null,
          currency: CURRENCY_MAP[rawCurrency] ?? rawCurrency.toUpperCase(),
        });
      }
    }

    // Parse date
    let datePosted: string | null = null;
    if (raw.publishedDate?.date) {
      try {
        datePosted = toDateOnly(raw.publishedDate.date);
      } catch {
        datePosted = null;
      }
    }

    // Map employment type to JobType
    let jobType: JobType[] | null = null;
    if (raw.employment) {
      const normalized = raw.employment.toLowerCase().replace(/[\s-]/g, '_');
      const mapped = EMPLOYMENT_MAP[normalized];
      if (mapped) {
        jobType = [mapped];
      }
    }

    return new JobPostDto({
      id: `habrcareer-${raw.id}`,
      title: raw.title,
      companyName: raw.company?.title ?? null,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      jobType,
      isRemote: raw.remoteWork ?? false,
      emails: extractEmails(description ?? null),
      site: Site.HABRCAREER,
    });
  }
}
