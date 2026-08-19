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
  getCompensationInterval,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { FOUNTAIN_API_URL, FOUNTAIN_HEADERS } from './fountain.constants';
import { FountainOpening, FountainResponse } from './fountain.types';

/**
 * Fountain ATS scraper.
 *
 * Fountain is a high-volume hourly hiring platform used by 300+ enterprise
 * companies (Uber, Amazon, etc.) for frontline and hourly hiring.
 *
 * API: GET https://api.fountain.com/v2/openings
 * Auth: Bearer token (required)
 */
@SourcePlugin({
  site: Site.FOUNTAIN,
  name: 'Fountain',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class FountainService implements IScraper {
  private readonly logger = new Logger(FountainService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    // Resolve API key: per-request auth overrides env var
    const apiKey =
      input.auth?.fountain?.apiKey ?? process.env.FOUNTAIN_API_KEY;

    if (!apiKey) {
      this.logger.warn(
        'No Fountain API key provided (set FOUNTAIN_API_KEY env var or pass via auth.fountain.apiKey)',
      );
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(FOUNTAIN_HEADERS);

    try {
      this.logger.log('Fetching Fountain openings');

      const response = await client.get(FOUNTAIN_API_URL, {
        headers: {
          ...FOUNTAIN_HEADERS,
          Authorization: `Bearer ${apiKey}`,
        },
      });

      const data: FountainResponse = response.data ?? { openings: [] };
      const openings = data.openings ?? [];

      this.logger.log(`Fountain: found ${openings.length} raw openings`);

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const opening of openings) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processOpening(opening, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error processing Fountain opening ${opening.id}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Fountain scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private processOpening(
    opening: FountainOpening,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = opening.title;
    if (!title) return null;

    // Description: Fountain may return HTML or plain text descriptions
    let description: string | null = null;
    if (opening.description) {
      if (format === DescriptionFormat.HTML) {
        description = opening.description;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(opening.description) ?? opening.description;
      } else {
        description = htmlToPlainText(opening.description);
      }
    }

    // Location: prefer structured location object, fall back to location_string
    const loc = opening.location;
    const location = new LocationDto({
      city: loc?.city ?? opening.location_string ?? null,
      state: loc?.state ?? null,
      country: loc?.country ?? null,
    });

    // Compensation
    const compensation = this.extractCompensation(opening);

    // Job URL: prefer url, then apply_url
    const jobUrl = opening.url ?? opening.apply_url ?? '';

    // Date posted
    const datePosted = opening.created_at
      ? toDateOnly(opening.created_at)
      : null;

    return new JobPostDto({
      id: `fountain-${opening.id}`,
      title,
      companyName: null,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      isRemote: opening.is_remote ?? false,
      emails: extractEmails(description),
      site: Site.FOUNTAIN,
      // ATS-specific fields
      atsId: opening.id ?? null,
      atsType: 'fountain',
      department: opening.department ?? null,
      team: opening.team ?? null,
      employmentType: opening.employment_type ?? opening.type ?? null,
      applyUrl: opening.apply_url ?? null,
    });
  }

  /**
   * Extract compensation from Fountain opening fields.
   * Returns null if no salary data is present.
   */
  private extractCompensation(opening: FountainOpening): CompensationDto | null {
    const comp = opening.compensation;
    if (!comp) return null;

    if (comp.min_amount == null && comp.max_amount == null) {
      return null;
    }

    // Resolve interval from Fountain's interval string
    const rawInterval = comp.interval?.toLowerCase() ?? '';
    const interval = getCompensationInterval(rawInterval);

    return new CompensationDto({
      interval: interval ?? CompensationInterval.HOURLY,
      minAmount: comp.min_amount ?? undefined,
      maxAmount: comp.max_amount ?? undefined,
      currency: comp.currency ?? 'USD',
    });
  }
}
