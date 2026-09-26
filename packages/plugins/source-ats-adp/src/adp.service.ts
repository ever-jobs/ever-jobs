import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  getJobTypeFromString,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  parseLocationList,
  parseLocationText,
  resolveCompensation,
  toDateOnly,
} from '@ever-jobs/common';
import {
  ADP_DEFAULT_MAX_LIST_PAGES,
  ADP_DETAIL_CONCURRENCY,
  ADP_HEADERS,
  ADP_HOSTS,
  ADP_MAX_LIST_PAGES_ENV,
  ADP_PAGE_SIZE,
  adpCareersUrl,
  adpDetailUrl,
  adpListUrl,
  parseAdpMaxListPages,
} from './adp.constants';
import { AdpResponse, AdpJob } from './adp.types';

type HttpClient = ReturnType<typeof createHttpClient>;

/** The requisition list, plus the host it resolved on (for detail + URLs). */
interface AdpListing {
  host: string;
  jobs: AdpJob[];
}

/** How far one scrape may walk the paged requisition list. */
interface AdpListLimits {
  /**
   * Stop paging once this many requisitions are held. ADP applies no
   * post-list filter (no searchTerm/location filtering happens after the
   * listing), so every requisition past `offset + resultsWanted` is never used.
   */
  budget: number;
  /** Hard cap on list pages fetched, first page included (ADP_MAX_LIST_PAGES). */
  maxPages: number;
}

@SourcePlugin({
  site: Site.ADP,
  name: 'ADP',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class AdpService implements IScraper {
  private readonly logger = new Logger(AdpService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const cid = input.companySlug;
    if (!cid) {
      this.logger.warn('No companySlug (cid) provided for ADP scraper');
      return new JobResponseDto([], {
        reason: 'bad_input',
        detail: 'no companySlug (cid) provided for ADP scraper',
      });
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(ADP_HEADERS);

    const resultsWanted = this.nonNegativeInt(input.resultsWanted ?? 100, 100);
    const offset = this.nonNegativeInt(input.offset, 0);
    const limits: AdpListLimits = {
      budget: offset + resultsWanted,
      maxPages: this.resolveMaxListPages(),
    };

    const listing = await this.fetchList(client, cid, limits);
    if (!listing) {
      this.logger.error(
        `ADP: no host resolved the requisition list for cid ${cid}`,
      );
      return new JobResponseDto([], {
        reason: 'fetch_error',
        detail: `no ADP host resolved the requisition list for cid ${cid}`,
      });
    }

    this.logger.log(
      `ADP: found ${listing.jobs.length} raw jobs for ${cid} on ${listing.host}`,
    );

    // The list feed omits the posting body; `requisitionDescription` lives only
    // on the per-requisition detail endpoint. Overlay the wanted slice — the
    // requested window (offset .. offset + resultsWanted), so detail requests
    // are only spent on rows the caller will receive.
    const wanted = listing.jobs.slice(offset, offset + resultsWanted);
    const details = await this.fetchDetails(client, listing.host, cid, wanted);

    const jobPosts: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    wanted.forEach((job, index) => {
      try {
        const post = this.mapJob(
          job,
          details[index],
          listing.host,
          cid,
          input.descriptionFormat,
        );
        if (post) {
          jobPosts.push(post);
        }
      } catch (err: any) {
        this.logger.warn(`Error processing ADP job ${job.itemID}: ${err.message}`);
        diagnostics = classifyScrapeError(err);
      }
    });

    return new JobResponseDto(jobPosts, diagnostics);
  }

  /**
   * Fetch the requisition list, trying each ADP host in order. The same `cid`
   * resolves on exactly one host (the other 404s), so the first host that
   * returns a `jobRequisitions` payload wins — even when that array is empty
   * (a company with no open reqs is still "resolved").
   */
  private async fetchList(
    client: HttpClient,
    cid: string,
    limits: AdpListLimits,
  ): Promise<AdpListing | null> {
    for (const host of ADP_HOSTS) {
      try {
        const response = await client.get<AdpResponse>(adpListUrl(host, cid));
        const data = response.data;
        if (data && Array.isArray(data.jobRequisitions)) {
          return { host, jobs: await this.fetchAllPages(client, host, cid, data, limits) };
        }
        this.logger.warn(`ADP: unexpected payload from ${host} for ${cid}`);
      } catch (err: any) {
        this.logger.warn(
          `ADP: list fetch failed on ${host} for ${cid}: ${err.message}`,
        );
      }
    }
    return null;
  }

  /**
   * Walk the remaining list pages: the API caps a response at `ADP_PAGE_SIZE`
   * requisitions and reports the real total in `meta.totalNumber`. Pages are
   * addressed by `$skip`/`$top`; the loop stops on the last page, once
   * `limits.budget` requisitions are held (nothing past it is used), at the
   * `limits.maxPages` cap, on an empty or fully-duplicate page, or on a page
   * fetch failure (partial results kept — a truncated list beats none).
   */
  private async fetchAllPages(
    client: HttpClient,
    host: string,
    cid: string,
    first: AdpResponse,
    limits: AdpListLimits,
  ): Promise<AdpJob[]> {
    const jobs = [...(first.jobRequisitions ?? [])];
    const total = first.meta?.totalNumber ?? jobs.length;
    const seen = new Set(jobs.map((job) => job.itemID));
    let pagesFetched = 1;

    for (let skip = ADP_PAGE_SIZE; jobs.length < total; skip += ADP_PAGE_SIZE) {
      if (jobs.length >= limits.budget) break;
      if (pagesFetched >= limits.maxPages) {
        this.logger.warn(
          `ADP: stopped at the ${limits.maxPages}-page list cap (${ADP_MAX_LIST_PAGES_ENV}) for ${cid}: ` +
            `${jobs.length} of ${total} requisitions listed`,
        );
        break;
      }
      pagesFetched++;
      let page: AdpJob[];
      try {
        const response = await client.get<AdpResponse>(
          adpListUrl(host, cid, skip),
        );
        page = response.data?.jobRequisitions ?? [];
      } catch (err: any) {
        this.logger.warn(
          `ADP: list page at $skip=${skip} failed for ${cid}: ${err.message}`,
        );
        break;
      }
      const fresh = page.filter((job) => !seen.has(job.itemID));
      if (fresh.length === 0) break;
      for (const job of fresh) {
        seen.add(job.itemID);
        jobs.push(job);
      }
    }
    return jobs;
  }

  /**
   * The list-page cap for this scrape, from `ADP_MAX_LIST_PAGES` (default
   * 100). Read per scrape so a config change applies without a restart; an
   * invalid value warns and uses the default.
   */
  private resolveMaxListPages(): number {
    const raw = process.env[ADP_MAX_LIST_PAGES_ENV];
    const parsed = parseAdpMaxListPages(raw);
    if (parsed !== null) return parsed;
    this.logger.warn(
      `Ignoring invalid ${ADP_MAX_LIST_PAGES_ENV}="${raw}" (expected a positive integer); ` +
        `using ${ADP_DEFAULT_MAX_LIST_PAGES}`,
    );
    return ADP_DEFAULT_MAX_LIST_PAGES;
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  }

  /**
   * Overlay each listing with its per-requisition detail payload under bounded
   * concurrency. Fail-safe: a failed or empty detail fetch yields `null` for
   * that index (the batch is never nuked), so the job still maps from the list.
   */
  private async fetchDetails(
    client: HttpClient,
    host: string,
    cid: string,
    jobs: AdpJob[],
  ): Promise<(AdpJob | null)[]> {
    const details: (AdpJob | null)[] = new Array(jobs.length).fill(null);
    for (let index = 0; index < jobs.length; index += ADP_DETAIL_CONCURRENCY) {
      const batch = jobs.slice(index, index + ADP_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((job) => this.fetchDetail(client, host, cid, job.itemID)),
      );
      settled.forEach((result, batchIndex) => {
        if (result.status === 'fulfilled') {
          details[index + batchIndex] = result.value;
        }
      });
    }
    return details;
  }

  /** GET the per-requisition detail; the response *is* the requisition object. */
  private async fetchDetail(
    client: HttpClient,
    host: string,
    cid: string,
    itemId: string | null | undefined,
  ): Promise<AdpJob | null> {
    if (!itemId) return null;
    const response = await client.get<AdpJob>(adpDetailUrl(host, cid, itemId));
    return response.data ?? null;
  }

  private mapJob(
    job: AdpJob,
    detail: AdpJob | null,
    host: string,
    cid: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.requisitionTitle ?? detail?.requisitionTitle ?? null;
    if (!title) return null;

    const itemId = job.itemID ?? detail?.itemID ?? '';

    const description = this.formatDescription(
      detail?.requisitionDescription ?? job.requisitionDescription,
      format,
    );

    // ADP exposes no structured remote flag; its `requisitionLocations` labels
    // are the only machine-readable remote evidence (e.g. a location named
    // "Remote"), parsed through the shared location normalizer.
    const labels = this.locationLabels(
      job.requisitionLocations ?? detail?.requisitionLocations,
    );
    const parsedLocation = parseLocationList(labels);
    const locations = this.siteLocations(
      job.requisitionLocations ?? detail?.requisitionLocations,
    );
    const location = parsedLocation.location ?? new LocationDto({});
    const isRemote = parsedLocation.remoteMentioned;
    const workFromHomeType = parsedLocation.workFromHomeType;

    const employmentLabel =
      job.workLevelCode?.shortName ?? detail?.workLevelCode?.shortName ?? null;
    const employmentType = employmentLabel?.trim() || null;
    const mappedJobType = employmentLabel
      ? getJobTypeFromString(employmentLabel)
      : null;

    const compensation = resolveCompensation({
      structured: this.extractCompensation(job, detail),
      text: description,
    });

    const postDate = job.postDate ?? detail?.postDate ?? null;

    return new JobPostDto({
      id: `adp-${itemId}`,
      title,
      companyName: null,
      jobUrl: adpCareersUrl(host, cid, itemId),
      location,
      ...(locations.length > 0 ? { locations } : {}),
      description,
      ...(compensation ? { compensation } : {}),
      datePosted: postDate ? toDateOnly(postDate) : null,
      isRemote,
      ...(workFromHomeType ? { workFromHomeType } : {}),
      ...(mappedJobType ? { jobType: [mappedJobType] } : {}),
      ...(employmentType ? { employmentType } : {}),
      emails: extractEmails(description),
      site: Site.ADP,
      atsId: itemId || null,
      atsType: 'adp',
    });
  }

  /**
   * Build the ordered list of location labels from `requisitionLocations`,
   * preferring the display `nameCode.shortName` and falling back to the
   * structured address (`City, ST`).
   */
  private locationLabels(
    locations: AdpJob['requisitionLocations'],
  ): string[] {
    const labels: string[] = [];
    for (const loc of locations ?? []) {
      const shortName = loc?.nameCode?.shortName?.trim();
      if (shortName) {
        labels.push(shortName);
        continue;
      }
      const city = loc?.address?.cityName?.trim();
      const state = loc?.address?.countrySubdivisionLevel1?.codeValue?.trim();
      const composed = [city, state].filter(Boolean).join(', ');
      if (composed) labels.push(composed);
    }
    return labels;
  }

  /**
   * Per-site `locations[]` (Spec 5121): `requisitionLocations` entries carry
   * a structured `address` (`cityName`, `countrySubdivisionLevel1.codeValue`,
   * `countryCode`) plus a display `nameCode.shortName`. Map the structured
   * fields directly instead of round-tripping a composed label through the
   * parser; the display name is preserved verbatim in `text`. Entries
   * without an address fall back to parsing the shortName.
   */
  private siteLocations(
    locations: AdpJob['requisitionLocations'],
  ): LocationDto[] {
    const sites: LocationDto[] = [];
    const seen = new Set<string>();
    for (const loc of locations ?? []) {
      const text = loc?.nameCode?.shortName?.trim() || null;
      const city = loc?.address?.cityName?.trim() || null;
      const state =
        loc?.address?.countrySubdivisionLevel1?.codeValue?.trim() || null;
      const country = loc?.address?.countryCode?.trim() || null;

      let site: LocationDto | null = null;
      if (city || state || country) {
        site = new LocationDto({ city, state, country, text });
      } else if (text) {
        const parsed = parseLocationText(text);
        if (parsed.location) {
          site = new LocationDto({ ...parsed.location, text });
        }
      }
      if (!site) continue;
      const key = [site.city, site.state, site.country, site.text]
        .filter((part): part is string => typeof part === 'string')
        .join('|')
        .toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      sites.push(site);
    }
    return sites;
  }

  /**
   * Build a CompensationDto from the structured `payGradeRange`. The pay period
   * is not in `payGradeRange`, so it is read from the human-readable
   * "SalaryRange" custom field when present (e.g. "... (USD) Annually").
   */
  private extractCompensation(
    job: AdpJob,
    detail: AdpJob | null,
  ): CompensationDto | null {
    const range = job.payGradeRange ?? detail?.payGradeRange ?? null;
    const minAmount = range?.minimumRate?.amountValue ?? null;
    const maxAmount = range?.maximumRate?.amountValue ?? null;
    if (minAmount == null && maxAmount == null) return null;

    const currency =
      range?.minimumRate?.currencyCode ??
      range?.maximumRate?.currencyCode ??
      undefined;
    const interval = this.payInterval(job, detail);

    return new CompensationDto({
      minAmount,
      maxAmount,
      currency,
      ...(interval ? { interval } : {}),
    });
  }

  /**
   * Read the pay period from the "SalaryRange" custom field, if present. ADP
   * writes the period as an adverb ("... Annually" / "Hourly" / "Monthly"),
   * which is matched by stem here.
   */
  private payInterval(
    job: AdpJob,
    detail: AdpJob | null,
  ): CompensationInterval | null {
    const fields = [
      ...(job.customFieldGroup?.stringFields ?? []),
      ...(detail?.customFieldGroup?.stringFields ?? []),
    ];
    const salaryRange = fields.find(
      (field) => field?.nameCode?.codeValue === 'SalaryRange',
    )?.stringValue;
    if (!salaryRange) return null;

    const period = (salaryRange.trim().split(/\s+/).pop() ?? '').toLowerCase();
    if (/^(annual|year)/.test(period)) return CompensationInterval.YEARLY;
    if (/^month/.test(period)) return CompensationInterval.MONTHLY;
    if (/^week/.test(period)) return CompensationInterval.WEEKLY;
    if (/^(daily|day)/.test(period)) return CompensationInterval.DAILY;
    if (/^hour/.test(period)) return CompensationInterval.HOURLY;
    return null;
  }

  private formatDescription(
    html: string | null | undefined,
    format?: DescriptionFormat,
  ): string | null {
    if (!html || !html.trim()) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) {
      return markdownConverter(html) ?? html;
    }
    return htmlToPlainText(html);
  }
}
