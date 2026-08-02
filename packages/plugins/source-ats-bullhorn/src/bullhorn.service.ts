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
import {
  BULLHORN_DEFAULT_FIELDS,
  BULLHORN_HEADERS,
} from './bullhorn.constants';
import { BullhornJobOrder, BullhornSearchResponse } from './bullhorn.types';

@SourcePlugin({
  site: Site.BULLHORN,
  name: 'Bullhorn',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class BullhornService implements IScraper {
  private readonly logger = new Logger(BullhornService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Bullhorn scraper');
      return new JobResponseDto([]);
    }

    // Parse companySlug as cls:corpToken (split on first colon)
    const colonIndex = companySlug.indexOf(':');
    if (colonIndex === -1) {
      this.logger.warn(
        `Invalid Bullhorn companySlug format: "${companySlug}". Expected "cls:corpToken" (e.g., "91:abc123def").`,
      );
      return new JobResponseDto([]);
    }

    const cls = companySlug.substring(0, colonIndex);
    const corpToken = companySlug.substring(colonIndex + 1);

    if (!cls || !corpToken) {
      this.logger.warn(
        `Invalid Bullhorn companySlug: cls="${cls}", corpToken="${corpToken}". Both parts are required.`,
      );
      return new JobResponseDto([]);
    }

    // Optionally override corpToken from per-request auth or env var
    const envCorpToken =
      input.auth?.bullhorn?.corpToken ?? process.env.BULLHORN_CORP_TOKEN;
    const effectiveCorpToken = envCorpToken ?? corpToken;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(BULLHORN_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const url = `https://public-rest${encodeURIComponent(cls)}.bullhornstaffing.com/rest-services/${encodeURIComponent(effectiveCorpToken)}/search/JobOrder`;

    try {
      this.logger.log(
        `Fetching Bullhorn jobs for cls=${cls}, corpToken=${effectiveCorpToken.substring(0, 6)}...`,
      );

      const response = await client.get(url, {
        params: {
          query: '(isOpen:1)',
          fields: BULLHORN_DEFAULT_FIELDS,
          count: resultsWanted,
          start: 0,
        },
      });

      const data: BullhornSearchResponse = response.data ?? {
        data: [],
        total: 0,
        count: 0,
      };
      const jobOrders = data.data ?? [];

      this.logger.log(
        `Bullhorn: found ${jobOrders.length} raw jobs (total: ${data.total ?? 0})`,
      );

      const jobPosts: JobPostDto[] = [];

      for (const order of jobOrders) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJobOrder(
            order,
            cls,
            effectiveCorpToken,
            input.descriptionFormat,
          );
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error processing Bullhorn JobOrder ${order.id}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(
        `Bullhorn scrape error for cls=${cls}: ${err.message}`,
      );
      return new JobResponseDto([]);
    }
  }

  private processJobOrder(
    order: BullhornJobOrder,
    cls: string,
    corpToken: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = order.title;
    if (!title) return null;

    // Description — publicDescription is HTML
    let description: string | null = null;
    if (order.publicDescription) {
      if (format === DescriptionFormat.HTML) {
        description = order.publicDescription;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description =
          markdownConverter(order.publicDescription) ??
          order.publicDescription;
      } else {
        description = htmlToPlainText(order.publicDescription);
      }
    }

    // Location from address object
    const address = order.address;
    const location = new LocationDto({
      city: address?.city ?? null,
      state: address?.state ?? null,
      country: address?.country ?? null,
    });

    // Compensation from salary + salaryUnit
    const compensation = this.extractCompensation(order);

    // Employment type mapping
    const employmentType = order.employmentType ?? null;

    // Categories (first category name as department)
    const categories = order.categories?.data ?? [];
    const department =
      categories.length > 0 ? categories[0].name : null;

    // Date posted — dateAdded is epoch milliseconds
    const datePosted = order.dateAdded
      ? toDateOnly(order.dateAdded)
      : null;

    // Job URL — Bullhorn does not expose a public careers page URL;
    // construct a reference URL using the REST API pattern
    const jobUrl = `https://public-rest${cls}.bullhornstaffing.com/rest-services/${corpToken}/entity/JobOrder/${order.id}`;

    return new JobPostDto({
      id: `bullhorn-${order.id}`,
      title,
      companyName: corpToken,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      employmentType,
      emails: extractEmails(description),
      site: Site.BULLHORN,
      // ATS-specific fields
      atsId: String(order.id),
      atsType: 'bullhorn',
      department,
    });
  }

  /**
   * Extract compensation from Bullhorn salary and salaryUnit fields.
   * Skips if salary is null or zero.
   */
  private extractCompensation(
    order: BullhornJobOrder,
  ): CompensationDto | null {
    if (order.salary == null || order.salary === 0) {
      return null;
    }

    const interval = this.mapSalaryUnit(order.salaryUnit);

    return new CompensationDto({
      interval,
      minAmount: order.salary,
      maxAmount: undefined,
      currency: 'USD',
    });
  }

  /**
   * Map Bullhorn salaryUnit string to CompensationInterval.
   * Common Bullhorn values: "Per Year", "Per Hour", "Per Month", "Per Week", "Per Day".
   */
  private mapSalaryUnit(
    salaryUnit: string | null,
  ): CompensationInterval {
    if (!salaryUnit) return CompensationInterval.YEARLY;

    const unit = salaryUnit.toLowerCase();
    if (unit.includes('hour')) return CompensationInterval.HOURLY;
    if (unit.includes('day')) return CompensationInterval.DAILY;
    if (unit.includes('week')) return CompensationInterval.WEEKLY;
    if (unit.includes('month')) return CompensationInterval.MONTHLY;
    return CompensationInterval.YEARLY;
  }
}
