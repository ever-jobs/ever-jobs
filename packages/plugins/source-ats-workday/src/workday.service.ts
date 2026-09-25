import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  Site,
  DescriptionFormat,
  ScrapeDiagnostics,
  classifyScrapeError,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  parseLocationList,
  regionNameFromCode,
  randomSleep,
  salaryToCompensation,
} from '@ever-jobs/common';
import {
  WORKDAY_HEADERS,
  WORKDAY_PAGE_SIZE,
  WORKDAY_DETAIL_CONCURRENCY,
  WORKDAY_DETAIL_DELAY_MIN_MS,
  WORKDAY_DETAIL_DELAY_MAX_MS,
  workdaySearchText,
  parseWorkdaySlug,
  buildWorkdayUrl,
  buildWorkdayDetailUrl,
  parseWorkdayPostedOn,
  workdayListingKey,
  workdayListingRequisitionId,
  normalizeWorkdayLocationLabel,
  splitWorkdayAdditionalLocations,
  workdayListingLocationLabel,
  workdayImpliedCountryCode,
  readAtsCountryOverlay,
  readWorkdayMaxDetailFetches,
  readWorkdayScrapeTimeBudgetMs,
  WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR,
  WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR,
} from './workday.constants';
import {
  WorkdayJobDetail,
  WorkdayJobListItem,
  WorkdaySearchResponse,
} from './workday.types';

/** Per-scrape enrichment and time limits (Spec 1736 T11). */
interface WorkdayScrapeBudget {
  /** Detail requests this scrape may make ({@link WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR}). */
  readonly maxDetailFetches: number;
  /** Configured time budget, ms; 0 = none ({@link WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR}). */
  readonly timeBudgetMs: number;
  /** Epoch ms after which no listing page or detail request is started. */
  readonly deadlineAt: number;
}

/** What detail enrichment did for one scrape. */
interface WorkdayDetailOutcome {
  /** One entry per listing, in order; null = returned at list level. */
  readonly details: Array<WorkdayJobDetail | null>;
  /** Detail requests made (fulfilled or failed). */
  readonly requested: number;
  /** Postings with a detail path left un-enriched by the detail cap. */
  readonly skippedByCap: number;
  /** Postings with a detail path left un-enriched because the time budget ran out. */
  readonly skippedByTime: number;
}

@SourcePlugin({
  site: Site.WORKDAY,
  name: 'Workday',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class WorkdayService implements IScraper {
  private readonly logger = new Logger(WorkdayService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Workday scraper');
      return new JobResponseDto([]);
    }

    const { company, wdNumber, site } = parseWorkdaySlug(companySlug);
    const apiUrl = buildWorkdayUrl(company, wdNumber, site);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(WORKDAY_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const listingsToEnrich: WorkdayJobListItem[] = [];
    const seenKeys = new Set<string>();
    let offset = 0;
    let boardTotal: number | undefined;
    // Spec 1736 T6: Workday filters by keyword server-side; list mode sends ''.
    const searchText = workdaySearchText(input.searchTerm);

    // Spec 1736 T11: bound what one board can cost. Read per scrape so an env
    // change needs no restart of the adapter's singleton.
    const timeBudgetMs = readWorkdayScrapeTimeBudgetMs();
    const budget: WorkdayScrapeBudget = {
      maxDetailFetches: readWorkdayMaxDetailFetches(),
      timeBudgetMs,
      deadlineAt: timeBudgetMs > 0 ? Date.now() + timeBudgetMs : Number.POSITIVE_INFINITY,
    };
    let listingCutShort = false;

    try {
      this.logger.log(
        `Fetching Workday jobs for ${company} (wd${wdNumber}/${site}), ` +
        `term=${searchText ? JSON.stringify(searchText) : '<none>'}, ` +
        `details<=${budget.maxDetailFetches}, ` +
        `budget=${timeBudgetMs > 0 ? `${timeBudgetMs}ms` : 'none'}`,
      );

      while (listingsToEnrich.length < resultsWanted) {
        const payload = {
          appliedFacets: {},
          limit: WORKDAY_PAGE_SIZE,
          offset,
          searchText,
        };

        const response = await client.post(apiUrl, payload);
        const data: WorkdaySearchResponse = response.data ?? {};
        const listings = data.jobPostings ?? [];

        if (listings.length === 0) break;
        if (typeof data.total === 'number' && data.total > 0) boardTotal = data.total;

        this.logger.log(
          `Workday: fetched ${listings.length} jobs at offset ${offset} for ${company}` +
          `${data.total ? ` (total: ${data.total})` : ''}`,
        );

        // Count distinct postings, not pushes: some tenants answer an out-of-range
        // offset by re-serving page 1, and re-serving the same page must never look
        // like progress toward resultsWanted.
        let added = 0;
        for (const listing of listings) {
          if (listingsToEnrich.length >= resultsWanted) break;
          const key = workdayListingKey(listing);
          if (key && seenKeys.has(key)) continue;
          if (key) seenKeys.add(key);
          listingsToEnrich.push(listing);
          added++;
        }

        const pageOffset = offset;
        offset += listings.length;

        if (added === 0) {
          this.logger.warn(
            `Workday: pagination not advancing for ${company} (wd${wdNumber}/${site}): ` +
            `page at offset ${pageOffset} returned ${listings.length} jobs, 0 new ` +
            `(server re-served an earlier page); stopping with ${listingsToEnrich.length} distinct jobs`,
          );
          break;
        }

        // If we got less than page size, no more results
        if (listings.length < WORKDAY_PAGE_SIZE) break;

        // A positive total ends paging before the first out-of-range request. Zero or
        // absent is not a count: a real page can report total 0 on some tenants.
        if (typeof data.total === 'number' && data.total > 0 && offset >= data.total) break;

        // Filled: no pause before a page that will never be requested.
        if (listingsToEnrich.length >= resultsWanted) break;

        // Spec 1736 T11: the time budget covers listing as well as enrichment.
        // Stop before paging on; what is listed so far is returned.
        if (Date.now() >= budget.deadlineAt) {
          listingCutShort = true;
          this.logger.warn(
            `Workday: time budget (${WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR}=${timeBudgetMs}) spent while listing ` +
            `${company} (wd${wdNumber}/${site}); stopping at ${listingsToEnrich.length} of ` +
            `${resultsWanted} wanted postings`,
          );
          break;
        }

        // Respect rate limiting
        await randomSleep(1000, 2000);
      }

    } catch (err: any) {
      this.logger.error(`Workday scrape error for ${company}: ${err.message}`);

      // The listing set is untrustworthy after a pagination failure, and enriching it
      // would spend one detail request per accumulated entry on it.
      return new JobResponseDto([], classifyScrapeError(err));
    }

    // A listing cut short by the time budget returned fewer postings than asked
    // for while the board had more: that is a partial result, and the caller
    // should be able to tell it apart from a small board.
    const diagnostics = listingCutShort
      ? new ScrapeDiagnostics(
          'partial',
          `time budget ${WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR}=${timeBudgetMs} spent while listing: ` +
          `${listingsToEnrich.length} of ${resultsWanted} wanted postings` +
          `${boardTotal !== undefined ? ` (board total ${boardTotal})` : ''}`,
        )
      : undefined;

    return this.buildResponse(
      client,
      listingsToEnrich,
      company,
      wdNumber,
      site,
      budget,
      input.descriptionFormat,
      diagnostics,
    );
  }

  private async buildResponse(
    client: ReturnType<typeof createHttpClient>,
    listings: WorkdayJobListItem[],
    company: string,
    wdNumber: string,
    site: string,
    budget: WorkdayScrapeBudget,
    format?: DescriptionFormat,
    diagnostics?: ScrapeDiagnostics,
  ): Promise<JobResponseDto> {
    // Second de-dup pass: enrichment must cost one request per distinct posting even
    // if pagination ever hands over repeats again.
    const seen = new Set<string>();
    const distinct = listings.filter((listing) => {
      const key = workdayListingKey(listing);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (distinct.length < listings.length) {
      this.logger.warn(
        `Workday: dropped ${listings.length - distinct.length} duplicate listings for ${company} before detail fetch`,
      );
    }

    const outcome = await this.fetchDetails(client, distinct, company, wdNumber, site, budget);
    const { details } = outcome;
    const jobPosts = distinct
      .map((listing, index) => {
        try {
          return this.processListing(
            listing,
            details[index] ?? null,
            company,
            wdNumber,
            site,
            format,
          );
        } catch (err: any) {
          this.logger.warn(`Error processing Workday listing: ${err.message}`);
          return null;
        }
      })
      .filter((post): post is JobPostDto => post !== null);

    // Un-enriched postings are by design (Spec 1736 T11), not a failure: the
    // job count is complete, only descriptions are missing, so no diagnostic.
    if (outcome.skippedByCap > 0) {
      this.logger.log(
        `Workday: enriched ${outcome.requested} postings for ${company} (wd${wdNumber}/${site}); ` +
        `${outcome.skippedByCap} more returned at list level without description ` +
        `(${WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR}=${budget.maxDetailFetches})`,
      );
    }
    if (outcome.skippedByTime > 0) {
      this.logger.warn(
        `Workday: time budget (${WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR}=${budget.timeBudgetMs}) spent after ` +
        `${outcome.requested} detail requests for ${company} (wd${wdNumber}/${site}); ` +
        `${outcome.skippedByTime} postings returned at list level without description`,
      );
    }

    this.logger.log(`Workday total: ${jobPosts.length} jobs for ${company}`);
    return new JobResponseDto(jobPosts, diagnostics);
  }

  /**
   * Enrich listings with their CXS detail, within the scrape's budget
   * (Spec 1736 T11): at most `maxDetailFetches` requests, the first postings
   * in list order (newest first in list mode, best match for a keyword), and
   * none started once `deadlineAt` has passed. Every other listing gets a null
   * detail and is returned at list level.
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    listings: WorkdayJobListItem[],
    company: string,
    wdNumber: string,
    site: string,
    budget: WorkdayScrapeBudget,
  ): Promise<WorkdayDetailOutcome> {
    const details: Array<WorkdayJobDetail | null> = listings.map(() => null);
    // A listing without a detail path makes no request, so it neither spends
    // the cap nor needs a pause.
    const withPath = listings.flatMap((listing, index) => (listing.externalPath ? [index] : []));
    const allowed = withPath.slice(0, budget.maxDetailFetches);
    const skippedByCap = withPath.length - allowed.length;
    let skippedByTime = 0;
    let requested = 0;
    let failed = 0;

    for (let position = 0; position < allowed.length; position += WORKDAY_DETAIL_CONCURRENCY) {
      // Checked before the pause, so a spent budget costs neither the pause
      // nor the request (at most one pause and one request run past it).
      if (Date.now() >= budget.deadlineAt) {
        skippedByTime = allowed.length - position;
        break;
      }
      const batch = allowed.slice(position, position + WORKDAY_DETAIL_CONCURRENCY);
      // Pace every detail request (Spec 1735 §4.6): a listing request or the
      // previous detail request always precedes it on the same host.
      await randomSleep(WORKDAY_DETAIL_DELAY_MIN_MS, WORKDAY_DETAIL_DELAY_MAX_MS);
      requested += batch.length;
      const settled = await Promise.allSettled(
        batch.map(async (index): Promise<WorkdayJobDetail | null> => {
          const url = buildWorkdayDetailUrl(company, wdNumber, site, listings[index].externalPath as string);
          const response = await client.get(url);
          return (response.data as WorkdayJobDetail | undefined) ?? null;
        }),
      );

      settled.forEach((result, batchIndex) => {
        const index = batch[batchIndex];
        if (result.status === 'fulfilled') {
          details[index] = result.value;
          return;
        }
        const listing = listings[index];
        failed++;
        this.logger.warn(
          `Workday detail failed for ${company} (wd${wdNumber}/${site}) ` +
          `${listing.externalPath ?? listing.title ?? 'unknown job'}: ${result.reason?.message ?? result.reason}`,
        );
      });
    }

    if (failed > 0) {
      this.logger.warn(
        `Workday: ${failed} of ${requested} detail requests failed for ${company} (wd${wdNumber}/${site})`,
      );
    }

    return { details, requested, skippedByCap, skippedByTime };
  }

  private processListing(
    listing: WorkdayJobListItem,
    detail: WorkdayJobDetail | null,
    company: string,
    wdNumber: string,
    site: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = listing.title;
    if (!title) return null;
    const info = detail?.jobPostingInfo;
    // Board-level on purpose (Spec 1736 T13): `hiringOrganization.name` is in
    // the detail response only, and past the detail cap most postings of a
    // large board are built without one. Naming a posting after it made the
    // same posting switch between a business unit ("Collins Aerospace",
    // "ModernaTX, Inc.") and the tenant as it crossed the cap, and
    // `companyName` is part of the dedup key. The company plugins re-stamp the
    // tenant to their display name.
    const companyName = company;

    // Extract job path for URL construction. The public posting URL is
    // `/{site}{externalPath}` — the shape of the detail response's `externalUrl`.
    // A list-level posting (Spec 1736 T11: past the detail cap or time budget)
    // is linked through this URL, so it must carry the career-site segment:
    // `https://{tenant}.wd{n}.myworkdayjobs.com/job/…` names no site at all.
    const externalPath = listing.externalPath ?? '';
    const summaryJobUrl = externalPath
      ? `https://${company}.wd${wdNumber}.myworkdayjobs.com/${site}${externalPath.startsWith('/') ? '' : '/'}${externalPath}`
      : `https://${company}.wd${wdNumber}.myworkdayjobs.com/en-US/${site}/details/${encodeURIComponent(title)}`;
    const jobUrl = info?.externalUrl ?? summaryJobUrl;

    const description = this.formatDescription(info?.jobDescription, format);

    // Location: route every label (primary + additional + summary) through the
    // shared parser so multi-location postings are split, then fold in the
    // requisition's ISO-2 country code when the parser left it bare (Spec 1689
    // overlay, default ON; EVER_JOBS_ATS_COUNTRY_OVERLAY=false keeps the code
    // in `countryCode` only).
    // `locationsText` is sometimes a bare "N Locations" count rather than a
    // place; drop it so the parser doesn't treat the count as a location.
    // Spec 1736 T13: the row's label, from `bulletFields` when the tenant
    // sends no `locationsText` (Moderna), so a list-level posting has the
    // place its enriched copy has.
    const summaryText = workdayListingLocationLabel(listing);
    // Spec 1736 T12: an `additionalLocations` entry without a location shape
    // is a department some tenants file there (Moderna: "Drug Manufacturing"),
    // not a second site; it becomes the department when there is none.
    const additional = splitWorkdayAdditionalLocations(info?.location, info?.additionalLocations);
    // Workday sometimes emits slugified location labels with underscores
    // (e.g. "Remote_USA"); the underscore is a word character that defeats the
    // shared parser's `\bremote\b` boundary check, so normalize "_" to spaces.
    const locationLabels = [
      info?.location,
      ...additional.locations,
      summaryText && !/^\d+\s+locations?$/i.test(summaryText) ? summaryText : null,
    ].map((label) => normalizeWorkdayLocationLabel(label));
    const parsedLocations = parseLocationList(locationLabels);
    const countryCode = info?.jobRequisitionLocation?.country?.alpha2Code;
    const overlayCountry = readAtsCountryOverlay();
    // Spec 1736 T13: with no requisition country (always so at list level), a
    // single site in a US state implies the United States — what the overlay
    // folds in for a US requisition — so both levels key the same place.
    const overlayCode =
      countryCode ??
      (parsedLocations.locations.length === 1
        ? workdayImpliedCountryCode(parsedLocations.locations[0])
        : null);
    const location = overlayCountry
      ? this.applyCountry(parsedLocations.location, overlayCode)
      : parsedLocations.location;
    const locations = overlayCountry
      ? this.applyCountryToSingleSite(parsedLocations.locations, overlayCode)
      : parsedLocations.locations;

    // Remote detection: Workday's remoteType enum, plus the parsed labels.
    const remoteType = [info?.remoteType, listing.remoteType]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const isRemote =
      remoteType.includes('remote') || parsedLocations.remoteMentioned;

    // workFromHomeType: prefer Workday's structured remoteType, else parsed labels.
    const workFromHomeType =
      this.workFromHomeTypeFromRemoteType(info?.remoteType ?? listing.remoteType) ??
      parsedLocations.workFromHomeType;

    // Date: prefer the absolute startDate (drift-free), fall back to the
    // relative postedOn label. Both go through the validated ISO/relative parser,
    // so datePosted is always an absolute calendar date (or null). A list-level
    // posting has only the row's label, resolved at scrape time; "Posted 30+
    // Days Ago" stays null rather than inventing a date (Spec 1736 §8.1).
    const datePosted =
      parseWorkdayPostedOn(info?.startDate) ??
      parseWorkdayPostedOn(info?.postedOn ?? listing.postedOn);

    // Compensation: Workday CXS has no structured pay field; recover the
    // pay-transparency range from the description body text.
    const compensation = this.extractCompensationFromText(info?.jobDescription);

    // Extract subtitle info (often contains category/department)
    const subtitleTexts = listing.subtitles
      ?.flatMap((sub) => sub.instances?.map((i) => i.text) ?? [])
      .filter(Boolean) ?? [];

    // Extract job ID from externalPath (e.g., "/job/123456")
    // Without a detail response (Spec 1736 T11: past the detail cap or time
    // budget, or a failed request) the list row's requisition id keeps the
    // posting on the id an enriched copy would get; the whole path is last.
    const jobIdMatch = externalPath.match(/\/(\d+)(?:\/|$)/);
    const atsId =
      info?.jobReqId ??
      jobIdMatch?.[1] ??
      workdayListingRequisitionId(listing) ??
      (externalPath || null);

    return new JobPostDto({
      id: `wd-${company}-${atsId ?? title.replace(/\s+/g, '-').toLowerCase()}`,
      title,
      companyName,
      jobUrl,
      location,
      ...(locations.length > 0 ? { locations } : {}),
      description,
      compensation,
      datePosted,
      emails: extractEmails(description),
      isRemote,
      ...(workFromHomeType ? { workFromHomeType } : {}),
      site: Site.WORKDAY,
      // ATS-specific fields
      countryCode: countryCode ?? null,
      atsId,
      atsType: 'workday',
      department: info?.jobFamily?.[0]?.name ?? subtitleTexts[0] ?? additional.rejected[0] ?? null,
      employmentType: info?.timeType ?? info?.workerSubType ?? null,
    });
  }

  private formatDescription(
    html?: string | null,
    format?: DescriptionFormat,
  ): string | null {
    if (!html?.trim()) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html);
    return htmlToPlainText(html);
  }

  /**
   * Fold the requisition's ISO-2 country code into the parsed location when the
   * parser did not already derive a country. Uses the runtime CLDR table via
   * `regionNameFromCode`, mirroring the Lever pass; an unresolvable code leaves
   * the location untouched. Restored by Spec 1689 after Spec 5118 removed it —
   * gated by `EVER_JOBS_ATS_COUNTRY_OVERLAY`.
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

  /**
   * Apply {@link applyCountry} to a single-site `locations[]` so it agrees with
   * `location`. The requisition country describes the primary site only, so a
   * multi-site list is left as parsed.
   */
  private applyCountryToSingleSite(
    locations: LocationDto[],
    countryCode: string | null | undefined,
  ): LocationDto[] {
    if (locations.length !== 1) return locations;
    return [this.applyCountry(locations[0], countryCode) ?? locations[0]];
  }

  /**
   * Map Workday's free-text `remoteType` ("Hybrid", "Fully Remote",
   * "Remote Eligible", "Field/Customer Site") to a work-from-home label.
   * On-site values (e.g. "Field/Customer Site") resolve to null.
   */
  private workFromHomeTypeFromRemoteType(
    remoteType: string | null | undefined,
  ): string | null {
    const value = remoteType?.toLowerCase() ?? '';
    if (value.includes('hybrid')) return 'Hybrid';
    if (value.includes('remote')) return 'Remote';
    return null;
  }

  /**
   * Workday CXS exposes no structured pay field, so recover a pay-transparency
   * salary range from the description body text via the shared `extractSalary`,
   * honoring the real interval (yearly/hourly) rather than coercing.
   */
  private extractCompensationFromText(
    html?: string | null,
  ): CompensationDto | null {
    const text = html?.trim() ? htmlToPlainText(html) : null;
    return salaryToCompensation(text);
  }
}
