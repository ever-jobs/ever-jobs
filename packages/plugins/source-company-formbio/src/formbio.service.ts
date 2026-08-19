import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Form Bio — Form Bio is a computational life sciences company that builds a cloud platform combining bioinformatics tools, data management, and AI to accelerate cell and gene therapy research and development..
 *
 * Form Bio is a life sciences software company that provides a
 * cloud-based computational platform for scientists working in
 * genomics, bioinformatics, and genetic medicine. Its platform
 * integrates analysis pipelines, collaboration, data management, and
 * AI/ML tooling to support cell and gene therapy development,
 * including applications such as AAV vector characterization and
 * therapeutic candidate analysis. The company was founded out of
 * Colossal Biosciences and serves biotech and pharmaceutical research
 * teams. It operates with a presence in Texas and supports remote and
 * distributed teams.
 *
 * Sector: BioTech / Computational Life Sciences. HQ: Dallas, Texas, United States.
 *
 * Highlights:
 *   - Cloud platform for bioinformatics, genomics, and genetic
 *     medicine R&D
 *   - Focus on cell and gene therapy development workflows (including
 *     AAV analysis)
 *   - Integrates analysis pipelines, data management, collaboration,
 *     and AI/ML
 *   - Headquartered in Dallas, Texas, with distributed/remote teams
 *   - Originated from Colossal Biosciences
 *
 * Source profile (Spec 762):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/formbio/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Form Bio'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 3 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/formbio/jobs';

@SourcePlugin({
  site: Site.FORM_BIO,
  name: 'Form Bio',
  category: 'company',
})
@Injectable()
export class FormBioService implements IScraper {
  private readonly logger = new Logger(FormBioService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Form Bio: fetching ${url}`);

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
        const id = `formbio-${jobId}`;

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
            site: Site.FORM_BIO,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Form Bio',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/formbio/jobs/${listing.id}`,
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

      this.logger.log(`Form Bio: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Form Bio scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
