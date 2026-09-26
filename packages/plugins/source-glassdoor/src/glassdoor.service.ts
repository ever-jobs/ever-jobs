import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto,
  DescriptionFormat, Country, Site, getGlassdoorUrl, LocationDto,
} from '@ever-jobs/models';
import {
  createHttpClient, GlassdoorException, markdownConverter, plainConverter,
  extractEmails, randomSleep,
  parseLocationList, postedFromAgeInDays, postedTimeFields,
} from '@ever-jobs/common';
import {
  GLASSDOOR_HEADERS, FALLBACK_CSRF_TOKEN, GD_JOB_SEARCH_QUERY,
  GLASSDOOR_DEFAULT_RESULTS, GLASSDOOR_FALLBACK_CURRENCY, GLASSDOOR_PAGE_SIZE,
  LOCATION_POST_FILTER_NOTE, NO_CSRF_TOKEN_NOTE,
  GlassdoorRunOptions, readGlassdoorOptions,
} from './glassdoor.constants';
import {
  parseCompensation, getCursorForPage,
  buildHeaders, canonicalJobUrl, challengeDetail, companyRatingOf, companyUrlOf,
  extractCsrfToken, glassdoorUrl, graphErrorDetail, GraphCursor, headerJobUrl,
  isChallengePage, isRemoteListing, listingIdOf, listingTypeOf, matchesRequestedLocation,
  mergeCursors, readGraphBody, requestedLocationOf,
} from './glassdoor.utils';

/** Everything one run needs to map a listing, resolved once per scrape. */
interface MappingContext {
  input: ScraperInputDto;
  country: Country;
  baseUrl: string;
  options: GlassdoorRunOptions;
  fetchedAt: number;
}

@SourcePlugin({
  site: Site.GLASSDOOR,
  name: 'Glassdoor',
  category: 'job-board',
  // Spec 1700 — the plugin keeps 5 s or more between pages (`delay` below);
  // hold location calls to the same floor.
  minRequestIntervalMs: 5000,
})
@Injectable()
export class GlassdoorService implements IScraper {
  private readonly logger = new Logger(GlassdoorService.name);
  private readonly delay = 5;
  private readonly bandDelay = 5;

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const options = readGlassdoorOptions();
    const legacy = options.legacy;
    const country = input.country ?? Country.USA;

    let baseUrl: string;
    try {
      baseUrl = getGlassdoorUrl(country);
    } catch (err: any) {
      // A country with no Glassdoor domain used to throw out of scrape().
      return new JobResponseDto([], new ScrapeDiagnostics('bad_input', String(err?.message ?? err)));
    }

    const client = createHttpClient(input);
    const legacyHeaders = legacy.has('headers');
    if (legacyHeaders) client.setHeaders(GLASSDOOR_HEADERS);
    const clientHints = !input.userAgent;

    // Fetch the CSRF token from the homepage. A challenged homepage ends the
    // run here: the search endpoint sits behind the same edge, so posting to it
    // would be one more request that cannot succeed.
    let csrfToken = FALLBACK_CSRF_TOKEN;
    let tokenExtracted = false;
    try {
      const homeResp = legacyHeaders
        ? await client.get(baseUrl)
        : await client.get(baseUrl, { headers: buildHeaders(baseUrl, 'document') });
      if (!legacy.has('challenge') && isChallengePage(homeResp?.data, homeResp?.headers)) {
        const detail = challengeDetail('homepage', homeResp?.status, homeResp?.headers);
        this.logger.warn(`Glassdoor ${detail}; not sending the search request`);
        return new JobResponseDto([], new ScrapeDiagnostics('blocked', detail));
      }
      const token = extractCsrfToken(homeResp?.data);
      if (token) {
        csrfToken = token;
        tokenExtracted = true;
      } else {
        this.logger.warn('Glassdoor: no CSRF token on the homepage; using the fallback token');
      }
    } catch (err: any) {
      const res = err?.response;
      if (!legacy.has('challenge') && res && isChallengePage(res.data, res.headers)) {
        const detail = challengeDetail('homepage', res.status, res.headers);
        this.logger.warn(`Glassdoor ${detail}; not sending the search request`);
        return new JobResponseDto([], new ScrapeDiagnostics('blocked', detail));
      }
      this.logger.warn(`Could not fetch Glassdoor CSRF token: ${err?.message}`);
    }

    // A later 403 is easier to explain when the run is known to have sent the fallback token.
    const withTokenNote = (diag: ScrapeDiagnostics): ScrapeDiagnostics =>
      tokenExtracted
        ? diag
        : new ScrapeDiagnostics(diag.reason, `${diag.detail ?? ''} ${NO_CSRF_TOKEN_NOTE}`.trim());

    const jobList: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;

    // Bounded pagination: at most `maxPages` pages, and never more than one
    // page past what `offset + resultsWanted` needs.
    const maxRows = options.maxPages * GLASSDOOR_PAGE_SIZE;
    const resultsWanted = Math.max(0, Math.min(input.resultsWanted ?? GLASSDOOR_DEFAULT_RESULTS, maxRows));
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const pageBudget = Math.min(
      options.maxPages,
      Math.ceil((offset + resultsWanted) / GLASSDOOR_PAGE_SIZE) + 1,
    );

    const requestedLocation = legacy.has('location-filter') ? null : requestedLocationOf(input.location);
    if (requestedLocation) this.logger.debug(LOCATION_POST_FILTER_NOTE);
    let filteredOut = 0;
    let skipped = 0;

    let paginationCursors: GraphCursor[] = [];
    const seenIds = new Set<string>();

    for (let page = 1; page <= pageBudget && jobList.length < resultsWanted; page++) {
      const cursor = page === 1 ? null : getCursorForPage(paginationCursors, page);
      if (page > 1 && !cursor) {
        // Without a cursor the request would silently return page 1 again.
        this.logger.debug(`Glassdoor: no cursor for page ${page}; stopping`);
        break;
      }

      this.logger.log(`Fetching Glassdoor jobs, page ${page}`);

      try {
        const variables: any = {
          keyword: input.searchTerm ?? '',
          numPerPage: GLASSDOOR_PAGE_SIZE,
          seoUrl: false,
        };
        if (cursor) variables.pageCursor = cursor;

        const filterParams: any[] = [];
        if (input.isRemote) filterParams.push({ filterKey: 'remoteWorkType', values: '1' });
        if (input.hoursOld) {
          const days = Math.ceil(input.hoursOld / 24);
          filterParams.push({ filterKey: 'fromAge', values: String(days) });
        }
        if (filterParams.length > 0) variables.filterParams = filterParams;

        const requestHeaders = legacyHeaders
          ? { 'gd-csrf-token': csrfToken }
          : { ...buildHeaders(baseUrl, 'api', { clientHints }), 'gd-csrf-token': csrfToken };

        let response: any;
        try {
          response = await client.post(glassdoorUrl('graph', baseUrl), {
            operationName: 'JobSearchQuery',
            query: GD_JOB_SEARCH_QUERY,
            variables,
          }, {
            headers: requestHeaders,
          });
        } catch (err: any) {
          const res = err?.response;
          diagnostics = withTokenNote(
            res && isChallengePage(res.data, res.headers)
              ? new ScrapeDiagnostics('blocked', challengeDetail('search', res.status, res.headers))
              : classifyScrapeError(err),
          );
          this.logger.error(`Glassdoor scrape error: ${err?.message}`);
          break;
        }
        const fetchedAt = Date.now();

        const body = readGraphBody(response?.data, response?.headers);
        if (body.listings === null) {
          if (body.challenge) {
            const detail = challengeDetail('search', response?.status, response?.headers);
            diagnostics = new ScrapeDiagnostics('blocked', detail);
          } else if (body.errors.length > 0) {
            diagnostics = new ScrapeDiagnostics('fetch_error', graphErrorDetail(body.errors));
          } else {
            const detail = body.nonJson ? 'graphql: non-JSON body' : 'graphql: empty body';
            diagnostics = new ScrapeDiagnostics('unknown', detail);
          }
          diagnostics = withTokenNote(diagnostics);
          this.logger.warn(`Glassdoor search page ${page}: ${diagnostics.detail}`);
          break;
        }

        paginationCursors = mergeCursors(paginationCursors, body.cursors);
        if (body.listings.length === 0) break;

        const context: MappingContext = { input, country, baseUrl, options, fetchedAt };
        let newIds = 0;
        for (const listing of body.listings) {
          if (jobList.length >= resultsWanted) break;
          const jobview = listing?.jobview;
          if (!jobview?.header) continue;

          const jobId = this.jobIdOf(jobview, legacy.has('ids'));
          if (!jobId || seenIds.has(jobId)) continue;
          seenIds.add(jobId);
          newIds++;

          const { job, rowRemote } = this.toJobPost(jobview, jobId, context);
          if (requestedLocation && !this.keepForLocation(job, rowRemote, requestedLocation, context)) {
            filteredOut++;
            continue;
          }
          if (skipped < offset) {
            skipped++;
            continue;
          }
          jobList.push(job);
        }

        if (newIds === 0) {
          // Every row was already seen: the cursor led back to rows we have.
          this.logger.debug(`Glassdoor: page ${page} added no new listings; stopping`);
          break;
        }

        // Sleep only when another request will actually follow.
        if (
          page < pageBudget &&
          jobList.length < resultsWanted &&
          getCursorForPage(paginationCursors, page + 1)
        ) {
          await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
        }
      } catch (err: any) {
        this.logger.error(`Glassdoor scrape error: ${err?.message}`);
        diagnostics = withTokenNote(classifyScrapeError(err));
        break;
      }
    }

    if (!diagnostics && jobList.length === 0 && filteredOut > 0) {
      diagnostics = new ScrapeDiagnostics(
        'empty',
        `location post-filter kept 0 of ${filteredOut} rows (site-side scoping unavailable)`,
      );
    }

    return new JobResponseDto(jobList, diagnostics);
  }

  /** `gd-<listingId>`; in the `ids` legacy mode `gd-<adOrderId ?? listingId>`. */
  private jobIdOf(jobview: any, legacyIds: boolean): string | null {
    if (legacyIds) return `gd-${jobview.header.adOrderId ?? jobview.job?.listingId}`;
    const listingId = listingIdOf(jobview);
    return listingId ? `gd-${listingId}` : null;
  }

  /**
   * Map one listing. `rowRemote` is the listing's own remote signal (its text,
   * or the site's Remote pseudo-location), before `input.isRemote` is applied.
   */
  private toJobPost(jobview: any, jobId: string, ctx: MappingContext): { job: JobPostDto; rowRemote: boolean } {
    const { input, baseUrl, options } = ctx;
    const legacy = options.legacy;
    const header = jobview.header;
    const jobData = jobview.job;
    const overview = jobview.overview;

    let jobUrl: string;
    if (legacy.has('job-url')) {
      const link = header.seoJobLink ?? header.jobLink ?? '';
      jobUrl = link.startsWith('http') ? link : `${baseUrl}${link.replace(/^\//, '')}`;
    } else {
      const listingId = listingIdOf(jobview);
      jobUrl = listingId ? canonicalJobUrl(listingId, baseUrl) : headerJobUrl(header, baseUrl);
    }

    let description = jobData?.descriptionFragments?.join('\n') ?? null;
    if (description) {
      if (input.descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      } else if (input.descriptionFormat === DescriptionFormat.PLAIN) {
        description = plainConverter(description) ?? description;
      }
    }

    const fallbackCurrency = legacy.has('currency')
      ? 'USD'
      : GLASSDOOR_FALLBACK_CURRENCY[ctx.country] ?? 'USD';
    const compensation = parseCompensation(header, fallbackCurrency);

    const parsed = parseLocationList([typeof header.locationName === 'string' ? header.locationName : '']);
    const location = parsed.location ?? new LocationDto({});

    const rowRemote = isRemoteListing(header, parsed.remoteMentioned);
    const isRemote = legacy.has('remote')
      ? header.locationType === 'S' || false
      : rowRemote || input.isRemote === true;

    const listingType = legacy.has('listing-type')
      ? (header.sponsored ? 'sponsored' : null)
      : listingTypeOf(header);

    const job = new JobPostDto({
      id: jobId,
      title: header.jobTitleText ?? jobData?.jobTitleText ?? 'N/A',
      companyName: header.employerNameFromSearch ?? overview?.shortName ?? null,
      companyUrl: companyUrlOf(header, baseUrl),
      jobUrl,
      location,
      ...(parsed.locations.length > 0 ? { locations: parsed.locations } : {}),
      ...(parsed.workFromHomeType ? { workFromHomeType: parsed.workFromHomeType } : {}),
      compensation,
      ...postedTimeFields(postedFromAgeInDays(header.ageInDays, ctx.fetchedAt)),
      isRemote,
      description,
      emails: extractEmails(description),
      companyLogo: overview?.squareLogoUrl ?? null,
      companyRating: companyRatingOf(header),
      listingType,
      site: Site.GLASSDOOR,
    });
    return { job, rowRemote };
  }

  /**
   * Location post-filter: the site-side location scoping needs a lookup
   * endpoint we do not call, so rows are matched after the fact. A row that is
   * remote by itself is kept regardless of location only when the caller asked
   * for remote jobs; otherwise it must match like any other row.
   */
  private keepForLocation(
    job: JobPostDto,
    rowRemote: boolean,
    requested: LocationDto,
    ctx: MappingContext,
  ): boolean {
    if (rowRemote && ctx.input.isRemote === true) return true;
    const candidates = job.locations?.length ? job.locations : [job.location];
    return candidates.some((loc) => matchesRequestedLocation(loc, requested, ctx.country));
  }
}
