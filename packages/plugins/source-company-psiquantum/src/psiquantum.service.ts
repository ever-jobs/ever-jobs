import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * PsiQuantum — PsiQuantum is building a large-scale, fault-tolerant quantum computer based on silicon photonics.
 *
 * PsiQuantum is a quantum computing company developing a large-scale,
 * fault-tolerant quantum computer using a silicon photonics approach,
 * leveraging semiconductor manufacturing processes to produce photonic
 * quantum chips. Its work spans photonic device design, cryogenic
 * systems, and fabrication process engineering. The company operates
 * engineering facilities in Milpitas, California, among other
 * locations.
 *
 * Sector: Quantum computing. HQ: Palo Alto, California, United States.
 *
 * Highlights:
 *   - Pursues fault-tolerant quantum computing via a silicon photonics
 *     architecture
 *   - Hiring across optical packaging, fabrication process, and
 *     cryostat equipment engineering
 *   - Operates engineering and fab-focused roles in Milpitas,
 *     California
 *
 * Source profile (Spec 703):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/psiquantum/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'PsiQuantum'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 96 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/psiquantum/jobs';

@SourcePlugin({
  site: Site.PSIQUANTUM,
  name: 'PsiQuantum',
  category: 'company',
})
@Injectable()
export class PsiQuantumService implements IScraper {
  private readonly logger = new Logger(PsiQuantumService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`PsiQuantum: fetching ${url}`);

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
        const id = `psiquantum-${jobId}`;

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
            site: Site.PSIQUANTUM,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'PsiQuantum',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/psiquantum/jobs/${listing.id}`,
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

      this.logger.log(`PsiQuantum: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`PsiQuantum scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
