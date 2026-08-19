import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Dyno Therapeutics — AI-driven gene therapy company designing optimized adeno-associated virus (AAV) vectors for in vivo delivery..
 *
 * Dyno Therapeutics is a biotechnology company that applies artificial
 * intelligence and machine learning to the design of next-generation
 * gene therapy vectors. Its CapsidMap platform engineers novel
 * adeno-associated virus (AAV) capsids aimed at improving targeting,
 * immune evasion, manufacturing yield, and delivery to specific
 * tissues. The company develops these optimized capsids both
 * internally and through partnerships with pharmaceutical and gene
 * therapy developers. It is headquartered in Watertown, Massachusetts.
 *
 * Sector: Biotech / Gene Therapy. HQ: Watertown, Massachusetts, United States.
 *
 * Highlights:
 *   - Headquartered in Watertown, Massachusetts
 *   - Uses AI/ML to design optimized AAV capsids for gene therapy
 *   - CapsidMap platform engineers vectors for targeting, immune
 *     evasion, and manufacturability
 *   - Hiring across scientific roles including immune evasion and
 *     vector production
 *   - Partners with pharma and gene therapy developers on capsid
 *     delivery technology
 *
 * Source profile (Spec 776):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/dynotherapeutics/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Dyno Therapeutics'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 3 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/dynotherapeutics/jobs';

@SourcePlugin({
  site: Site.DYNO_THERAPEUTICS,
  name: 'Dyno Therapeutics',
  category: 'company',
})
@Injectable()
export class DynoTherapeuticsService implements IScraper {
  private readonly logger = new Logger(DynoTherapeuticsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Dyno Therapeutics: fetching ${url}`);

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
        const id = `dynotherapeutics-${jobId}`;

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
            site: Site.DYNO_THERAPEUTICS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Dyno Therapeutics',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/dynotherapeutics/jobs/${listing.id}`,
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

      this.logger.log(`Dyno Therapeutics: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Dyno Therapeutics scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
