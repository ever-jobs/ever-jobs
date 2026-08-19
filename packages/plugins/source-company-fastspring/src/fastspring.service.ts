import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * FastSpring — FastSpring is a merchant-of-record commerce platform that handles global payments, subscriptions, tax compliance, and localized checkout for software and SaaS companies..
 *
 * FastSpring is a privately held digital commerce company founded in
 * 2005 and headquartered in Santa Barbara, California, with additional
 * offices in Amsterdam, Belfast, and Halifax. As a merchant of record,
 * FastSpring becomes the legal seller in the payment flow, bundling
 * global payment processing, subscription management, fraud
 * prevention, sales tax collection/remittance, and localized branded
 * checkout into a single platform for software, SaaS, and
 * digital-product vendors. The company is backed by technology-focused
 * private equity firm Accel-KKR. The sampled roles (Payment Operations
 * Specialist, Software Engineer - Payments, and an APAC Account
 * Executive based in Singapore) and locations align with its
 * payments-platform business and global footprint.
 *
 * Sector: Fintech / Merchant-of-Record Commerce & Subscription Billing. HQ: Santa Barbara, California, United States.
 *
 * Highlights:
 *   - Founded in 2005; headquartered in Santa Barbara, California,
 *     with offices in Amsterdam, Belfast, and Halifax
 *   - Operates a merchant-of-record (MoR) model, becoming the legal
 *     seller to handle payments, tax, and compliance on behalf of
 *     vendors
 *   - Serves software vendors, SaaS startups, app developers, and
 *     digital-product/online-education businesses
 *   - Bundles global payment processing, subscription/recurring
 *     billing, fraud prevention, and sales-tax remittance into one
 *     platform
 *   - Backed by private equity firm Accel-KKR
 *
 * Source profile (Spec 793):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/fastspring/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'FastSpring'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 5 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/fastspring/jobs';

@SourcePlugin({
  site: Site.FASTSPRING,
  name: 'FastSpring',
  category: 'company',
})
@Injectable()
export class FastSpringService implements IScraper {
  private readonly logger = new Logger(FastSpringService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`FastSpring: fetching ${url}`);

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
        const id = `fastspring-${jobId}`;

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
            site: Site.FASTSPRING,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'FastSpring',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/fastspring/jobs/${listing.id}`,
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

      this.logger.log(`FastSpring: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`FastSpring scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
