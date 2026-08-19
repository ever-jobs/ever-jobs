import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Alarm.com — Cloud platform for connected-property security, video, energy, and home and business automation..
 *
 * Alarm.com is a publicly traded technology company that provides a
 * cloud-based platform for the connected home and business, including
 * interactive security, video monitoring, energy management, and home
 * automation services. Its software and hardware are delivered through
 * a network of authorized service providers rather than sold directly
 * to end users. The hiring signals show in-house teams spanning
 * software and device engineering, accounting and finance, sales,
 * supply chain, and HR.
 *
 * Sector: Connected home and IoT security software. HQ: Tysons, Virginia, United States.
 *
 * Highlights:
 *   - Cloud-based platform for interactive security, video monitoring,
 *     and home/business automation
 *   - Sells through a network of authorized service providers rather
 *     than directly to consumers
 *   - In-house device engineering and acoustics roles point to
 *     proprietary connected hardware
 *   - Multi-site footprint including Tysons VA, Liberty Lake WA, and
 *     San Diego CA
 *   - Hiring across software engineering, finance, sales, supply
 *     chain, and HR
 *
 * Source profile (Spec 226):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/alarmcom/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Alarm.com'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 75 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alarmcom/jobs';

@SourcePlugin({
  site: Site.ALARMCOM,
  name: 'Alarm.com',
  category: 'company',
})
@Injectable()
export class AlarmcomService implements IScraper {
  private readonly logger = new Logger(AlarmcomService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Alarm.com: fetching ${url}`);

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
        const id = `alarmcom-${jobId}`;

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
            site: Site.ALARMCOM,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Alarm.com',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alarmcom/jobs/${listing.id}`,
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

      this.logger.log(`Alarm.com: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Alarm.com scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
