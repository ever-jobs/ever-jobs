import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Aisera — Enterprise AI platform for IT, customer service, and operations automation..
 *
 * Aisera is an enterprise software company that develops AI-driven
 * automation for IT service management, customer service, and
 * operations, including conversational AI and agentic assistants. Its
 * products handle service requests and support workflows across
 * functions such as IT, HR, and customer support. Hiring signals point
 * to a strong engineering and AI/ML focus, with roles in
 * conversational AI, applied ML, and AI operations alongside
 * customer-facing teams.
 *
 * Sector: Enterprise AI / IT and customer service automation software. HQ: Palo Alto, California, USA.
 *
 * Highlights:
 *   - Builds conversational and agentic AI for IT service management,
 *     customer service, and operations
 *   - Engineering and AI/ML hiring spans applied ML, conversational
 *     AI, and AI operations roles
 *   - International presence with engineering hiring in Hyderabad and
 *     Bangalore, India
 *   - Additional hiring activity in Athens, Greece
 *   - Customer-facing teams include Customer Success and Sales
 *     Engineering
 *
 * Source profile (Spec 219):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aiserajobs/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Aisera'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 5 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aiserajobs/jobs';

@SourcePlugin({
  site: Site.AISERAJOBS,
  name: 'Aisera',
  category: 'company',
})
@Injectable()
export class AiserajobsService implements IScraper {
  private readonly logger = new Logger(AiserajobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Aisera: fetching ${url}`);

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
        const id = `aiserajobs-${jobId}`;

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
            site: Site.AISERAJOBS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Aisera',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aiserajobs/jobs/${listing.id}`,
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

      this.logger.log(`Aisera: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Aisera scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
