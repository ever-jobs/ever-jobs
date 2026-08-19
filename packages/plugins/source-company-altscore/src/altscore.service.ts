import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AltScore — B2B credit infrastructure and Lending-as-a-Service APIs for Latin America.
 *
 * AltScore is a business-to-business fintech providing credit and
 * lending infrastructure for Latin America. Its Lending-as-a-Service
 * platform exposes APIs for onboarding (KYC/KYB), underwriting, and
 * scoring that use alternative data, letting lenders, retailers, and
 * SaaS companies embed and deploy digital credit products. The company
 * was founded in Ecuador in 2021 and is headquartered in Mexico City,
 * with a remote-first team distributed across Latin America.
 *
 * Sector: Fintech (B2B lending infrastructure). HQ: Mexico City, Mexico.
 *
 * Highlights:
 *   - Lending-as-a-Service APIs covering onboarding, underwriting, and
 *     alternative-data scoring
 *   - Targets embedded credit for SMEs and underbanked segments across
 *     Latin America
 *   - Founded in Ecuador (2021), headquartered in Mexico City
 *   - Remote-first hiring concentrated in LATAM (Ecuador, Argentina,
 *     broader region)
 *   - Open roles span Engineering, Revenue, Demand Generation, and
 *     Customer Success
 *
 * Source profile (Spec 250):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/altscore/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AltScore'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 7 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/altscore/jobs';

@SourcePlugin({
  site: Site.ALTSCORE,
  name: 'AltScore',
  category: 'company',
})
@Injectable()
export class AltscoreService implements IScraper {
  private readonly logger = new Logger(AltscoreService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AltScore: fetching ${url}`);

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
        const id = `altscore-${jobId}`;

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
            site: Site.ALTSCORE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AltScore',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/altscore/jobs/${listing.id}`,
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

      this.logger.log(`AltScore: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AltScore scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
