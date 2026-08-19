import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Apollo.io — B2B sales intelligence and engagement platform for go-to-market teams.
 *
 * Apollo.io is a B2B sales intelligence and engagement platform that
 * combines a large contact and company database with prospecting,
 * outreach, and revenue-workflow tooling for go-to-market teams.
 * Founded in 2015 (formerly ZenProspect) and headquartered in San
 * Francisco, the company sells primarily to sales, marketing, and
 * revenue operations functions. Its hiring spans Sales, Revenue,
 * Support, Marketing, Legal, and Finance across hybrid hubs in the US,
 * UK, Mexico, and the Philippines, alongside US-remote roles.
 *
 * Sector: B2B SaaS / Sales Intelligence. HQ: San Francisco, USA.
 *
 * Highlights:
 *   - Contact and company database paired with prospecting and
 *     outreach automation
 *   - Go-to-market focus reflected in Sales, Revenue, and Marketing
 *     hiring
 *   - Hybrid hubs across Austin, Salt Lake City, London, Manila, and
 *     Mexico City plus US-remote roles
 *   - Founded in 2015, formerly known as ZenProspect
 *   - Customer-facing Support and Account Advocate roles indicate a
 *     self-serve plus assisted SaaS model
 *
 * Source profile (Spec 288):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/apolloio/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Apollo.io'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 45 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/apolloio/jobs';

@SourcePlugin({
  site: Site.APOLLOIO,
  name: 'Apollo.io',
  category: 'company',
})
@Injectable()
export class ApolloioService implements IScraper {
  private readonly logger = new Logger(ApolloioService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Apollo.io: fetching ${url}`);

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
        const id = `apolloio-${jobId}`;

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
            site: Site.APOLLOIO,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Apollo.io',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/apolloio/jobs/${listing.id}`,
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

      this.logger.log(`Apollo.io: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Apollo.io scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
