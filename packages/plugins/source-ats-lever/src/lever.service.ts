import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  Site,
  getCompensationInterval,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  extractEmails,
  parseLocationList,
  regionNameFromCode,
  randomSleep,
  resolveCompensation,
  toDateOnly,
} from '@ever-jobs/common';
import { LEVER_API_URL, LEVER_HEADERS, LEVER_DELAY_MS } from './lever.constants';
import { LeverJob } from './lever.types';

@SourcePlugin({
  site: Site.LEVER,
  name: 'Lever',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class LeverService implements IScraper {
  private readonly logger = new Logger(LeverService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Lever scraper');
      return new JobResponseDto([]);
    }

    // ─── Try authenticated API first if credentials are available ────
    const apiKey =
      input.auth?.lever?.apiKey ?? process.env.LEVER_API_KEY ?? null;

    if (apiKey) {
      try {
        const apiResult = await this.scrapeWithApi(input, companySlug, apiKey);
        return apiResult;
      } catch (err: any) {
        this.logger.warn(
          `Lever authenticated API failed for ${companySlug}: ${err.message} — falling back to public scraping`,
        );
      }
    }

    // ─── Existing public scraping logic ─────────────────────────────
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(LEVER_HEADERS);

    const url = `${LEVER_API_URL}/${encodeURIComponent(companySlug)}?mode=json`;

    try {
      this.logger.log(`Fetching Lever jobs for company: ${companySlug}`);
      const response = await client.get(url);
      const jobs: LeverJob[] = response.data ?? [];

      if (!Array.isArray(jobs)) {
        this.logger.warn(`Unexpected Lever response format for ${companySlug}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Lever: found ${jobs.length} raw jobs for ${companySlug}`);

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJob(job, companySlug);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing Lever job ${job.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Lever scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Scrape using the authenticated Lever Postings API.
   * Provides richer data including tags, content blocks, and access to private listings.
   *
   * @see https://hire.lever.co/developer/documentation
   */
  private async scrapeWithApi(
    input: ScraperInputDto,
    companySlug: string,
    apiKey: string,
  ): Promise<JobResponseDto> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    });

    const url = `${LEVER_API_URL}/${encodeURIComponent(companySlug)}?mode=json`;

    this.logger.log(
      `Fetching Lever jobs via authenticated API for company: ${companySlug}`,
    );
    const response = await client.get(url);
    const jobs: LeverJob[] = response.data ?? [];

    if (!Array.isArray(jobs)) {
      this.logger.warn(
        `Unexpected Lever API response format for ${companySlug}`,
      );
      return new JobResponseDto([]);
    }

    this.logger.log(
      `Lever authenticated API: found ${jobs.length} jobs for ${companySlug}`,
    );

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];

    for (const job of jobs) {
      if (jobPosts.length >= resultsWanted) break;

      try {
        const post = this.processApiJob(job, companySlug);
        if (post) {
          jobPosts.push(post);
        }
      } catch (err: any) {
        this.logger.warn(
          `Error processing Lever API job ${job.id}: ${err.message}`,
        );
      }
    }

    return new JobResponseDto(jobPosts);
  }

  /**
   * Map a Lever API job to JobPostDto.
   * The authenticated API may return additional fields such as tags and
   * content list blocks that are not available from the public endpoint.
   */
  private processApiJob(job: LeverJob, companySlug: string): JobPostDto | null {
    if (!job.text) return null;
    return this.buildJobPost(job, companySlug);
  }

  private processJob(job: LeverJob, companySlug: string): JobPostDto | null {
    if (!job.text) return null;
    return this.buildJobPost(job, companySlug);
  }

  /**
   * Map a Lever posting to a JobPostDto. Shared by the public and authenticated
   * paths, which return the same posting shape from the same endpoint.
   */
  private buildJobPost(job: LeverJob, companySlug: string): JobPostDto {
    const title = job.text as string;
    const description = this.buildDescription(job);

    // Location: prefer the multi-entry `allLocations`, fall back to the single
    // `categories.location`, and normalize through the shared parser (handles
    // `City, ST` splitting, multi-site `; `-joining, and remote/hybrid hints).
    const parsedLocations = parseLocationList(this.locationLabels(job));
    const location = this.applyCountry(parsedLocations.location, job.country);

    // Remote status: trust the explicit workplaceType flag, otherwise fall back
    // to text mentioned in the location labels.
    const isRemote =
      job.workplaceType?.toLowerCase() === 'remote' ||
      parsedLocations.remoteMentioned ||
      false;

    // workFromHomeType: merge the workplaceType flag (e.g. hybrid) with anything
    // inferred from the location text.
    const workFromHomeType = this.mergeWorkFromHomeType(
      parsedLocations.workFromHomeType,
      this.workFromHomeTypeFromWorkplace(job.workplaceType),
    );

    return new JobPostDto({
      id: `lever-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl: job.hostedUrl ?? `https://jobs.lever.co/${companySlug}/${job.id}`,
      location,
      description,
      compensation: resolveCompensation({
        structured: this.extractCompensation(job),
        text: description,
      }),
      datePosted: job.createdAt
        ? toDateOnly(job.createdAt)
        : null,
      isRemote,
      workFromHomeType,
      emails: extractEmails(description),
      site: Site.LEVER,
      // ATS-specific fields
      atsId: job.id ?? null,
      atsType: 'lever',
      department: job.categories?.department ?? null,
      team: job.categories?.team ?? null,
      employmentType: job.categories?.commitment ?? null,
      applyUrl: job.applyUrl ?? null,
    });
  }

  /**
   * Ordered location labels for `parseLocationList`. Lever carries every site in
   * `categories.allLocations`; fall back to the single `categories.location`.
   */
  private locationLabels(job: LeverJob): string[] {
    const all = job.categories?.allLocations;
    if (Array.isArray(all) && all.length > 0) {
      return all.filter(
        (label): label is string =>
          typeof label === 'string' && label.trim().length > 0,
      );
    }
    const single = job.categories?.location;
    return single ? [single] : [];
  }

  /**
   * Fold Lever's ISO-2 `country` code into the parsed location when the parser
   * did not already derive a country (e.g. non-US sites the US-only parser
   * leaves bare). Uses the runtime CLDR table via `regionNameFromCode`.
   */
  private applyCountry(
    location: LocationDto | null,
    countryCode: string | null | undefined,
  ): LocationDto | null {
    const country = regionNameFromCode(countryCode);
    if (!country) return location;
    if (!location) return new LocationDto({ country });
    if (location.country) return location;
    return new LocationDto({ ...location, country });
  }

  private extractCompensation(job: LeverJob): CompensationDto | null {
    const range = job.salaryRange;
    if (!range) return null;

    const minAmount = typeof range.min === 'number' ? range.min : null;
    const maxAmount = typeof range.max === 'number' ? range.max : null;
    if (minAmount === null && maxAmount === null) return null;

    return new CompensationDto({
      interval: this.resolveInterval(range.interval) ?? undefined,
      minAmount: minAmount ?? undefined,
      maxAmount: maxAmount ?? undefined,
      currency: range.currency ?? undefined,
    });
  }

  /**
   * Lever pay-period tokens are `per-<unit>-<kind>` (e.g. `per-year-salary`,
   * `per-hour-wage`, `per-month-salary`). Extract the unit and resolve it via
   * the shared interval map so the real interval is honored (not coerced to
   * yearly).
   */
  private resolveInterval(
    raw: string | null | undefined,
  ): CompensationInterval | null {
    if (!raw) return null;
    const match = /per-(year|hour|month|week|day)/i.exec(raw);
    return getCompensationInterval(match?.[1] ?? raw);
  }

  private workFromHomeTypeFromWorkplace(
    workplaceType: string | null | undefined,
  ): string | null {
    switch (workplaceType?.toLowerCase()) {
      case 'hybrid':
        return 'Hybrid';
      case 'remote':
        return 'Remote';
      default:
        return null;
    }
  }

  private mergeWorkFromHomeType(
    a: string | null,
    b: string | null,
  ): string | null {
    if (!a) return b;
    if (!b || a === b) return a;
    return 'Hybrid or Remote';
  }

  private buildDescription(job: LeverJob): string | null {
    const parts: string[] = [];

    const combinedDescription = this.firstNonEmpty(
      job.descriptionPlain,
      job.description,
    );

    if (combinedDescription) {
      parts.push(this.toPlainText(combinedDescription));
    } else {
      const opening = this.firstNonEmpty(job.openingPlain, job.opening);
      const body = this.firstNonEmpty(
        job.descriptionBodyPlain,
        job.descriptionBody,
      );
      if (opening) parts.push(this.toPlainText(opening));
      if (body) parts.push(this.toPlainText(body));
    }

    if (Array.isArray(job.lists)) {
      for (const list of job.lists) {
        const heading = this.firstNonEmpty(list.text);
        const body = this.firstNonEmpty(list.content);
        const listParts = [
          heading ? this.toPlainText(heading) : null,
          body ? this.toPlainText(body) : null,
        ].filter((part): part is string => Boolean(part));

        if (listParts.length > 0) {
          parts.push(listParts.join('\n'));
        }
      }
    }

    const additional = this.firstNonEmpty(job.additionalPlain, job.additional);
    if (additional) {
      parts.push(this.toPlainText(additional));
    }

    const description = parts
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join('\n\n');

    return description || null;
  }

  private firstNonEmpty(...values: Array<string | null | undefined>): string | null {
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
    return null;
  }

  private toPlainText(value: string): string {
    return value.includes('<') && value.includes('>')
      ? htmlToPlainText(value)
      : value.trim();
  }
}
