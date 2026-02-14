import { Injectable, Logger } from '@nestjs/common';
import {
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
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
} from '@ever-jobs/common';
import { HIMALAYAS_API_URL, HIMALAYAS_HEADERS, HIMALAYAS_PAGE_SIZE } from './himalayas.constants';
import { HimalayasJob, HimalayasApiResponse } from './himalayas.types';

@Injectable()
export class HimalayasService implements IScraper {
  private readonly logger = new Logger(HimalayasService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 15;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(HIMALAYAS_HEADERS);

    const jobs: JobPostDto[] = [];
    const seenIds = new Set<string>();
    let offset = input.offset ?? 0;

    while (jobs.length < resultsWanted) {
      const limit = Math.min(HIMALAYAS_PAGE_SIZE, resultsWanted - jobs.length);

      this.logger.log(`Fetching Himalayas jobs (offset=${offset}, limit=${limit})`);

      try {
        const response = await client.get<HimalayasApiResponse>(HIMALAYAS_API_URL, {
          params: { limit, offset },
        });

        const rawJobs = response.data?.jobs ?? [];
        if (rawJobs.length === 0) {
          this.logger.log('No more Himalayas jobs available');
          break;
        }

        this.logger.log(`Himalayas returned ${rawJobs.length} jobs (total available: ${response.data?.totalCount ?? 'unknown'})`);

        for (const raw of rawJobs) {
          if (jobs.length >= resultsWanted) break;

          const jobId = `himalayas-${raw.guid}`;
          if (seenIds.has(jobId)) continue;
          seenIds.add(jobId);

          try {
            const job = this.mapJob(raw, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(`Error mapping Himalayas job ${raw.guid}: ${err.message}`);
          }
        }

        offset += rawJobs.length;

        // Stop if we got fewer results than requested (last page)
        if (rawJobs.length < limit) break;
      } catch (err: any) {
        this.logger.error(`Himalayas scrape error: ${err.message}`);
        break;
      }
    }

    return new JobResponseDto(jobs);
  }

  private mapJob(raw: HimalayasJob, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!raw.title || !raw.applicationLink) return null;

    // Process description (Himalayas returns HTML)
    let description: string | null = raw.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build compensation
    let compensation: CompensationDto | null = null;
    const hasMin = raw.minSalary != null && raw.minSalary !== 0;
    const hasMax = raw.maxSalary != null && raw.maxSalary !== 0;
    if (hasMin || hasMax) {
      compensation = new CompensationDto({
        interval: CompensationInterval.YEARLY,
        minAmount: raw.minSalary ?? null,
        maxAmount: raw.maxSalary ?? null,
        currency: raw.currency ?? 'USD',
      });
    }

    // Build location from first location restriction
    const location = new LocationDto({
      country: raw.locationRestrictions?.[0] ?? null,
    });

    // Parse date from Unix timestamp (seconds)
    let datePosted: string | null = null;
    if (raw.pubDate) {
      try {
        datePosted = new Date(raw.pubDate * 1000).toISOString().split('T')[0];
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `himalayas-${raw.guid}`,
      title: raw.title,
      companyName: raw.companyName ?? null,
      companyLogo: raw.companyLogo ?? null,
      jobUrl: raw.applicationLink,
      applyUrl: raw.applicationLink,
      location,
      description,
      compensation,
      datePosted,
      isRemote: true,
      employmentType: raw.employmentType ?? null,
      jobLevel: raw.seniority?.join(', ') ?? null,
      emails: extractEmails(description),
      site: Site.HIMALAYAS,
    });
  }
}
