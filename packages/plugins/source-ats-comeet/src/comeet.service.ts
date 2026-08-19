import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, stripHtmlTags } from '@ever-jobs/common';

@SourcePlugin({
  site: Site.COMEET,
  name: 'Comeet',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ComeetService implements IScraper {
  private readonly logger = new Logger(ComeetService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const company = input.companySlug;
    if (!company) {
      this.logger.warn('No companySlug provided for Comeet scraper');
      return new JobResponseDto([]);
    }

    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 100;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      // Comeet API: company-specific careers endpoint
      const url = `https://www.comeet.com/careers-api/2.0/company/${company}/positions?token=`;
      this.logger.log(`Comeet: fetching ${url}`);

      const { data } = await client.get<any[]>(url);
      const listings = Array.isArray(data) ? data : [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        const title = listing.name ?? '';
        if (!title) continue;

        const jobId = listing.uid ?? listing.id ?? '';
        const id = `comeet-${company}-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        jobs.push(
          new JobPostDto({
            id,
            site: Site.COMEET,
            title,
            companyName: listing.company_name ?? company,
            jobUrl: listing.url_active_page ?? listing.url ?? '',
            location,
            description: listing.details
              ? stripHtmlTags(listing.details.map((d: any) => d.value ?? '').join('\n'))
              : null,
            datePosted: listing.time_updated ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department: listing.department ?? null,
            atsId: jobId,
            atsType: 'comeet',
          }),
        );
      }

      this.logger.log(`Comeet: scraped ${jobs.length} jobs for ${company}`);
    } catch (err: any) {
      this.logger.error(`Comeet scrape failed for ${company}: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
