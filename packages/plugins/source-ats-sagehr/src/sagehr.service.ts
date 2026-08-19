import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  randomSleep,
} from '@ever-jobs/common';
import {
  SAGEHR_HOST,
  SAGEHR_LISTING_PATH_TEMPLATE,
  SAGEHR_JOB_PATH_TEMPLATE,
  SAGEHR_JOB_ID_REGEX,
  SAGEHR_UUID_REGEX,
  SAGEHR_JOB_CARD_SELECTOR,
  SAGEHR_JOB_TITLE_SELECTOR,
  SAGEHR_JOB_LOCATION_SELECTOR,
  SAGEHR_COMPANY_HEADING_SELECTOR,
  SAGEHR_DETAIL_TITLE_SELECTOR,
  SAGEHR_DETAIL_CHIPS_SELECTOR,
  SAGEHR_DETAIL_LOCATION_CHIP_SELECTOR,
  SAGEHR_DETAIL_LOGO_SELECTOR,
  SAGEHR_DETAIL_BLOCK_SELECTOR,
  SAGEHR_MAX_CONCURRENCY,
  SAGEHR_REQUEST_DELAY_MS,
  SAGEHR_DEFAULT_RESULTS,
  SAGEHR_HEADERS,
} from './sagehr.constants';
import { SageHrListingItem, SageHrDetail, SageHrJob } from './sagehr.types';

/**
 * Sage HR (sage.hr) careers scraper — generic, multi-tenant.
 *
 * Sage HR (formerly CakeHR) is a UK / global cloud HR + ATS suite. Every
 * customer publishes a public, anonymous candidate careers site on the shared
 * recruitment host `talent.sage.hr`, addressed by the tenant's career site
 * UUID:
 *
 *   GET https://talent.sage.hr/{careerSiteId}/vacancies
 *
 * No anonymous JSON feed is exposed (the structured `/api/recruitment/positions`
 * endpoint requires an `X-Auth-Token`), so this adapter scrapes the
 * server-rendered HTML:
 *
 *   1. Fetches the vacancies listing page and parses each `<div class="job">`
 *      card to extract the position UUID, title, detail URL, and free-text
 *      location. The tenant display name is read from the page `<h1>`.
 *   2. Fan-outs (bounded `Promise.allSettled`) to each `/jobs/{positionId}`
 *      detail page to enrich a row with the employment-type chip, structured
 *      location chip, company name (logo `alt`), and the full HTML description.
 *
 * Tenant resolution: `companySlug` (the career site UUID) is preferred;
 * otherwise the UUID is derived from a `companyUrl` (its `/{careerSiteId}/...`
 * path segment, or any UUID present in the URL).
 *
 * A missing tenant, an HTTP error, or a malformed payload degrades to an
 * empty/partial result — never throws — so a single tenant never aborts a
 * batch run. De-duplication is by position id within the run.
 */
@SourcePlugin({
  site: Site.SAGEHR,
  name: 'Sage HR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SageHrService implements IScraper {
  private readonly logger = new Logger(SageHrService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Sage HR scraper');
      return new JobResponseDto([]);
    }

    const careerSiteId = this.resolveCareerSiteId(input.companySlug, input.companyUrl);
    if (!careerSiteId) {
      this.logger.warn('Could not resolve a Sage HR career site id from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(SAGEHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? SAGEHR_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Sage HR vacancies for career site: ${careerSiteId}`);

      const listing = await this.fetchListing(client, careerSiteId);
      if (!listing) {
        this.logger.warn(`Sage HR: no listing returned for ${careerSiteId}`);
        return new JobResponseDto([]);
      }

      const fallbackCompanyName =
        listing.companyName || this.deriveCompanyName(input.companySlug, careerSiteId);

      this.logger.log(
        `Sage HR listing parsed: ${listing.items.length} cards for ${careerSiteId}`,
      );

      // De-dupe listing rows by position id and cap to resultsWanted before fan-out.
      const wantedItems: SageHrListingItem[] = [];
      for (const item of listing.items) {
        const id = item.positionId ?? '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        wantedItems.push(item);
        if (wantedItems.length >= resultsWanted) break;
      }

      // Bounded concurrent fan-out over detail pages for enrichment.
      for (let i = 0; i < wantedItems.length; i += SAGEHR_MAX_CONCURRENCY) {
        const chunk = wantedItems.slice(i, i + SAGEHR_MAX_CONCURRENCY);
        const settled = await Promise.allSettled(
          chunk.map((item) => this.fetchDetail(client, item)),
        );

        for (let j = 0; j < chunk.length; j += 1) {
          const item = chunk[j];
          const result = settled[j];
          let detail: SageHrDetail | null = null;
          if (result.status === 'fulfilled') {
            detail = result.value;
          } else {
            this.logger.warn(
              `Sage HR detail fetch failed for position ${item.positionId}: ` +
                `${result.reason?.message ?? result.reason}`,
            );
          }

          try {
            const post = this.mapToJobPost(
              { ...item, detail },
              fallbackCompanyName,
              input.descriptionFormat,
            );
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(
              `Sage HR: error mapping position ${item.positionId}: ${err.message}`,
            );
          }
        }

        if (i + SAGEHR_MAX_CONCURRENCY < wantedItems.length) {
          await randomSleep(SAGEHR_REQUEST_DELAY_MS, SAGEHR_REQUEST_DELAY_MS * 2);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Sage HR total: ${trimmed.length} jobs for ${careerSiteId}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Sage HR scrape error for ${careerSiteId}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Fetch and parse the public vacancies listing page. Returns null when the
   * tenant is unknown (HTTP 4xx) or the body is empty.
   */
  private async fetchListing(
    client: ReturnType<typeof createHttpClient>,
    careerSiteId: string,
  ): Promise<{ items: SageHrListingItem[]; companyName: string | null } | null> {
    const path = SAGEHR_LISTING_PATH_TEMPLATE.replace(
      '{careerSiteId}',
      encodeURIComponent(careerSiteId),
    );
    const url = `${SAGEHR_HOST}${path}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html =
        typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (!html) return null;
      return this.parseListing(html);
    } catch (err: any) {
      // An unknown / dead career site returns HTTP 404 (or 400/403 from the CDN);
      // treat that as "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status === 400 || status === 403 || status === 404) {
        this.logger.warn(`Sage HR career site not found (HTTP ${status}) for ${careerSiteId}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse the listing HTML into job rows. Extracts the tenant display name from
   * the page `<h1>` and one {@link SageHrListingItem} per `<div class="job">`
   * card (skipping cards that carry no `/jobs/{positionId}` anchor).
   */
  private parseListing(html: string): {
    items: SageHrListingItem[];
    companyName: string | null;
  } {
    const $ = cheerio.load(html);
    const items: SageHrListingItem[] = [];

    const companyName = this.cleanCompanyName(
      $(SAGEHR_COMPANY_HEADING_SELECTOR).first().text(),
    );

    $(SAGEHR_JOB_CARD_SELECTOR).each((_i, card) => {
      try {
        const item = this.parseJobCard($, card);
        if (item) items.push(item);
      } catch (err: any) {
        this.logger.warn(`Sage HR: error parsing job card: ${err.message}`);
      }
    });

    return { items, companyName };
  }

  /** Parse a single `<div class="job">` card into a listing item. */
  private parseJobCard($: cheerio.CheerioAPI, card: any): SageHrListingItem | null {
    const $card = $(card);

    const anchor = $card.find(SAGEHR_JOB_TITLE_SELECTOR).first();
    let detailUrl = anchor.attr('href')?.trim() || null;
    if (!detailUrl) return null;

    // Normalise to an absolute URL.
    if (!/^https?:\/\//i.test(detailUrl)) {
      detailUrl = detailUrl.startsWith('/')
        ? `${SAGEHR_HOST}${detailUrl}`
        : `${SAGEHR_HOST}/${detailUrl}`;
    }

    const positionId = this.extractPositionId(detailUrl);
    if (!positionId) return null;

    const title = anchor.text().trim() || null;
    if (!title) return null;

    const location = $card.find(SAGEHR_JOB_LOCATION_SELECTOR).first().text().trim() || null;

    return { positionId, title, detailUrl, location };
  }

  /**
   * Fetch a position detail page and extract its enrichment fields (employment
   * type, location chip, company name, full description). Returns null on error
   * or empty body — the listing row alone is enough to emit a JobPostDto.
   */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    item: SageHrListingItem,
  ): Promise<SageHrDetail | null> {
    const url = item.detailUrl;
    if (!url) return null;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html =
        typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (!html) return null;
      return this.parseDetail(html);
    } catch (err: any) {
      this.logger.warn(`Sage HR: detail page fetch failed for ${url}: ${err.message}`);
      return null;
    }
  }

  /** Parse a position detail page into a {@link SageHrDetail} enrichment record. */
  private parseDetail(html: string): SageHrDetail {
    const $ = cheerio.load(html);

    const title = $(SAGEHR_DETAIL_TITLE_SELECTOR).first().text().trim() || null;
    const companyName =
      $(SAGEHR_DETAIL_LOGO_SELECTOR).first().attr('alt')?.trim() || null;
    const locationChip =
      $(SAGEHR_DETAIL_LOCATION_CHIP_SELECTOR).first().text().trim() || null;

    // The first non-location chip in the with-ticks list is the employment type.
    let employmentType: string | null = null;
    $(SAGEHR_DETAIL_CHIPS_SELECTOR).each((_i, li) => {
      if (employmentType) return;
      const $li = $(li);
      if ($li.hasClass('globe-tick')) return;
      const text = $li.text().trim();
      if (text) employmentType = text;
    });

    const blocks: string[] = [];
    $(SAGEHR_DETAIL_BLOCK_SELECTOR).each((_i, block) => {
      const inner = $(block).html();
      if (inner && inner.trim()) blocks.push(inner.trim());
    });
    const descriptionHtml = blocks.length > 0 ? blocks.join('\n') : null;

    return { title, companyName, employmentType, locationChip, descriptionHtml };
  }

  /** Map a merged listing row + detail enrichment into a JobPostDto. */
  private mapToJobPost(
    job: SageHrJob,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const detail = job.detail ?? null;

    const title = (detail?.title || job.title || '').trim();
    if (!title) return null;

    const atsId = (job.positionId ?? '').trim();
    if (!atsId) return null;

    const jobUrl =
      job.detailUrl ?? `${SAGEHR_HOST}${SAGEHR_JOB_PATH_TEMPLATE.replace('{positionId}', atsId)}`;

    const rawDescription = detail?.descriptionHtml ?? null;
    let description: string | null = null;
    if (rawDescription) {
      if (format === DescriptionFormat.HTML) {
        description = rawDescription;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawDescription) ?? rawDescription;
      } else {
        description = htmlToPlainText(rawDescription);
      }
    }

    const companyName = (detail?.companyName || fallbackCompanyName || '').trim() || null;

    return new JobPostDto({
      id: `sagehr-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.SAGEHR,
      atsId,
      atsType: 'sagehr',
      employmentType: detail?.employmentType ?? null,
      applyUrl: jobUrl,
    });
  }

  /**
   * Resolve the Sage HR career site id (UUID) from an explicit `companySlug` or
   * from a `companyUrl` (its `/{careerSiteId}/...` path segment, or any UUID
   * present in the URL).
   */
  private resolveCareerSiteId(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl && companyUrl.trim()) {
      const raw = companyUrl.trim();
      try {
        const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        const segments = u.pathname.split('/').filter(Boolean);
        // Career-site URL shape: /{careerSiteId}/vacancies — take the leading
        // segment when it precedes "vacancies".
        const vacIdx = segments.indexOf('vacancies');
        if (vacIdx > 0) return segments[vacIdx - 1];
        // Otherwise pick the first UUID-shaped segment.
        for (const seg of segments) {
          if (SAGEHR_UUID_REGEX.test(seg)) return seg;
        }
      } catch {
        // Malformed URL — fall through to a raw UUID scan below.
      }
      // Last resort: any UUID embedded in the raw string.
      const m = raw.match(SAGEHR_UUID_REGEX);
      if (m) return m[0];
    }
    return '';
  }

  /** Extract the position id from a `/jobs/{positionId}` detail URL. */
  private extractPositionId(url: string): string | null {
    const m = url.match(SAGEHR_JOB_ID_REGEX);
    return m ? m[1] : null;
  }

  /**
   * Build a LocationDto from the detail-page location chip when available,
   * falling back to the free-text locality from the listing card. Sage HR
   * renders a single free-text location label; it is stored as `city`.
   */
  private extractLocation(job: SageHrJob): LocationDto | null {
    const raw = (job.detail?.locationChip || job.location || '').trim();
    if (!raw) return null;
    return new LocationDto({ city: raw, state: null, country: null });
  }

  /** Detect remote roles from the location label, employment-type chip, or title. */
  private detectRemote(job: SageHrJob): boolean {
    const haystacks = [
      job.detail?.locationChip,
      job.location,
      job.detail?.employmentType,
      job.title,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('work from home') ||
        v.includes('wfh') ||
        v.includes('telecommute')
      ) {
        return true;
      }
    }
    return false;
  }

  /** Derive a display company name from the career site id as a fallback. */
  private deriveCompanyName(companySlug: string | undefined, careerSiteId: string): string {
    const base = (companySlug?.trim() || careerSiteId).trim();
    // A bare UUID has no human name; surface it as-is so the row is still usable.
    if (SAGEHR_UUID_REGEX.test(base)) return base;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Clean the tenant display name read from the listing `<h1>` — strips a
   * leading flag emoji / whitespace and collapses internal whitespace. Returns
   * null for an empty heading.
   */
  private cleanCompanyName(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const cleaned = raw
      .replace(/\s+/g, ' ')
      // Strip leading emoji / symbol characters (e.g. a country flag) and spaces.
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .trim();
    return cleaned || null;
  }
}
