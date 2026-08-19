import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AlphaGrep Securities — Quantitative proprietary trading and market-making firm running low-latency strategies across global exchanges..
 *
 * AlphaGrep Securities is a quantitative proprietary trading and
 * investment firm founded in 2009 and headquartered in Mumbai, India.
 * It develops and executes algorithmic trading strategies and acts as
 * a market maker across multiple asset classes on exchanges worldwide,
 * with an emphasis on low-latency systems, mathematics, and
 * statistics. The firm employs engineers, computer scientists,
 * mathematicians, statisticians, and physicists across offices in
 * Asia, Europe, and the Americas. Open roles span quantitative
 * research and trading, core engineering, systems and network
 * infrastructure, risk, and operations.
 *
 * Sector: Quantitative Trading / Financial Services. HQ: Mumbai, India.
 *
 * Highlights:
 *   - Quantitative proprietary trading and market making across
 *     multiple asset classes and global exchanges
 *   - Founded in 2009; headquartered in Mumbai with additional offices
 *     in India, Asia, Europe, and the Americas
 *   - Heavy focus on low-latency systems, algorithmic strategies, and
 *     quantitative research
 *   - Hiring across quant research & trading, core engineering,
 *     systems & network, risk, and operations
 *   - Locations in the hiring data include Mumbai, Bengaluru,
 *     Ahmedabad, and Shanghai
 *
 * Source profile (Spec 242):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/alphagrepsecurities/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AlphaGrep Securities'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 23 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alphagrepsecurities/jobs';

@SourcePlugin({
  site: Site.ALPHAGREPSECURITIES,
  name: 'AlphaGrep Securities',
  category: 'company',
})
@Injectable()
export class AlphagrepsecuritiesService implements IScraper {
  private readonly logger = new Logger(AlphagrepsecuritiesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AlphaGrep Securities: fetching ${url}`);

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
        const id = `alphagrepsecurities-${jobId}`;

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
            site: Site.ALPHAGREPSECURITIES,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AlphaGrep Securities',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alphagrepsecurities/jobs/${listing.id}`,
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

      this.logger.log(`AlphaGrep Securities: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AlphaGrep Securities scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
