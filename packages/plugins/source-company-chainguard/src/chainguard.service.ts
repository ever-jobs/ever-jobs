import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Chainguard, Inc. — operator of the **dominant container-
 * image + supply-chain-security platform pioneered around the
 * distroless-Wolfi-OS-images / SBOM-attestation / sigstore-
 * based data model** (founded by Ville Aikas, Dan Lorenc,
 * Kim Lewandowski, Matt Moore, and Scott Nichols in 2021 in
 * Kirkland, Washington; raised ~$256M across rounds at peak
 * ~$3.5B valuation in November 2024 led by Kleiner Perkins
 * and Lightspeed Venture Partners; ships Chainguard Images
 * (~700 distroless container images), Chainguard Enforce
 * (admission-control / image-policy enforcement), Wolfi OS
 * (Linux distro purpose-built for containers), and Chainguard
 * SBOMs / VEX + sigstore signing across the container-image-
 * security / software-supply-chain-security / SBOM-attestation
 * segment — alongside competitors Snyk, Sysdig, Aqua Security,
 * Anchore, Wiz, Red Hat UBI, and Docker Hub Verified Publisher
 * — with a hybrid distributed workforce concentrated across
 * Kirkland WA (HQ), Seattle, San Francisco, New York, London,
 * Berlin, Tel Aviv, and Remote across the United States, the
 * United Kingdom, the European Union, and Israel) — publishes
 * its consolidated careers board through Greenhouse at the
 * bare slug `chainguard` (case-symmetric with the wire
 * `company_name === 'Chainguard'`; see Spec 122 § 10 D-05).
 *
 * **Zero structural deviations from the Otter (Spec 116)
 * template** — making this the **twenty-fifth** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with Otter, with
 * a **first-cohort D-10 sub-axis observation** (mixed
 * leading-AND-trailing pad form):
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/chainguard/jobs/<id>`.
 *     **Forty-first** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Seventy-eighth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Chainguard'` byte-for-byte (10 bytes
 *     — fully clean, case-symmetric with the lowercase 10-byte
 *     slug `chainguard`). **Sixty-ninth cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied with FIRST-COHORT
 *     mixed leading-AND-trailing pad form.** 7 of 60 wire
 *     titles in the run-332 probe carry pad bytes (~11.7 %
 *     pad rate): 6 trailing-pad (`'Enterprise Account
 *     Executive '`, `'Senior Software Engineer (Libraries
 *     Platform) '` ×3, `'Software Engineer (Libraries
 *     Platform) '` ×2) + 1 **leading-pad** (`' Senior
 *     Software Engineer (Experience)'`). **First cohort
 *     observation of LEADING-pad title form** — `.trim()`
 *     is symmetric on both directions, so no axis change is
 *     required. **Forty-fourth cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 60
 *     wire department names padded across 20 unique departments
 *     (`'Business Development'`, `'Corporate Marketing'`,
 *     `'Customer Success Management'`, `'Customer Support'`,
 *     `'Demand Generation'`, `'Developer Enablement'`, `'GTM
 *     Strategy & Ops'`, `'Information Security'`,
 *     `'International Business Development'`, `'International
 *     Sales'`, `'International Sales Engineering'`, `'Other
 *     Opportunities'`, plus 8 others — clean multi-token forms
 *     with internal whitespace and ampersands). **Sixty-second
 *     cohort plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/chainguard/jobs';

@SourcePlugin({
  site: Site.CHAINGUARD,
  name: 'Chainguard',
  category: 'company',
})
@Injectable()
export class ChainguardService implements IScraper {
  private readonly logger = new Logger(ChainguardService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Chainguard: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied with mixed leading-AND-trailing pad form:
        // 7/60 wire titles padded (~11.7 %); 6 trailing + 1
        // leading. `.trim()` strips both directions.
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
        const id = `chainguard-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        jobs.push(
          new JobPostDto({
            id,
            site: Site.CHAINGUARD,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Chainguard',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/chainguard/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/60 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Chainguard: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Chainguard scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
