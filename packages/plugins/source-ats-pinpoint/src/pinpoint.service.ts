import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, stripHtmlTags } from '@ever-jobs/common';

@SourcePlugin({
  site: Site.PINPOINT,
  name: 'Pinpoint',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PinpointService implements IScraper {
  private readonly logger = new Logger(PinpointService.name);

  private normalizeLocation(raw: any): LocationDto | null {
    if (raw == null) return null;

    if (typeof raw === 'string') {
      const city = raw.trim();
      return city ? new LocationDto({ city }) : null;
    }

    if (typeof raw === 'object') {
      const city = String(raw.name ?? raw.city ?? raw.province ?? '').trim();
      const state = String(raw.province ?? '').trim() || undefined;
      return city ? new LocationDto({ city, ...(state ? { state } : {}) }) : null;
    }

    return null;
  }

  private deriveIsRemote(attrs: any, locationText: string): boolean {
    if (typeof attrs.remote === 'boolean') return attrs.remote;

    const workplaceType = String(attrs.workplace_type ?? '').toLowerCase();
    if (workplaceType === 'remote') return true;

    if (locationText.toLowerCase().includes('remote')) return true;

    return false;
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const company = input.companySlug;
    if (!company) {
      this.logger.warn('No companySlug provided for Pinpoint scraper');
      return new JobResponseDto([]);
    }

    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 100;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      // Pinpoint provides a JSON API at each company's subdomain
      const url = `https://${company}.pinpointhq.com/postings.json`;
      this.logger.log(`Pinpoint: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.data ?? (Array.isArray(data) ? data : []);

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        const attrs = listing.attributes ?? listing;
        const title = attrs.title ?? '';
        if (!title) continue;

        const jobId = listing.id ?? attrs.id ?? '';
        const id = `pinpoint-${company}-${jobId}`;

        const location = this.normalizeLocation(attrs.location_name ?? attrs.location);
        const locationText = location?.city ?? '';

        jobs.push(
          new JobPostDto({
            id,
            site: Site.PINPOINT,
            title,
            companyName: attrs.company_name ?? company,
            jobUrl: attrs.url ?? `https://${company}.pinpointhq.com/postings/${jobId}`,
            location,
            description: attrs.description
              ? stripHtmlTags(attrs.description)
              : null,
            datePosted: attrs.published_at ?? attrs.created_at ?? null,
            isRemote: this.deriveIsRemote(attrs, locationText),
            department: attrs.department_name ?? attrs.department ?? null,
            atsId: String(jobId),
            atsType: 'pinpoint',
          }),
        );
      }

      this.logger.log(`Pinpoint: scraped ${jobs.length} jobs for ${company}`);
    } catch (err: any) {
      this.logger.error(`Pinpoint scrape failed for ${company}: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
