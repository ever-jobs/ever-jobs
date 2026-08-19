import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Age Bold — Digital fitness and fall-prevention platform for older adults, delivered through Medicare Advantage health plans..
 *
 * Age Bold, operating as Bold (agebold.com), is a digital health
 * company offering an at-home fitness and exercise platform built for
 * older adults. Its science-based programs target healthy aging and
 * disease prevention, with a focus on improving strength, balance, and
 * mobility to reduce falls and chronic pain. Bold distributes its
 * programs largely through partnerships with Medicare Advantage and
 * Medicare Supplement health plans, offering them as a covered member
 * benefit. The company reports raising seed funding and operates with
 * a remote-friendly team.
 *
 * Sector: Digital Health / Healthy Aging. HQ: Los Angeles, California, United States.
 *
 * Highlights:
 *   - At-home digital exercise platform designed for adults 65 and
 *     older
 *   - Focus on fall prevention, balance, strength, and chronic pain
 *     reduction
 *   - Distributed via partnerships with Medicare Advantage and
 *     Medicare Supplement plans
 *   - Remote-friendly hiring with roles in Member Experience,
 *     Prevention Medicine, People Ops, and Partnerships
 *   - Bilingual (Spanish) member support among customer experience
 *     roles
 *
 * Source profile (Spec 205):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/agebold/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Age Bold'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 10 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/agebold/jobs';

@SourcePlugin({
  site: Site.AGEBOLD,
  name: 'Age Bold',
  category: 'company',
})
@Injectable()
export class AgeboldService implements IScraper {
  private readonly logger = new Logger(AgeboldService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Age Bold: fetching ${url}`);

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
        const id = `agebold-${jobId}`;

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
            site: Site.AGEBOLD,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Age Bold',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/agebold/jobs/${listing.id}`,
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

      this.logger.log(`Age Bold: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Age Bold scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
