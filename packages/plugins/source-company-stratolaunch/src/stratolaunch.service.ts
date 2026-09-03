import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, htmlToPlainText } from '@ever-jobs/common';

function decodeFully(html: string): string {
  let prev: string;
  let curr = html;
  do {
    prev = curr;
    curr = decodeHtmlEntities(curr);
  } while (curr !== prev);
  return curr;
}

/**
 * Stratolaunch — Stratolaunch is an aerospace technology accelerator,
 * headquartered in Mojave, California, USA.
 *
 * This source plugin ingests live open roles published on Stratolaunch's
 * official Greenhouse-hosted careers board via the public Greenhouse Job
 * Board API. Retrieved postings are normalized into the Ever Jobs job schema
 * for downstream deduplication, liveness checking, and salary normalization.
 * The plugin performs read-only, unauthenticated discovery and stores no
 * candidate or employer credentials.
 *
 * Sector: Aerospace / hypersonic testbeds. HQ: Mojave, California, USA.
 *
 * Source profile (Spec 5089):
 *   - D-01 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/stratolaunch/jobs/<id>`.
 *   - D-02 — `companyDomains: ['stratolaunch.com']` so callers can resolve
 *     the plugin by the company's careers domain.
 *   - D-03 — entity-decode-then-tag-strip description pipeline.
 *   - D-04 — wire `company_name` pass-through ('Stratolaunch').
 *   - D-05 — defensive `.trim()` on wire titles and department names.
 *   - D-06 — `first_published` preferred over `updated_at` for `datePosted`.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/stratolaunch/jobs';
const DEFAULT_BOARD = 'stratolaunch';

@SourcePlugin({
  site: Site.STRATOLAUNCH,
  name: 'Stratolaunch',
  category: 'company',
  companyDomains: ['stratolaunch.com'],
})
@Injectable()
export class StratolaunchService implements IScraper {
  private readonly logger = new Logger(StratolaunchService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const board = this.resolveBoard(input);
      const url = `https://api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
      this.logger.log(`Stratolaunch: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

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
        const id = `stratolaunch-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        const deptRaw = listing.departments?.[0]?.name ?? null;
        const department = deptRaw ? deptRaw.trim() : null;

        const remoteMetadata = (listing.metadata ?? []).some(
          (m: any) =>
            m?.name === 'Work Location' &&
            (m?.value ?? []).some((v: string) => v?.toLowerCase() === 'remote'),
        );
        const isRemote =
          remoteMetadata ||
          (locationStr?.toLowerCase().includes('remote') ?? false);

        const absoluteUrl =
          listing.absolute_url ??
          `https://job-boards.greenhouse.io/${board}/jobs/${jobId}`;

        // D-06: first_published is the posting date; updated_at drifts with
        // every board edit.
        const datePosted = listing.first_published ?? listing.updated_at ?? null;

        jobs.push(
          new JobPostDto({
            id,
            site: Site.STRATOLAUNCH,
            title,
            companyName: listing.company_name ?? 'Stratolaunch',
            jobUrl: absoluteUrl,
            applyUrl: absoluteUrl,
            location,
            description: listing.content
              ? htmlToPlainText(decodeFully(listing.content))
              : null,
            datePosted,
            isRemote,
            department,
          }),
        );
      }

      this.logger.log(`Stratolaunch: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Stratolaunch scrape failed: ${err.message}`);
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }

  private resolveBoard(input: ScraperInputDto): string {
    if (input.companySlug) {
      return input.companySlug;
    }
    if (input.companyUrl) {
      const match = input.companyUrl.match(
        /(?:job-boards|boards)\.greenhouse\.io\/([^/]+)/,
      );
      if (match && match[1]) {
        return match[1];
      }
    }
    return DEFAULT_BOARD;
  }
}
