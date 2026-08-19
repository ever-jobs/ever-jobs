import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Incode Technologies — AI-powered identity verification and authentication platform.
 *
 * Incode Technologies is an enterprise identity company that provides
 * an AI-driven platform for identity verification, biometric
 * authentication, and fraud prevention across onboarding,
 * authentication, and KYC/AML compliance use cases. Founded in 2015
 * and headquartered in San Francisco, it serves customers in financial
 * services, government, and other regulated industries worldwide. The
 * company has expanded through acquisitions, including MetaMap (2024)
 * and AuthenticID (2025).
 *
 * Sector: Identity & Fraud. HQ: San Francisco, United States.
 *
 * Highlights:
 *   - Founded in 2015; headquartered in San Francisco with operations
 *     across more than 20 countries
 *   - Platform spans identity verification, biometric authentication,
 *     deepfake protection, and KYC/AML compliance
 *   - Grew via acquisitions of MetaMap (2024) and AuthenticID (2025)
 *
 * Source profile (Spec 642):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/incode/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Incode Technologies'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 15 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/incode/jobs';

@SourcePlugin({
  site: Site.INCODE_TECHNOLOGIES,
  name: 'Incode Technologies',
  category: 'company',
})
@Injectable()
export class IncodeTechnologiesService implements IScraper {
  private readonly logger = new Logger(IncodeTechnologiesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Incode Technologies: fetching ${url}`);

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
        const id = `incode-${jobId}`;

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
            site: Site.INCODE_TECHNOLOGIES,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Incode Technologies',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/incode/jobs/${listing.id}`,
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

      this.logger.log(`Incode Technologies: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Incode Technologies scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
