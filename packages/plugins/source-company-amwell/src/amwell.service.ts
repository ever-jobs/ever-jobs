import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Amwell — Digital health company offering a telehealth platform for virtual care and behavioral health services..
 *
 * Amwell (American Well) is a US-based digital health company that
 * provides a telehealth platform connecting patients with clinicians
 * for virtual care, including urgent care, behavioral health, and
 * chronic condition management. Its technology is used by health
 * systems, health plans, and employers to deliver and coordinate care,
 * with offerings spanning a clinical services arm and a software
 * platform. Hiring signals show clinical roles such as Behavioural
 * Health Coaches alongside platform and product engineering, customer
 * support, and strategic account management positions.
 *
 * Sector: Digital Health / Telehealth. HQ: Boston, Massachusetts, USA.
 *
 * Highlights:
 *   - Operates a telehealth platform used by health systems, health
 *     plans, and employers
 *   - Behavioral health is an active service area, including
 *     Behavioural Health Coach roles
 *   - Engineering split across platform engineering and product
 *     (including clinical programs)
 *   - Hiring across US-remote, Ireland (Dublin), and Colombia
 *     locations
 *   - Includes a clinical services organization delivering virtual
 *     care alongside its software platform
 *
 * Source profile (Spec 265):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/amwell/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Amwell'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 19 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/amwell/jobs';

@SourcePlugin({
  site: Site.AMWELL,
  name: 'Amwell',
  category: 'company',
})
@Injectable()
export class AmwellService implements IScraper {
  private readonly logger = new Logger(AmwellService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Amwell: fetching ${url}`);

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
        const id = `amwell-${jobId}`;

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
            site: Site.AMWELL,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Amwell',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/amwell/jobs/${listing.id}`,
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

      this.logger.log(`Amwell: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Amwell scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
