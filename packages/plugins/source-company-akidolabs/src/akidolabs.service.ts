import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Akido — AI-native healthcare provider operating clinics powered by its ScopeAI clinical platform..
 *
 * Akido (Akido Labs) is an AI-native healthcare provider that pairs a
 * proprietary clinical AI platform, ScopeAI, with an operated medical
 * network of clinics. Through its Akido Care network it delivers
 * primary and specialty care across multiple states, with clinicians
 * reviewing and approving AI-assisted diagnoses and treatment plans.
 * The company emphasizes expanding access for underserved and
 * high-need populations.
 *
 * Sector: Healthcare / Health Tech. HQ: Los Angeles, CA, USA.
 *
 * Highlights:
 *   - Operates the Akido Care medical network spanning multiple
 *     specialties and clinic sites
 *   - Built ScopeAI, a clinical AI platform that drafts diagnoses and
 *     treatment plans for provider review
 *   - Hiring across operations, case management, credentialing, and
 *     revenue cycle functions, consistent with a care-delivery
 *     operator
 *   - Roles span California, New York, and Rhode Island, plus remote
 *     positions
 *
 * Source profile (Spec 221):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/akidolabs/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Akido'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 18 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/akidolabs/jobs';

@SourcePlugin({
  site: Site.AKIDOLABS,
  name: 'Akido',
  category: 'company',
})
@Injectable()
export class AkidolabsService implements IScraper {
  private readonly logger = new Logger(AkidolabsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Akido: fetching ${url}`);

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
        const id = `akidolabs-${jobId}`;

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
            site: Site.AKIDOLABS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Akido',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/akidolabs/jobs/${listing.id}`,
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

      this.logger.log(`Akido: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Akido scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
