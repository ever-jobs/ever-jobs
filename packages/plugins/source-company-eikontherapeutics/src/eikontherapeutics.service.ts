import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Eikon Therapeutics — Biopharmaceutical company developing precision medicines for cancer and other diseases using live-cell, single-molecule imaging drug discovery..
 *
 * Eikon Therapeutics is a clinical-stage biopharmaceutical company
 * applying a proprietary, super-resolution live-cell imaging platform
 * to observe individual proteins in motion and discover novel
 * small-molecule medicines. The platform was developed from Nobel
 * Prize-winning microscopy research and is used to identify drug
 * candidates against previously intractable targets. Eikon's pipeline
 * focuses on oncology, with additional interest in neurological and
 * immune-related diseases. The company operates research and clinical
 * sites including its Bay Area headquarters and a New Jersey location.
 *
 * Sector: Biotechnology / Drug Discovery. HQ: Millbrae, California, USA.
 *
 * Highlights:
 *   - Uses super-resolution live-cell, single-molecule imaging to
 *     drive drug discovery
 *   - Clinical-stage pipeline centered on oncology and precision
 *     medicine
 *   - Headquartered in Millbrae, California with a Jersey City, NJ
 *     site
 *   - Platform rooted in Nobel Prize-winning microscopy technology
 *   - Develops small-molecule therapeutics against historically
 *     difficult targets
 *
 * Source profile (Spec 777):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/eikontherapeutics/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Eikon Therapeutics'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 21 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/eikontherapeutics/jobs';

@SourcePlugin({
  site: Site.EIKON_THERAPEUTICS,
  name: 'Eikon Therapeutics',
  category: 'company',
})
@Injectable()
export class EikonTherapeuticsService implements IScraper {
  private readonly logger = new Logger(EikonTherapeuticsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Eikon Therapeutics: fetching ${url}`);

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
        const id = `eikontherapeutics-${jobId}`;

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
            site: Site.EIKON_THERAPEUTICS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Eikon Therapeutics',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/eikontherapeutics/jobs/${listing.id}`,
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

      this.logger.log(`Eikon Therapeutics: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Eikon Therapeutics scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
