import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import { classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  CompensationDto,
  LocationDto,
  Site,
  DescriptionFormat,
  getCompensationInterval,
} from '@ever-jobs/models';
import {
  createHttpClient,
  HttpClient,
  htmlToPlainText,
  extractEmails,
  normalizeCountryOnly,
  normalizeUsState,
  parseLocationList,
  parseLocationText,
  resolveCompensation,
  aggregateCompensation,
  toDateOnly,
} from '@ever-jobs/common';
import {
  ASHBY_API_URL,
  ASHBY_HEADERS,
  ASHBY_INCLUDE_COMPENSATION_QUERY,
  ASHBY_PUBLIC_MAX_RETRIES,
  ASHBY_RETRY_BACKOFF,
} from './ashby.constants';
import {
  AshbyJob,
  AshbyResponse,
  AshbyCompensationTier,
  AshbyFlatCompensationComponent,
} from './ashby.types';

@SourcePlugin({
  site: Site.ASHBY,
  name: 'Ashby',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class AshbyService implements IScraper {
  private readonly logger = new Logger(AshbyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Ashby scraper');
      return new JobResponseDto([]);
    }

    // Check for API key: per-request auth overrides env var
    const apiKey = input.auth?.ashby?.apiKey ?? process.env.ASHBY_API_KEY;
    if (apiKey) {
      try {
        const result = await this.scrapeWithApi(apiKey, companySlug, input);
        return result;
      } catch (err: any) {
        this.logger.warn(
          `Ashby authenticated API failed for ${companySlug}: ${err.message}. Falling back to public scraping.`,
        );
      }
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(ASHBY_HEADERS);

    const url = this.buildBoardUrl(companySlug);

    try {
      this.logger.log(`Fetching Ashby jobs for company: ${companySlug}`);
      const response = await this.getWithRetry(client, url);
      const data: AshbyResponse = response.data ?? { jobs: [] };
      const jobs = data.jobs ?? [];

      this.logger.log(`Ashby: found ${jobs.length} raw jobs for ${companySlug}`);

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;
        if (job.isListed === false) continue;

        try {
          const post = this.processJob(job, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing Ashby job ${job.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Ashby scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Fetch jobs using the authenticated Ashby Posting API.
   * Uses Basic Auth with the API key and reuses processJob() for mapping.
   */
  private async scrapeWithApi(
    apiKey: string,
    companySlug: string,
    input: ScraperInputDto,
  ): Promise<JobResponseDto> {
    this.logger.log(
      `Ashby: using authenticated API for company: ${companySlug}`,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    const url = this.buildBoardUrl(companySlug);
    const authToken = Buffer.from(`${apiKey}:`).toString('base64');

    const response = await client.post(url, undefined, {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${authToken}`,
      },
    });

    const data: AshbyResponse = response.data ?? { jobs: [] };
    const jobs = data.jobs ?? [];

    this.logger.log(
      `Ashby (authenticated): found ${jobs.length} jobs for ${companySlug}`,
    );

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];

    for (const job of jobs) {
      if (jobPosts.length >= resultsWanted) break;
      if (job.isListed === false) continue;

      try {
        const post = this.processJob(job, companySlug, input.descriptionFormat);
        if (post) {
          jobPosts.push(post);
        }
      } catch (err: any) {
        this.logger.warn(
          `Error processing Ashby API job ${job.id}: ${err.message}`,
        );
      }
    }

    return new JobResponseDto(jobPosts);
  }

  /**
   * Build the job-board URL for a company slug. Both the public GET and the
   * authenticated POST hit the same endpoint; includeCompensation=true opts
   * the response into the compensation payload (the public API omits it
   * entirely otherwise) and is harmless on the authenticated path.
   */
  private buildBoardUrl(companySlug: string): string {
    return `${ASHBY_API_URL}/${encodeURIComponent(companySlug)}?${ASHBY_INCLUDE_COMPENSATION_QUERY}`;
  }

  /**
   * GET with a small retry loop for the public job-board endpoint, whose
   * server-side latency can exceed client timeouts. Retries up to
   * ASHBY_PUBLIC_MAX_RETRIES times on network errors/timeouts (no HTTP
   * status) and HTTP 5xx; 4xx responses fail immediately. Backoff:
   * baseDelayMs * 2^attempt + random(0..jitterMaxMs).
   */
  private async getWithRetry(
    client: Pick<HttpClient, 'get'>,
    url: string,
    backoff: { baseDelayMs: number; jitterMaxMs: number } = ASHBY_RETRY_BACKOFF,
  ): Promise<{ data?: AshbyResponse }> {
    let lastError: any;
    for (let attempt = 0; attempt <= ASHBY_PUBLIC_MAX_RETRIES; attempt++) {
      try {
        return await client.get(url);
      } catch (err: any) {
        lastError = err;
        const status: number | undefined = err?.response?.status;
        const retryable = status === undefined || status >= 500;
        if (!retryable || attempt >= ASHBY_PUBLIC_MAX_RETRIES) {
          throw err;
        }
        const delay =
          backoff.baseDelayMs * Math.pow(2, attempt) +
          Math.random() * backoff.jitterMaxMs;
        this.logger.warn(
          `Ashby public GET failed (attempt ${attempt + 1}/${
            ASHBY_PUBLIC_MAX_RETRIES + 1
          }): ${err?.message ?? err}. Retrying in ${Math.round(delay)}ms`,
        );
        await this.sleep(delay);
      }
    }
    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private processJob(
    job: AshbyJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    // Description
    let description: string | null = null;
    if (format === DescriptionFormat.HTML && job.descriptionHtml) {
      description = job.descriptionHtml;
    } else if (job.descriptionPlain) {
      description = job.descriptionPlain;
    } else if (job.descriptionHtml) {
      description = htmlToPlainText(job.descriptionHtml);
    }

    const parsedLocations = parseLocationList(this.locationLabels(job));
    const locations = this.siteLocations(job);

    // Remote status: Ashby's structured `workplaceType` is authoritative
    // (`isRemote=true` is also set for Hybrid roles, so the boolean alone
    // over-counts remote). Trust `workplaceType === 'Remote'`, fall back to the
    // boolean only when `workplaceType` is absent, OR'd with location text.
    const isRemote =
      job.workplaceType?.toLowerCase() === 'remote' ||
      (job.workplaceType == null && Boolean(job.isRemote)) ||
      parsedLocations.remoteMentioned;

    // workFromHomeType: prefer the structured `workplaceType` (Hybrid/Remote),
    // merged with anything inferred from the location text.
    const workFromHomeType = this.mergeWorkFromHomeType(
      parsedLocations.workFromHomeType,
      this.workFromHomeTypeFromWorkplace(job.workplaceType),
    );

    // Compensation - structured tiers first, then fall back to parsing the
    // job description (Spec 5018). Always parse a plain-text body so HTML mode
    // does not feed tags to the salary matcher.
    const salaryText =
      job.descriptionPlain ??
      (job.descriptionHtml ? htmlToPlainText(job.descriptionHtml) : null);
    const compensation = resolveCompensation({
      structured: this.extractCompensation(job),
      text: salaryText,
    });

    // The public job-board API and the authenticated Posting API disagree on
    // these field names (publishedAt vs publishedDate, department vs
    // departmentName, team vs teamName). Prefer the public name, fall back to
    // the authenticated one so both paths populate.
    const publishedRaw = job.publishedAt ?? job.publishedDate;
    const datePosted = publishedRaw
      ? toDateOnly(publishedRaw)
      : null;

    return new JobPostDto({
      id: `ashby-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl: job.jobUrl ?? `https://jobs.ashbyhq.com/${companySlug}/${job.id}`,
      location: parsedLocations.location,
      ...(locations.length > 0 ? { locations } : {}),
      description,
      compensation,
      datePosted,
      isRemote,
      workFromHomeType,
      emails: extractEmails(description),
      site: Site.ASHBY,
      // ATS-specific fields
      atsId: job.id ?? null,
      atsType: 'ashby',
      department: job.department ?? job.departmentName ?? null,
      team: job.team ?? job.teamName ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? null,
    });
  }

  /** Map Ashby's `workplaceType` to a workFromHomeType label. OnSite → none. */
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

  private locationLabels(job: AshbyJob): string[] {
    const labels: string[] = [];

    const primaryAddress = this.postalAddressLabel(job.address);
    if (primaryAddress) {
      labels.push(primaryAddress);
    } else if (job.location) {
      labels.push(job.location);
    }

    for (const secondary of job.secondaryLocations ?? []) {
      const secondaryAddress = this.postalAddressLabel(secondary?.address);
      if (secondaryAddress) {
        labels.push(secondaryAddress);
      } else if (secondary?.location) {
        labels.push(secondary.location);
      }
    }

    return labels;
  }

  private postalAddressLabel(address: AshbyJob['address']): string | null {
    const postal = address?.postalAddress;
    if (!postal) return null;
    const parts = [
      postal.addressLocality,
      postal.addressRegion,
      postal.addressCountry,
    ].filter((part): part is string => Boolean(part?.trim()));
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /**
   * Per-site `locations[]` (Spec 5121). Each site keeps its structured
   * `postalAddress` fields rather than being flattened into a re-parsed
   * label: `addressLocality` → `city`, `addressRegion` → `state`
   * (normalized), `addressCountry` → `country`, and the wire `location`
   * string is preserved verbatim in `text`. Entries without a postalAddress
   * still go through `parseLocationList` so `text` is recorded there too.
   */
  private siteLocations(job: AshbyJob): LocationDto[] {
    const entries: Array<{
      label?: string | null;
      address?: AshbyJob['address'];
    }> = [
      { label: job.location, address: job.address },
      ...(job.secondaryLocations ?? []).map((secondary) => ({
        label: secondary?.location,
        address: secondary?.address,
      })),
    ];

    const sites: LocationDto[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const site = this.siteLocation(entry.label, entry.address);
      if (!site) continue;
      const key = [site.name, site.city, site.state, site.country]
        .filter((part): part is string => typeof part === 'string')
        .join('|')
        .toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      sites.push(site);
    }
    return sites;
  }

  /** A locality holding digits is a street address, not a city. */
  private siteLocation(
    label: string | null | undefined,
    address: AshbyJob['address'],
  ): LocationDto | null {
    const text = label?.replace(/\s+/g, ' ').trim() || null;
    const postal = address?.postalAddress;
    const postalFields = postal
      ? [
          postal.addressLocality,
          postal.addressRegion,
          postal.addressCountry,
          postal.streetAddress,
          postal.postalCode,
        ].filter((part) => typeof part === 'string' && part.trim())
      : [];

    if (postalFields.length === 0) {
      // No structured address: parse the label so `text` is still recorded.
      if (!text) return null;
      const parsed = parseLocationText(text);
      return parsed.location
        ? new LocationDto({ ...parsed.location, text })
        : null;
    }

    const locality = postal!.addressLocality?.trim() ?? '';
    const localityIsStreet = /\d/.test(locality);
    const localityIsCountry = /^(?:united states(?: of america)?|usa|us)$/i.test(
      locality,
    );

    let city = locality && !localityIsStreet && !localityIsCountry ? locality : null;
    let state =
      normalizeUsState(postal!.addressRegion ?? '') ??
      postal!.addressRegion?.trim() ??
      null;
    const rawCountry = postal!.addressCountry?.trim() ?? null;
    let country =
      (rawCountry ? normalizeCountryOnly(rawCountry) : null) ?? rawCountry;

    // When the postal locality is unusable, the label is the better source
    // for the city.
    if (!city && text) {
      const parsed = parseLocationText(text);
      if (parsed.location?.city) city = parsed.location.city;
      if (!state && parsed.location?.state) state = parsed.location.state;
    }

    const streetAddress =
      postal!.streetAddress?.trim() || (localityIsStreet ? locality : null);
    const postalCode = postal!.postalCode?.trim() ?? null;

    // A label carrying a site-name keyword is a name, not just geography.
    const name =
      text && /\b(?:hq|headquarters|office|campus|ranch|lab(?:s)?|studio(?:s)?|facility|site|plant|warehouse|factory)\b/i.test(text)
        ? text
        : null;

    return new LocationDto({
      name,
      text,
      city,
      state,
      country,
      streetAddress,
      postalCode,
    });
  }

  /**
   * Extract compensation from an Ashby job. Two wire shapes are supported:
   *
   * 1. Tiered: `compensationComponents[].tiers[]` with
   *    tierFloor/tierCeiling/interval/currency.
   * 2. Flat (served by the public API with includeCompensation=true; live
   *    probe 2026-06-11): `summaryComponents[]` and
   *    `compensationTiers[].components[]` with
   *    minValue/maxValue/interval/currencyCode.
   */
  private extractCompensation(job: AshbyJob): CompensationDto | null {
    const comp = job.compensation;
    if (!comp) return null;

    return (
      this.extractFromTieredComponents(job) ??
      this.extractFromFlatComponents(job)
    );
  }

  /** Tiered shape: compensationComponents[].tiers[] (tierFloor/tierCeiling). */
  private extractFromTieredComponents(job: AshbyJob): CompensationDto | null {
    const comp = job.compensation!;

    // Try compensationComponents first, then summaryComponents
    const components = comp.compensationComponents ?? comp.summaryComponents ?? [];
    if (components.length === 0) return null;

    // Find the base salary component (first component or one labeled 'salary'/'base')
    const salaryComponent = components.find(
      (c) =>
        c.compensationType?.toLowerCase().includes('salary') ||
        c.compensationType?.toLowerCase() === 'base' ||
        c.label?.toLowerCase().includes('salary'),
    ) ?? components[0];

    const tiers = salaryComponent?.tiers ?? [];
    if (tiers.length === 0) return null;

    // Fold every tier (e.g. per-location/level bands) into the overall
    // min-max envelope rather than reporting only the first (Spec 5019).
    return aggregateCompensation(
      tiers.map((tier: AshbyCompensationTier) => ({
        minAmount: tier.tierFloor,
        maxAmount: tier.tierCeiling,
        currency: tier.currency ?? 'USD',
        interval: this.resolveInterval(tier.interval),
      })),
    );
  }

  /** Flat shape: summaryComponents[] / compensationTiers[].components[]. */
  private extractFromFlatComponents(job: AshbyJob): CompensationDto | null {
    const comp = job.compensation!;

    const candidates: AshbyFlatCompensationComponent[] = [
      ...(comp.summaryComponents ?? []),
      ...(comp.compensationTiers ?? []).flatMap((t) => t.components ?? []),
    ].filter((c) => c.minValue != null || c.maxValue != null);
    if (candidates.length === 0) return null;

    // Prefer the base salary component; fall back to the first bounded one.
    const salaryComponent =
      candidates.find(
        (c) =>
          c.compensationType?.toLowerCase().includes('salary') ||
          c.compensationType?.toLowerCase() === 'base',
      ) ?? candidates[0];

    // Fold every component sharing the chosen salary's type (e.g. per-location
    // bands) into one overall min-max envelope; bonus/equity rows stay out
    // since they carry a different compensationType (Spec 5019).
    const salaryBands = candidates.filter(
      (c) =>
        (c.compensationType ?? null) ===
        (salaryComponent.compensationType ?? null),
    );

    return aggregateCompensation(
      salaryBands.map((c) => ({
        minAmount: c.minValue,
        maxAmount: c.maxValue,
        currency: c.currencyCode ?? 'USD',
        interval: this.resolveInterval(c.interval),
      })),
    );
  }

  private resolveInterval(raw: string | null | undefined) {
    if (!raw) return null;
    return getCompensationInterval(raw);
  }
}
