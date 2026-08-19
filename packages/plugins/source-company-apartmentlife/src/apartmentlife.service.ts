import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Apartment Life — Faith-based nonprofit building community in apartment complexes through on-site resident coordinators..
 *
 * Apartment Life is a faith-based nonprofit organization, founded in
 * 2000 and headquartered in the Dallas-Fort Worth area of Texas, that
 * partners with apartment property owners and local churches to build
 * community within multifamily housing. It places trained coordinators
 * into apartment communities to host events, welcome new residents,
 * and provide care, with the aim of improving resident retention and
 * satisfaction. Its programs span conventional, affordable, and
 * student housing, alongside concierge and neighborhood-focused
 * resident services.
 *
 * Sector: Nonprofit / Multifamily Residential Services. HQ: Bedford, Texas, United States.
 *
 * Highlights:
 *   - Faith-based nonprofit operating in multifamily apartment
 *     communities since 2000
 *   - Deploys on-site coordinators to host events and care for
 *     residents
 *   - Programs cover conventional, affordable/student housing, and
 *     concierge resident services
 *   - Roles span resident services, ministry coordination, and
 *     corporate growth
 *   - Hires across remote and multiple U.S. metro locations
 *
 * Source profile (Spec 278):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/apartmentlife/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Apartment Life'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 156 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/apartmentlife/jobs';

@SourcePlugin({
  site: Site.APARTMENTLIFE,
  name: 'Apartment Life',
  category: 'company',
})
@Injectable()
export class ApartmentlifeService implements IScraper {
  private readonly logger = new Logger(ApartmentlifeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Apartment Life: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: defensive trim of wire title padding.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (listing.departments?.[0]?.name ?? '')
            .toLowerCase()
            .includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `apartmentlife-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        // D-11: defensive trim of wire department padding.
        const deptRaw = listing.departments?.[0]?.name ?? null;
        const department = deptRaw ? deptRaw.trim() : null;

        jobs.push(
          new JobPostDto({
            id,
            site: Site.APARTMENTLIFE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Apartment Life',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/apartmentlife/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department,
          }),
        );
      }

      this.logger.log(`Apartment Life: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Apartment Life scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
