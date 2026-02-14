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
import { RECRUITEE_HEADERS } from './recruitee.constants';
import { RecruiteeOffer, RecruiteeResponse } from './recruitee.types';

@Injectable()
export class RecruiteeService implements IScraper {
  private readonly logger = new Logger(RecruiteeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Recruitee scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(RECRUITEE_HEADERS);

    const url = `https://${encodeURIComponent(companySlug)}.recruitee.com/api/offers`;

    try {
      this.logger.log(`Fetching Recruitee jobs for company: ${companySlug}`);
      const response = await client.get(url);
      const data: RecruiteeResponse = response.data ?? { offers: [] };
      const offers = data.offers ?? [];

      this.logger.log(`Recruitee: found ${offers.length} raw jobs for ${companySlug}`);

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const offer of offers) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processOffer(offer, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing Recruitee offer ${offer.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Recruitee scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private processOffer(
    offer: RecruiteeOffer,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = offer.title;
    if (!title) return null;

    // Description is HTML
    let description: string | null = null;
    if (offer.description) {
      if (format === DescriptionFormat.HTML) {
        description = offer.description;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(offer.description) ?? offer.description;
      } else {
        description = htmlToPlainText(offer.description);
      }
    }

    // Location from city/state/country fields
    const location = new LocationDto({
      city: offer.city ?? null,
      state: offer.state ?? null,
      country: offer.country ?? null,
    });

    // Compensation from salary_min/salary_max
    const compensation = this.extractCompensation(offer);

    // Job URL from careers_url + slug
    const jobUrl = offer.careers_url && offer.slug
      ? `${offer.careers_url}/${offer.slug}`
      : `https://${companySlug}.recruitee.com/o/${offer.slug ?? offer.id}`;

    // Date posted
    const datePosted = offer.created_at
      ? new Date(offer.created_at).toISOString().split('T')[0]
      : null;

    return new JobPostDto({
      id: `recruitee-${offer.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      isRemote: offer.remote ?? false,
      emails: extractEmails(description),
      site: Site.RECRUITEE,
      // ATS-specific fields
      atsId: String(offer.id),
      atsType: 'recruitee',
      department: offer.department ?? null,
    });
  }

  /**
   * Extract compensation from Recruitee salary fields.
   * Skips if both salary_min and salary_max are null.
   */
  private extractCompensation(offer: RecruiteeOffer): CompensationDto | null {
    if (offer.salary_min == null && offer.salary_max == null) {
      return null;
    }

    return new CompensationDto({
      interval: CompensationInterval.YEARLY,
      minAmount: offer.salary_min ?? undefined,
      maxAmount: offer.salary_max ?? undefined,
      currency: offer.salary_currency ?? 'USD',
    });
  }
}
