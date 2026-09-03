import { SourcePlugin } from '@ever-jobs/plugin';

// OData access varies per company config; when it is not published, the Career
// Site Builder (CSB) reader harvests the public portal instead.
import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  DescriptionFormat,
  Site,
  classifyScrapeError,
  ScrapeDiagnostics,
} from '@ever-jobs/models';
import {
  createHttpClient,
  randomSleep,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  SF_HEADERS,
  SF_PAGE_SIZE,
  SF_DELAY_MIN,
  SF_DELAY_MAX,
  SF_CSB_PAGE_SIZE,
  SF_CSB_MAX_PAGES,
  SF_CSB_PAGE_CONCURRENCY,
  SF_CSB_DETAIL_CONCURRENCY,
  SF_CSB_JOB_LINK_RE,
  SF_CSB_DEFAULT_ORIGIN_TEMPLATES,
  parseSfSlug,
  buildSfODataUrl,
  buildSfCareerUrl,
  buildSfCsbTileUrl,
  buildSfCsbDefaultOrigin,
  resolveCsbBaseUrl,
  htmlLooksLikeCsb,
} from './successfactors.constants';
import {
  SfCsbDetail,
  SfCsbListItem,
  SfJobPosting,
  SfODataResponse,
} from './successfactors.types';

@SourcePlugin({
  site: Site.SUCCESSFACTORS,
  name: 'SuccessFactors',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SuccessFactorsService implements IScraper {
  private readonly logger = new Logger(SuccessFactorsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug?.trim();
    const csbBase = resolveCsbBaseUrl(input.companyUrl);

    if (!companySlug && !csbBase) {
      this.logger.warn(
        'No companySlug or companyUrl provided for SuccessFactors scraper',
      );
      return new JobResponseDto([]);
    }

    const slugHasColon = (companySlug ?? '').includes(':');
    const parsed = companySlug ? parseSfSlug(companySlug) : { instance: '', companyId: '' };
    let { instance, companyId } = parsed;
    const isBareSlug = !!companySlug && !slugHasColon;
    // A bare token is a companyId, not a SuccessFactors instance.
    if (isBareSlug) {
      instance = '';
    }

    const resultsWanted = input.resultsWanted ?? 100;
    const diags: ScrapeDiagnostics[] = [];

    // 1. OData API — structured and preferred, but only when an instance is
    //    known. A tenant that does not publish OData yields zero here (the
    //    request 404s / errors), which is the signal to try the next surface.
    if (instance) {
      const odataJobs = await this.scrapeOData(
        input,
        instance,
        companyId,
        resultsWanted,
        diags,
      );
      if (odataJobs.length > 0) {
        this.logger.log(
          `SuccessFactors OData returned ${odataJobs.length} jobs for ${instance}`,
        );
        return new JobResponseDto(odataJobs);
      }
    }

    // 2. Career Site Builder (CSB) portal — the public surface for tenants
    //    without open OData, typically on a custom domain.
    let effectiveCsbBase = csbBase;
    if (!effectiveCsbBase && isBareSlug && companyId) {
      effectiveCsbBase = await this.resolveDefaultCsbBase(
        input,
        companyId,
        diags,
      );
    }

    if (effectiveCsbBase) {
      this.logger.log(
        `SuccessFactors: reading Career Site Builder portal at ${effectiveCsbBase}`,
      );
      const csbJobs = await this.scrapeCsb(
        input,
        effectiveCsbBase,
        companyId,
        resultsWanted,
      );
      if (csbJobs.length > 0) {
        this.logger.log(
          `SuccessFactors CSB returned ${csbJobs.length} jobs for ${effectiveCsbBase}`,
        );
        return new JobResponseDto(csbJobs);
      }
    }

    // 3. Native careersection HTML — last-resort fallback (needs an instance).
    if (instance) {
      this.logger.log(
        'SuccessFactors: OData/CSB returned zero, falling back to careersection HTML',
      );
      // The careersection fallback decides the outcome, so it owns the reported
      // reason. Step 1's OData error is a routing signal — a tenant that does not
      // publish OData always errors there — and reporting it would name the
      // surface we deliberately moved on from instead of the one that failed.
      const htmlDiags: ScrapeDiagnostics[] = [];
      const htmlJobs = await this.scrapeHtml(
        input,
        instance,
        companyId,
        resultsWanted,
        htmlDiags,
      );
      return new JobResponseDto(
        htmlJobs,
        htmlJobs.length ? undefined : htmlDiags[0],
      );
    }

    // Bare slug with no verifiable CSB portal: return the diagnostic we
    // collected while probing default origins, or a generic bad_input one.
    if (isBareSlug) {
      return new JobResponseDto(
        [],
        diags[0] ??
          new ScrapeDiagnostics(
            'bad_input',
            `missing companyUrl: could not derive SuccessFactors CSB portal for ${companyId}`,
          ),
      );
    }

    return new JobResponseDto([], diags[0]);
  }

  /**
   * Probe the default SAP CSB origins for a bare companyId and return the first
   * origin whose root page passes the CSB fingerprint check.
   */
  private async resolveDefaultCsbBase(
    input: ScraperInputDto,
    companyId: string,
    diags: ScrapeDiagnostics[],
  ): Promise<string | null> {
    for (let i = 0; i < SF_CSB_DEFAULT_ORIGIN_TEMPLATES.length; i++) {
      const origin = buildSfCsbDefaultOrigin(companyId, i);
      if (!origin) continue;

      try {
        const html = await this.fetchCsbProbeHtml(origin, input);
        if (htmlLooksLikeCsb(html)) {
          return origin;
        }
      } catch (err: any) {
        this.logger.warn(
          `SuccessFactors default CSB probe failed for ${origin}: ${err.message}`,
        );
      }
    }

    const message = `missing companyUrl: could not derive SuccessFactors CSB portal for ${companyId}`;
    this.logger.warn(message);
    diags.push(new ScrapeDiagnostics('bad_input', message));
    return null;
  }

  /**
   * Fetch the root page of a candidate default CSB origin for verification.
   * Protected so tests can substitute captured HTML without network I/O.
   */
  protected async fetchCsbProbeHtml(
    base: string,
    input: ScraperInputDto,
  ): Promise<string> {
    return this.fetchCsbHtml(`${base.replace(/\/$/, '')}/`, input);
  }

  protected async scrapeOData(
    input: ScraperInputDto,
    instance: string,
    companyId: string,
    resultsWanted: number,
    diags: ScrapeDiagnostics[] = [],
  ): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(SF_HEADERS);

    const baseUrl = buildSfODataUrl(instance);
    const jobPosts: JobPostDto[] = [];
    let offset = 0;

    try {
      this.logger.log(`Fetching SuccessFactors OData jobs for ${instance} (company: ${companyId})`);

      while (jobPosts.length < resultsWanted) {
        const params = new URLSearchParams({
          $select:
            'jobReqId,jobTitle,jobDescription,locationObj,department,postingStartDate,jobType,employmentType,companyName,externalJobUrl',
          $top: String(SF_PAGE_SIZE),
          $skip: String(offset),
          $orderby: 'postingStartDate desc',
          $inlinecount: 'allpages',
          $format: 'json',
        });

        const url = `${baseUrl}?${params.toString()}`;
        const response = await client.get<any>(url);
        const data: SfODataResponse = response.data ?? {};
        const listings = data.d?.results ?? [];

        if (listings.length === 0) break;

        const totalCount = data.d?.__count ? parseInt(data.d.__count, 10) : undefined;
        this.logger.log(
          `SuccessFactors: fetched ${listings.length} jobs at offset ${offset} for ${instance}` +
            `${totalCount ? ` (total: ${totalCount})` : ''}`,
        );

        for (const listing of listings) {
          if (jobPosts.length >= resultsWanted) break;

          try {
            const post = this.processODataListing(listing, instance, companyId);
            if (post) {
              jobPosts.push(post);
            }
          } catch (err: any) {
            this.logger.warn(`Error processing SuccessFactors OData listing: ${err.message}`);
          }
        }

        offset += listings.length;

        // If we got less than page size, no more results
        if (listings.length < SF_PAGE_SIZE) break;

        // Respect rate limiting
        await randomSleep(SF_DELAY_MIN, SF_DELAY_MAX);
      }

      this.logger.log(`SuccessFactors OData total: ${jobPosts.length} jobs for ${instance}`);
    } catch (err: any) {
      this.logger.warn(`SuccessFactors OData request failed for ${instance}: ${err.message}`);
      diags.push(classifyScrapeError(err));
    }

    return jobPosts;
  }

  protected async scrapeHtml(
    input: ScraperInputDto,
    instance: string,
    companyId: string,
    resultsWanted: number,
    diags: ScrapeDiagnostics[] = [],
  ): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(SF_HEADERS);

    try {
      const careerUrl = buildSfCareerUrl(
        instance,
        companyId,
        input.searchTerm ?? undefined,
      );

      this.logger.log(`SuccessFactors HTML: fetching ${careerUrl}`);
      const response = await client.get<any>(careerUrl);
      const html = typeof response.data === 'string' ? response.data : '';

      const jobs = this.parseHtml(html, instance, companyId);

      if (jobs.length === 0) {
        this.logger.warn(
          'SuccessFactors HTML: zero jobs extracted -- selectors may need updating',
        );
      }

      this.logger.log(`SuccessFactors HTML: extracted ${jobs.length} jobs for ${instance}`);
      return jobs.slice(0, resultsWanted);
    } catch (err: any) {
      this.logger.error(`SuccessFactors HTML scrape failed for ${instance}: ${err.message}`);
      diags.push(classifyScrapeError(err));
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Career Site Builder (CSB / RMK) reader
  // -------------------------------------------------------------------------

  /**
   * Harvest a Career Site Builder portal: paginate the `tile-search-results`
   * list to enumerate job tiles, then fan out to each detail page and read the
   * schema.org `JobPosting` microdata.
   */
  private async scrapeCsb(
    input: ScraperInputDto,
    base: string,
    companyId: string,
    resultsWanted: number,
  ): Promise<JobPostDto[]> {
    const items = await this.collectCsbTiles(input, base, resultsWanted);
    if (items.length === 0) {
      this.logger.warn(
        `SuccessFactors CSB: no job tiles found at ${base} -- selectors may need updating`,
      );
      return [];
    }

    const selected = items.slice(0, resultsWanted);
    const detailMap = await this.fetchCsbDetails(selected, input);

    const jobs: JobPostDto[] = [];
    for (const item of selected) {
      try {
        const detail = detailMap.get(item.jobId) ?? null;
        jobs.push(this.toCsbJobPost(item, detail, companyId, input.descriptionFormat));
      } catch (err: any) {
        this.logger.warn(
          `SuccessFactors CSB: error processing job ${item.jobId}: ${err.message}`,
        );
      }
    }

    return jobs;
  }

  /** Walk CSB tile pages (startrow += page size) until empty, cap, or wanted.
   *  Pages are fetched in bounded concurrent batches to avoid the serial
   *  1.5–3 s `randomSleep` between each page.
   */
  private async collectCsbTiles(
    input: ScraperInputDto,
    base: string,
    resultsWanted: number,
  ): Promise<SfCsbListItem[]> {
    const items: SfCsbListItem[] = [];
    const seen = new Set<string>();
    let stop = false;
    let pageIndex = 0;

    while (!stop && pageIndex < SF_CSB_MAX_PAGES && items.length < resultsWanted) {
      const batchSize = Math.min(
        SF_CSB_PAGE_CONCURRENCY,
        SF_CSB_MAX_PAGES - pageIndex,
      );
      const startrows = Array.from(
        { length: batchSize },
        (_, i) => (pageIndex + i) * SF_CSB_PAGE_SIZE,
      );

      const settled = await Promise.allSettled(
        startrows.map((s) => this.fetchCsbTileHtml(base, s, input)),
      );

      for (let i = 0; i < settled.length; i++) {
        if (items.length >= resultsWanted) {
          stop = true;
          break;
        }

        const startrow = startrows[i];
        const res = settled[i];

        if (res.status === 'rejected') {
          this.logger.warn(
            `SuccessFactors CSB: tile fetch failed at startrow ${startrow}: ${res.reason?.message ?? res.reason}`,
          );
          stop = true;
          break;
        }

        const pageItems = this.parseCsbTiles(res.value, base);
        if (pageItems.length === 0) {
          stop = true;
          break;
        }

        let added = 0;
        for (const item of pageItems) {
          if (seen.has(item.jobId)) continue;
          seen.add(item.jobId);
          items.push(item);
          added += 1;
        }

        // No new ids on this page → end of list (guards against a portal that
        // clamps startrow and re-serves the first page).
        if (added === 0) {
          stop = true;
          break;
        }
      }

      pageIndex += batchSize;
    }

    return items.slice(0, resultsWanted);
  }

  /**
   * Parse job tiles from a CSB `tile-search-results` page. Each `/job/{slug}/{id}/`
   * anchor is one tile; de-duped by job id (first occurrence wins).
   */
  private parseCsbTiles(html: string, base: string): SfCsbListItem[] {
    const $ = cheerio.load(html);
    const items: SfCsbListItem[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      const match = SF_CSB_JOB_LINK_RE.exec(href);
      if (!match) return;

      const jobId = match[1];
      if (seen.has(jobId)) return;
      seen.add(jobId);

      const title = $(el).text().replace(/\s+/g, ' ').trim();
      items.push({
        jobId,
        title: title || `Job ${jobId}`,
        jobUrl: this.absoluteUrl(href, base),
      });
    });

    return items;
  }

  /**
   * Fan out to CSB detail pages in bounded batches, reading `JobPosting`
   * microdata. A failed/missing page just omits detail for that job.
   */
  private async fetchCsbDetails(
    items: SfCsbListItem[],
    input: ScraperInputDto,
  ): Promise<Map<string, SfCsbDetail>> {
    const result = new Map<string, SfCsbDetail>();

    for (let i = 0; i < items.length; i += SF_CSB_DETAIL_CONCURRENCY) {
      const batch = items.slice(i, i + SF_CSB_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (item) => {
          const html = await this.fetchCsbDetailHtml(item.jobUrl, input);
          return {
            jobId: item.jobId,
            data: html ? this.parseCsbDetail(html) : null,
          };
        }),
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value.data) {
          result.set(r.value.jobId, r.value.data);
        }
      }
    }

    return result;
  }

  /**
   * Extract schema.org `JobPosting` microdata from a CSB detail page. CSB emits
   * microdata (`itemprop=...`), not a JSON-LD block.
   */
  private parseCsbDetail(html: string): SfCsbDetail | null {
    const $ = cheerio.load(html);
    if ($('[itemtype*="JobPosting"]').length === 0) return null;

    const content = (prop: string): string | null => {
      const el = $(`[itemprop="${prop}"]`).first();
      if (!el.length) return null;
      const attr = el.attr('content');
      if (attr && attr.trim()) return attr.trim();
      const text = el.text().replace(/\s+/g, ' ').trim();
      return text || null;
    };

    const addr = (prop: string): string | null => {
      const el = $(`[itemprop="jobLocation"] [itemprop="address"] [itemprop="${prop}"]`).first();
      const v = el.attr('content') ?? el.text();
      const trimmed = (v ?? '').replace(/\s+/g, ' ').trim();
      return trimmed || null;
    };

    const descEl = $('[itemprop="description"]').first();
    const descriptionHtml = descEl.length ? (descEl.html() ?? null) : null;

    const detail: SfCsbDetail = {
      title: content('title'),
      descriptionHtml,
      datePosted: content('datePosted'),
      validThrough: content('validThrough'),
      hiringOrganization: content('hiringOrganization'),
      industry: content('industry'),
      city: addr('addressLocality'),
      state: addr('addressRegion'),
      country: addr('addressCountry'),
      postalCode: addr('postalCode'),
    };

    const hasAny = Object.values(detail).some((v) => v != null && v !== '');
    return hasAny ? detail : null;
  }

  /** Map a CSB tile + optional detail microdata to a JobPostDto. */
  private toCsbJobPost(
    item: SfCsbListItem,
    detail: SfCsbDetail | null,
    companyId: string,
    format?: DescriptionFormat,
  ): JobPostDto {
    const title = detail?.title || item.title;

    const locationParts = [detail?.city, detail?.state, detail?.country].filter(
      (p): p is string => !!p,
    );
    const location =
      locationParts.length > 0
        ? new LocationDto({
            city: detail?.city ?? undefined,
            state: detail?.state ?? undefined,
            country: detail?.country ?? undefined,
          })
        : null;

    const isRemote = locationParts
      .join(', ')
      .toLowerCase()
      .includes('remote');

    const datePosted = detail?.datePosted
      ? (() => {
          try {
            return toDateOnly(detail.datePosted);
          } catch {
            return detail.datePosted;
          }
        })()
      : null;

    const description = this.formatDescription(detail?.descriptionHtml ?? null, format);
    const emails = detail?.descriptionHtml
      ? extractEmails(detail.descriptionHtml)
      : null;

    return new JobPostDto({
      id: `sf-csb-${item.jobId}`,
      title,
      companyName: detail?.hiringOrganization || companyId || null,
      jobUrl: item.jobUrl,
      applyUrl: item.jobUrl,
      location,
      description,
      datePosted,
      isRemote,
      emails: emails && emails.length > 0 ? emails : null,
      jobFunction: detail?.industry ?? null,
      site: Site.SUCCESSFACTORS,
      atsId: item.jobId,
      atsType: 'successfactors',
    });
  }

  /** Convert the HTML job-ad body per `descriptionFormat`. */
  private formatDescription(
    html: string | null,
    format?: DescriptionFormat,
  ): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /** Resolve a possibly-relative CSB href against the portal origin. */
  private absoluteUrl(href: string, base: string): string {
    if (/^https?:\/\//i.test(href)) return href;
    try {
      return new URL(href, base).toString();
    } catch {
      return `${base.replace(/\/$/, '')}${href.startsWith('/') ? '' : '/'}${href}`;
    }
  }

  /**
   * Fetch a CSB tile-list page. Isolated (protected) so tests can substitute
   * captured HTML without network I/O.
   */
  protected async fetchCsbTileHtml(
    base: string,
    startrow: number,
    input: ScraperInputDto,
  ): Promise<string> {
    const url = buildSfCsbTileUrl(base, startrow, input.searchTerm ?? undefined);
    return this.fetchCsbHtml(url, input);
  }

  /**
   * Fetch a CSB detail page. Isolated (protected) so tests can substitute
   * captured HTML without network I/O.
   */
  protected async fetchCsbDetailHtml(
    url: string,
    input: ScraperInputDto,
  ): Promise<string> {
    return this.fetchCsbHtml(url, input);
  }

  /** Shared CSB HTTP GET → HTML string (CSB portals are plain server-rendered). */
  private async fetchCsbHtml(
    url: string,
    input: ScraperInputDto,
  ): Promise<string> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(SF_HEADERS);
    const response = await client.get<any>(url);
    return typeof response.data === 'string' ? response.data : '';
  }

  private processODataListing(
    listing: SfJobPosting,
    instance: string,
    companyId: string,
  ): JobPostDto | null {
    const title = listing.jobTitle ?? listing.formattedJobTitle;
    if (!title) return null;

    const jobReqId = listing.jobReqId ?? null;

    // Build job URL
    const jobUrl = listing.externalJobUrl
      ? listing.externalJobUrl
      : `https://${instance}.successfactors.com/career?company=${encodeURIComponent(companyId)}&jobId=${encodeURIComponent(jobReqId ?? '')}`;

    // Build location from locationObj
    const locObj = listing.locationObj;
    const locationParts: string[] = [];
    if (locObj?.city) locationParts.push(locObj.city);
    if (locObj?.state) locationParts.push(locObj.state);
    if (locObj?.country) locationParts.push(locObj.country);
    const locationStr = locationParts.length > 0 ? locationParts.join(', ') : null;

    const location = locationStr
      ? new LocationDto({ city: locObj?.city ?? locationStr, state: locObj?.state, country: locObj?.country })
      : null;

    // Remote detection
    const isRemote = locationStr?.toLowerCase().includes('remote') ?? false;

    // Date from postingStartDate
    const rawDate = listing.postingStartDate ?? null;
    const datePosted = rawDate
      ? (() => {
          try {
            return toDateOnly(rawDate);
          } catch {
            return rawDate;
          }
        })()
      : null;

    return new JobPostDto({
      id: `sf-${instance}-${jobReqId ?? title.replace(/\s+/g, '-').toLowerCase()}`,
      title,
      companyName: listing.companyName ?? companyId,
      jobUrl,
      location,
      datePosted,
      isRemote,
      site: Site.SUCCESSFACTORS,
      // ATS-specific fields
      atsId: jobReqId,
      atsType: 'successfactors',
      department: listing.department ?? null,
      employmentType: listing.employmentType ?? null,
    });
  }

  private parseHtml(
    html: string,
    instance: string,
    companyId: string,
  ): JobPostDto[] {
    const $ = cheerio.load(html);
    const jobs: JobPostDto[] = [];

    // SuccessFactors layouts vary per company; try multiple selectors
    const selectors = [
      '.jobResultItem',
      '.job-result',
      '[data-job-id]',
      'tr.jobRow',
    ];

    let cards: cheerio.Cheerio<any> | null = null;
    for (const sel of selectors) {
      const found = $(sel);
      if (found.length > 0) {
        cards = found;
        break;
      }
    }

    if (!cards || cards.length === 0) {
      return [];
    }

    cards.each((_, el) => {
      try {
        const card = $(el);

        // Extract title from link or heading
        const titleEl = card
          .find('a.jobTitle, h2 a, h3 a, a[href*="jobId"], a[href*="job"]')
          .first();
        const title =
          titleEl.text().trim() || card.find('a').first().text().trim();
        if (!title) return;

        // Extract URL
        let href =
          titleEl.attr('href') ?? card.find('a').first().attr('href') ?? '';
        if (href && !href.startsWith('http')) {
          href = `https://${instance}.successfactors.com${href}`;
        }

        // Extract job ID from URL or data attribute
        const dataJobId = card.attr('data-job-id') ?? null;
        const urlIdMatch = href.match(/jobId=([^&]+)/);
        const jobReqId = dataJobId ?? urlIdMatch?.[1] ?? null;

        const id = jobReqId
          ? `sf-${instance}-${jobReqId}`
          : `sf-${instance}-${Math.abs(this.hashCode(href || title))}`;

        // Extract location
        const locationStr =
          card.find('.jobLocation, .location, [class*="location"]').text().trim() || null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        const isRemote =
          locationStr?.toLowerCase().includes('remote') ?? false;

        // Extract date
        const dateStr =
          card.find('.jobDate, .date, [class*="date"]').text().trim() || null;
        const datePosted = dateStr
          ? (() => {
              try {
                return toDateOnly(dateStr);
              } catch {
                return dateStr;
              }
            })()
          : null;

        jobs.push(
          new JobPostDto({
            id,
            title,
            companyName: companyId,
            jobUrl: href || '',
            location,
            datePosted,
            isRemote,
            site: Site.SUCCESSFACTORS,
            atsId: jobReqId,
            atsType: 'successfactors',
          }),
        );
      } catch (err: any) {
        // Skip individual card parse errors
      }
    });

    return jobs;
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return hash;
  }
}
