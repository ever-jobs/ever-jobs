import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * A-LIGN External — Cybersecurity compliance, audit, and penetration testing firm serving regulated industries..
 *
 * A-LIGN is a cybersecurity compliance and audit firm that provides
 * services such as SOC examinations, ISO certifications, penetration
 * testing, and federal/government security assessments (including
 * FedRAMP and similar frameworks). Headquartered in Tampa, Florida, it
 * operates with a distributed and hybrid workforce across the United
 * States, the United Kingdom (London), and India (Gurgaon). The
 * presence of dedicated Federal and PenTest departments alongside
 * Sales and Marketing functions reflects a focus on regulated-industry
 * audit and security testing services.
 *
 * Sector: Cybersecurity & Compliance. HQ: Tampa, Florida, United States.
 *
 * Highlights:
 *   - Specializes in compliance audits and certifications (e.g., SOC,
 *     ISO) and security assessments
 *   - Dedicated Federal practice indicating government and
 *     FedRAMP-style assessment work
 *   - In-house penetration testing (PenTest) capability
 *   - Distributed workforce across the US, UK (London), and India
 *     (Gurgaon)
 *   - Active commercial growth with Sales and Marketing hiring
 *     (Account Executive, BDR roles)
 *
 * Source profile (Spec 230):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/align/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'A-LIGN External'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 19 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/align/jobs';

@SourcePlugin({
  site: Site.ALIGN,
  name: 'A-LIGN External',
  category: 'company',
})
@Injectable()
export class AlignService implements IScraper {
  private readonly logger = new Logger(AlignService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`A-LIGN External: fetching ${url}`);

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
        const id = `align-${jobId}`;

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
            site: Site.ALIGN,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'A-LIGN External',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/align/jobs/${listing.id}`,
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

      this.logger.log(`A-LIGN External: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`A-LIGN External scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
