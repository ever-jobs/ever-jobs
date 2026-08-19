import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Suki AI — Suki AI builds an AI-powered voice assistant and ambient documentation platform that helps clinicians create clinical notes and complete administrative tasks during patient encounters..
 *
 * Suki AI is a healthcare technology company that develops an
 * AI-powered voice assistant for clinicians, with its flagship product
 * Suki Assistant generating clinical documentation through ambient and
 * dictated speech. The platform uses natural language processing and
 * machine learning to draft notes, surface patient information, and
 * reduce administrative burden, integrating with major electronic
 * health record systems. The company also offers Suki Platform,
 * allowing partners to embed its voice and AI capabilities into their
 * own software. Suki is headquartered in Redwood City, California,
 * with additional engineering operations in Bengaluru, India.
 *
 * Sector: HealthTech / Clinical AI. HQ: Redwood City, California, United States.
 *
 * Highlights:
 *   - Clinical AI voice assistant and ambient documentation for
 *     healthcare providers
 *   - Headquartered in Redwood City, California, with engineering in
 *     Bengaluru, India
 *   - Flagship product Suki Assistant generates clinical notes via NLP
 *     and machine learning
 *   - Integrates with major electronic health record (EHR) systems
 *   - Offers Suki Platform for partners to embed its voice AI
 *     capabilities
 *
 * Source profile (Spec 770):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/suki/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Suki AI'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 8 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/suki/jobs';

@SourcePlugin({
  site: Site.SUKI_AI,
  name: 'Suki AI',
  category: 'company',
})
@Injectable()
export class SukiAIService implements IScraper {
  private readonly logger = new Logger(SukiAIService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Suki AI: fetching ${url}`);

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
        const id = `suki-${jobId}`;

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
            site: Site.SUKI_AI,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Suki AI',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/suki/jobs/${listing.id}`,
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

      this.logger.log(`Suki AI: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Suki AI scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
