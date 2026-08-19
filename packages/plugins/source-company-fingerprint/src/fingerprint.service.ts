import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Fingerprint — device intelligence platform for fraud prevention.
 *
 * Fingerprint (formerly FingerprintJS) is a device intelligence
 * company that identifies returning web and mobile visitors to help
 * businesses prevent online fraud and abuse. Its platform analyzes
 * 100+ device, browser, network, and behavioral signals to generate a
 * stable, persistent visitor identifier that remains accurate even
 * when users attempt to evade detection. The company began in 2012 as
 * the open-source FingerprintJS browser-fingerprinting library before
 * developing it into a commercial SaaS product.
 *
 * Sector: Identity & Fraud. HQ: Chicago, USA.
 *
 * Highlights:
 *   - Grew out of the open-source FingerprintJS browser-fingerprinting
 *     library, launched in 2012
 *   - Generates persistent visitor identifiers from 100+ device,
 *     browser, and network signals to detect fraud
 *   - Operates remote-first, hiring across functions including sales,
 *     customer success engineering, and finance
 *
 * Source profile (Spec 641):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/fingerprint/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Fingerprint'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 16 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/fingerprint/jobs';

@SourcePlugin({
  site: Site.FINGERPRINT,
  name: 'Fingerprint',
  category: 'company',
})
@Injectable()
export class FingerprintService implements IScraper {
  private readonly logger = new Logger(FingerprintService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Fingerprint: fetching ${url}`);

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
        const id = `fingerprint-${jobId}`;

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
            site: Site.FINGERPRINT,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Fingerprint',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/fingerprint/jobs/${listing.id}`,
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

      this.logger.log(`Fingerprint: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Fingerprint scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
