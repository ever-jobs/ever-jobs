import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Absci — Absci is a clinical-stage biotechnology company that uses generative AI and a synthetic-biology platform to design and create new antibody therapeutics..
 *
 * Absci is a generative AI drug-creation company that integrates deep
 * learning with scalable wet-lab synthetic biology to design and test
 * antibody therapeutics. Its Integrated Drug Creation platform aims to
 * predict and generate novel antibody candidates and optimize them for
 * properties such as affinity and developability. The company advances
 * its own pipeline of drug programs while also partnering with
 * pharmaceutical and biotech organizations. Absci is publicly traded
 * on the Nasdaq under the ticker ABSI.
 *
 * Sector: BioTech / AI Drug Discovery. HQ: Vancouver, Washington, United States.
 *
 * Highlights:
 *   - Clinical-stage AI biotech focused on antibody drug creation
 *   - Headquartered in Vancouver, Washington, USA
 *   - Integrated Drug Creation platform combining generative AI and
 *     synthetic biology
 *   - Publicly traded on Nasdaq (ABSI)
 *   - Develops internal pipeline plus pharma partnership programs
 *
 * Source profile (Spec 756):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/absci/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Absci'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 3 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/absci/jobs';

@SourcePlugin({
  site: Site.ABSCI,
  name: 'Absci',
  category: 'company',
})
@Injectable()
export class AbsciService implements IScraper {
  private readonly logger = new Logger(AbsciService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Absci: fetching ${url}`);

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
        const id = `absci-${jobId}`;

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
            site: Site.ABSCI,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Absci',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/absci/jobs/${listing.id}`,
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

      this.logger.log(`Absci: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Absci scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
