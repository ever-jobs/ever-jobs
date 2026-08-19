import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Aktos — Cloud-native, AI-powered operating system for debt collection and accounts receivable management..
 *
 * Aktos is a vertical SaaS fintech company building a cloud-native,
 * AI-powered operating system for the debt collection and accounts
 * receivable management (ARM) industry. Its platform manages the
 * end-to-end collections workflow for third-party agencies, spanning
 * consumer communications, compliance, payments, and invoicing.
 * Founded in 2022 and based in New York, the company operates at an
 * early/seed stage and hires across engineering and sales, including
 * remote roles in the US, LATAM, and Nigeria.
 *
 * Sector: Fintech / Vertical SaaS (debt collection software). HQ: New York, United States.
 *
 * Highlights:
 *   - Vertical SaaS fintech serving the debt collection / accounts
 *     receivable management (ARM) industry
 *   - Cloud-native, API-driven platform handling consumer
 *     communications, compliance, payments, and invoicing
 *   - Founded 2022, headquartered in New York; early/seed-stage
 *     company
 *   - Hires engineering and go-to-market roles, including remote
 *     positions across the US, LATAM, and Nigeria
 *   - Founding-level openings (e.g., Founding Account Executive)
 *     signal early team build-out
 *
 * Source profile (Spec 295):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/applytoaktos/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Aktos'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 10 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/applytoaktos/jobs';

@SourcePlugin({
  site: Site.APPLYTOAKTOS,
  name: 'Aktos',
  category: 'company',
})
@Injectable()
export class ApplytoaktosService implements IScraper {
  private readonly logger = new Logger(ApplytoaktosService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Aktos: fetching ${url}`);

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
        const id = `applytoaktos-${jobId}`;

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
            site: Site.APPLYTOAKTOS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Aktos',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/applytoaktos/jobs/${listing.id}`,
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

      this.logger.log(`Aktos: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Aktos scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
