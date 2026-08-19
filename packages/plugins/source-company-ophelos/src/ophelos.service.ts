import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Ophelos — AI-powered debt resolution platform helping people clear debts through ethical, personalised repayment journeys.
 *
 * Ophelos is a London-based fintech that operates a technology-driven
 * debt resolution platform. It uses machine learning and natural
 * language understanding to help customers resolve outstanding debts
 * through manageable, personalised instalment plans while giving
 * businesses insight into customers' financial wellbeing. The company
 * emphasises digital communication and a customer-centric, ethical
 * approach to debt recovery, including the identification and support
 * of potentially vulnerable customers.
 *
 * Sector: Fintech / Debt Resolution. HQ: London, United Kingdom.
 *
 * Highlights:
 *   - Founded in 2021, headquartered in London, UK
 *   - AI-driven debt resolution using machine learning and natural
 *     language understanding
 *   - Proprietary language model 'OLIVE' helps identify potentially
 *     vulnerable customers
 *   - Offers personalised, flexible instalment plans through digital
 *     channels
 *   - Acquired by Intrum in 2023
 *
 * Source profile (Spec 753):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/ophelos/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Ophelos'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 4 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/ophelos/jobs';

@SourcePlugin({
  site: Site.OPHELOS,
  name: 'Ophelos',
  category: 'company',
})
@Injectable()
export class OphelosService implements IScraper {
  private readonly logger = new Logger(OphelosService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Ophelos: fetching ${url}`);

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
        const id = `ophelos-${jobId}`;

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
            site: Site.OPHELOS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Ophelos',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/ophelos/jobs/${listing.id}`,
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

      this.logger.log(`Ophelos: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Ophelos scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
