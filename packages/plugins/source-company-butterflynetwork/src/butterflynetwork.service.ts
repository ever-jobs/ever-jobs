import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Butterfly Network — Digital health company making handheld, semiconductor-based point-of-care ultrasound devices and software.
 *
 * Butterfly Network is a digital health company that develops
 * portable, semiconductor-based ultrasound technology paired with
 * intuitive software. Its flagship products are handheld, single-probe
 * whole-body ultrasound systems built on a proprietary
 * Ultrasound-on-Chip platform, which connect to a smartphone or tablet
 * to bring imaging to the point of care. The company aims to make
 * medical imaging more affordable and accessible across hospitals,
 * clinics, and field settings worldwide.
 *
 * Sector: Medical Devices / Digital Health. HQ: Burlington, Massachusetts, USA.
 *
 * Highlights:
 *   - Maker of the Butterfly iQ line of handheld point-of-care
 *     ultrasound devices
 *   - Proprietary semiconductor (MEMS) Ultrasound-on-Chip technology
 *     replacing traditional piezoelectric probes
 *   - Single-probe, whole-body imaging across a 1-12 MHz frequency
 *     range
 *   - Publicly traded medical device company (NYSE: BFLY)
 *   - FDA-cleared devices used in bedside, clinic, and field care
 *     settings
 *
 * Source profile (Spec 742):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/butterflynetwork/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Butterfly Network'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 19 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/butterflynetwork/jobs';

@SourcePlugin({
  site: Site.BUTTERFLY_NETWORK,
  name: 'Butterfly Network',
  category: 'company',
})
@Injectable()
export class ButterflyNetworkService implements IScraper {
  private readonly logger = new Logger(ButterflyNetworkService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Butterfly Network: fetching ${url}`);

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
        const id = `butterflynetwork-${jobId}`;

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
            site: Site.BUTTERFLY_NETWORK,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Butterfly Network',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/butterflynetwork/jobs/${listing.id}`,
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

      this.logger.log(`Butterfly Network: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Butterfly Network scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
