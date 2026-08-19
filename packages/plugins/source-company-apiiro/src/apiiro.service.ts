import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Apiiro — Application security posture management (ASPM) platform for securing the software development lifecycle..
 *
 * Apiiro is an Israel-based cybersecurity company that develops an
 * application security posture management (ASPM) platform. Its
 * software analyzes source code, pipelines, and development
 * environments to map application risks and help engineering and
 * security teams prioritize and remediate vulnerabilities across the
 * software development lifecycle. The platform applies code analysis
 * and AI to provide contextual visibility into security risks from
 * design through deployment.
 *
 * Sector: Cybersecurity / Application Security. HQ: Tel Aviv, Israel.
 *
 * Highlights:
 *   - Builds an application security posture management (ASPM)
 *     platform that maps code, pipeline, and runtime risks
 *   - Headquartered in Tel Aviv with remote roles across the US and UK
 *   - Hiring across Engineering, Sales, and Product, including AI
 *     Engineer roles
 *   - Targets enterprise security and engineering teams managing
 *     software supply-chain risk
 *
 * Source profile (Spec 283):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/apiiro/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Apiiro'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 7 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/apiiro/jobs';

@SourcePlugin({
  site: Site.APIIRO,
  name: 'Apiiro',
  category: 'company',
})
@Injectable()
export class ApiiroService implements IScraper {
  private readonly logger = new Logger(ApiiroService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Apiiro: fetching ${url}`);

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
        const id = `apiiro-${jobId}`;

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
            site: Site.APIIRO,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Apiiro',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/apiiro/jobs/${listing.id}`,
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

      this.logger.log(`Apiiro: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Apiiro scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
