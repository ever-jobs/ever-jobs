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
  toDateOnly,
} from '@ever-jobs/common';
import {
  TRIBEPAD_GRO_HOST_TEMPLATE,
  TRIBEPAD_ENTERPRISE_HOST_TEMPLATE,
  TRIBEPAD_SEARCH_PATH,
  TRIBEPAD_JOB_DETAIL_PATH,
  TRIBEPAD_APPLY_PATH,
  TRIBEPAD_PAGE_SIZE,
  TRIBEPAD_MAX_CONCURRENCY,
  TRIBEPAD_REQUEST_DELAY_MS,
  TRIBEPAD_DEFAULT_RESULTS,
  TRIBEPAD_HEADERS,
  TRIBEPAD_JOB_CARD_SELECTOR,
  TRIBEPAD_JOB_TITLE_SELECTOR,
  TRIBEPAD_JOB_META_SELECTOR,
  TRIBEPAD_DETAIL_DESCRIPTION_SELECTOR,
} from './tribepad.constants';
import { TribepadListingItem, TribepadJob } from './tribepad.types';

/**
 * Tribepad ATS career-site scraper — generic, multi-tenant.
 *
 * Tribepad powers public career sites for many UK employers (Tesco, Greggs,
 * NHS Professionals, YPO, Get Set UK, and others). Each tenant's site is
 * served from `https://{slug}.tribepad-gro.com` (Gro tier), `https://{slug}.tribepad.com`
 * (enterprise tier), or a custom domain.
 *
 * Tribepad does NOT expose a public, anonymous JSON API. All career pages are
 * server-rendered PHP HTML. This adapter fetches the paginated job-search page
 * (`/v2/job/search?page={n}&records_per_page={size}`), parses each
 * `.sitebuilder-job-results-item` card to extract the record id, title,
 * location, salary, category, contract type, and closing date, then
 * optionally fetches the individual detail page (`/members/modules/job/detail.php?record={id}`)
 * to retrieve the full HTML job description.
 *
 * Tenant resolution: `companySlug` is tried against the Tribepad Gro apex
 * first (`{slug}.tribepad-gro.com`). If a `companyUrl` is provided instead,
 * its host is used verbatim. A single fetch error, HTTP 4xx, or parse
 * failure degrades to an empty/partial result and never throws out of
 * `scrape()`, so a single tenant never aborts a batch run.
 */
@SourcePlugin({
  site: Site.TRIBEPAD,
  name: 'Tribepad',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TribepadService implements IScraper {
  private readonly logger = new Logger(TribepadService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Tribepad scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(input.companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve a Tribepad tenant host from input');
      return new JobResponseDto([]);
    }
    const companyName = this.deriveCompanyName(input.companySlug ?? host);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TRIBEPAD_HEADERS);

    const resultsWanted = input.resultsWanted ?? TRIBEPAD_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Tribepad jobs for host: ${host}`);

      // First page — parse listings and learn the total count.
      const firstResult = await this.fetchSearchPage(client, host, 1);
      if (!firstResult) {
        this.logger.warn(`Tribepad: no results from first page for ${host}`);
        return new JobResponseDto([]);
      }

      const { items: firstItems, total } = firstResult;
      await this.collectItems(firstItems, host, companyName, input.descriptionFormat, client, seen, jobPosts);

      const totalCapped = Math.min(total || jobPosts.length, resultsWanted);

      if (jobPosts.length < totalCapped && firstItems.length >= TRIBEPAD_PAGE_SIZE) {
        const pages: number[] = [];
        for (let page = 2; (page - 1) * TRIBEPAD_PAGE_SIZE < totalCapped; page += 1) {
          pages.push(page);
        }

        // Bounded concurrent fan-out over remaining pages.
        for (let i = 0; i < pages.length; i += TRIBEPAD_MAX_CONCURRENCY) {
          const chunk = pages.slice(i, i + TRIBEPAD_MAX_CONCURRENCY);
          const settled = await Promise.allSettled(
            chunk.map((page) => this.fetchSearchPage(client, host, page)),
          );
          for (const result of settled) {
            if (result.status === 'fulfilled' && result.value) {
              await this.collectItems(
                result.value.items,
                host,
                companyName,
                input.descriptionFormat,
                client,
                seen,
                jobPosts,
              );
            } else if (result.status === 'rejected') {
              this.logger.warn(`Tribepad page fetch failed: ${result.reason?.message ?? result.reason}`);
            }
          }
          if (i + TRIBEPAD_MAX_CONCURRENCY < pages.length) {
            await randomSleep(TRIBEPAD_REQUEST_DELAY_MS, TRIBEPAD_REQUEST_DELAY_MS * 2);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Tribepad total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Tribepad scrape error for ${host}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Fetch one search page and parse all job listing cards from the HTML.
   * Returns null when the response is not usable (4xx / empty body).
   */
  private async fetchSearchPage(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    page: number,
  ): Promise<{ items: TribepadListingItem[]; total: number } | null> {
    const url = `${host}${TRIBEPAD_SEARCH_PATH}`;
    try {
      const response = await client.get<string>(url, {
        params: {
          page: String(page),
          records_per_page: String(TRIBEPAD_PAGE_SIZE),
        },
        responseType: 'text',
      });
      const html = typeof response.data === 'string' ? response.data : '';
      if (!html) return null;
      return this.parseSearchPage(html, host);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 404 || status === 403) {
        this.logger.warn(`Tribepad tenant not found (HTTP ${status}) for ${host}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse job listing cards from the HTML of a Tribepad sitebuilder search
   * page. Extracts record id, title, and all visible meta chips.
   */
  private parseSearchPage(
    html: string,
    host: string,
  ): { items: TribepadListingItem[]; total: number } {
    const $ = cheerio.load(html);
    const items: TribepadListingItem[] = [];

    // Extract total result count from <h2>{n} Search Results</h2>
    let total = 0;
    $('h2').each((_, el) => {
      const text = $(el).text().trim();
      const match = text.match(/^(\d+)\s+Search Results?/i);
      if (match) {
        total = parseInt(match[1], 10);
        return false; // break
      }
    });

    $(TRIBEPAD_JOB_CARD_SELECTOR).each((_, card) => {
      try {
        const item = this.parseJobCard($, card, host);
        if (item) items.push(item);
      } catch (err: any) {
        this.logger.warn(`Tribepad: error parsing job card: ${err.message}`);
      }
    });

    if (total === 0) total = items.length;
    return { items, total };
  }

  /**
   * Parse a single `.sitebuilder-job-results-item` card element into a
   * {@link TribepadListingItem}.
   */
  private parseJobCard(
    $: cheerio.CheerioAPI,
    card: any,
    host: string,
  ): TribepadListingItem | null {
    const $card = $(card);

    // The anchor wrapping the whole card (or the title link) carries the record URL.
    const anchor = $card.find('a[href*="detail.php?record="]').first();
    if (!anchor.length) return null;

    const href = anchor.attr('href') ?? '';
    const recordMatch = href.match(/[?&]record=(\d+)/);
    if (!recordMatch) return null;
    const recordId = recordMatch[1];

    // Build the absolute detail URL.
    const detailUrl = href.startsWith('http') ? href : `${host}${href}`;

    // Title from the dedicated title element, falling back to anchor text.
    const title = $card.find(TRIBEPAD_JOB_TITLE_SELECTOR).first().text().trim()
      || anchor.text().trim()
      || null;

    if (!title) return null;

    const meta = $card.find(TRIBEPAD_JOB_META_SELECTOR).first();

    // Extract text from the sibling span after each Font Awesome icon.
    const location = this.extractMetaChip($, meta, 'fa-map-marker-alt');
    const salary = this.extractMetaChip($, meta, 'fa-wallet');
    const category = this.extractMetaChip($, meta, 'fa-tag');
    const contractType = this.extractMetaChip($, meta, 'fa-clock');
    const closingDate = this.extractMetaChip($, meta, 'fa-calendar-times');

    return { recordId, title, detailUrl, location, salary, category, contractType, closingDate };
  }

  /**
   * Within a meta container, find the Font Awesome icon `<i>` whose class
   * includes `{iconClass}` and return the trimmed text of its next sibling
   * `<span>`. Returns null when the chip is absent.
   */
  private extractMetaChip(
    $: cheerio.CheerioAPI,
    meta: cheerio.Cheerio<any>,
    iconClass: string,
  ): string | null {
    const icon = meta.find(`i.${iconClass}`).first();
    if (!icon.length) return null;
    // Next sibling span inside the same mb-1 div.
    const span = icon.nextAll('span').first();
    if (!span.length) return null;
    // Strip any "(In N days)" / "(N days remaining)" suffix.
    const raw = span.text().replace(/\(.*?\)/g, '').trim();
    return raw || null;
  }

  /**
   * Fetch the individual detail page and extract the full HTML description
   * and the more-precise closing date. Returns null on error — the listing
   * data is sufficient to produce a partial JobPostDto without the detail.
   */
  private async fetchDetailPage(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    recordId: string,
  ): Promise<{ descriptionHtml: string | null; closingDate: string | null; applyUrl: string | null } | null> {
    const path = TRIBEPAD_JOB_DETAIL_PATH.replace('{id}', encodeURIComponent(recordId));
    const url = `${host}${path}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      if (!html) return null;
      return this.parseDetailPage(html, host, recordId);
    } catch (err: any) {
      this.logger.warn(`Tribepad: detail page fetch failed for record ${recordId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Parse the individual job detail page to extract the full HTML description,
   * the precise closing date, and the apply URL.
   */
  private parseDetailPage(
    html: string,
    host: string,
    recordId: string,
  ): { descriptionHtml: string | null; closingDate: string | null; applyUrl: string | null } {
    const $ = cheerio.load(html);

    // Full HTML description lives inside section.job-details-section.
    const descSection = $(TRIBEPAD_DETAIL_DESCRIPTION_SELECTOR).first();
    const descriptionHtml = descSection.length ? descSection.html()?.trim() || null : null;

    // Closing date from the fa-calendar-check sibling.
    let closingDate: string | null = null;
    $('i.fa-calendar-check').each((_, el) => {
      const parent = $(el).parent();
      const raw = parent.text().replace($(el).text(), '').trim();
      // Extract DD/MM/YYYY pattern.
      const match = raw.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      if (match) {
        closingDate = match[1];
        return false;
      }
    });

    // Apply URL.
    const applyPath = TRIBEPAD_APPLY_PATH.replace('{id}', encodeURIComponent(recordId));
    const applyUrl = `${host}${applyPath}`;

    return { descriptionHtml, closingDate, applyUrl };
  }

  /**
   * For each listing item, optionally fetch the detail page to get the
   * description, then map to JobPostDto and add to the output list.
   * De-duplicates by record id within this run.
   */
  private async collectItems(
    items: TribepadListingItem[],
    host: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    client: ReturnType<typeof createHttpClient>,
    seen: Set<string>,
    out: JobPostDto[],
  ): Promise<void> {
    // Fan out detail fetches concurrently (bounded).
    const settled = await Promise.allSettled(
      items.map(async (item) => {
        if (!item.recordId || seen.has(item.recordId)) return null;
        const detail = await this.fetchDetailPage(client, host, item.recordId);
        return { item, detail };
      }),
    );

    for (const result of settled) {
      if (result.status === 'rejected') {
        this.logger.warn(`Tribepad: item processing error: ${result.reason?.message ?? result.reason}`);
        continue;
      }
      const value = result.value;
      if (!value) continue;
      const { item, detail } = value;
      if (!item.recordId || seen.has(item.recordId)) continue;

      try {
        const merged: TribepadJob = { ...item, ...(detail ?? {}) };
        const post = this.mapToJobPost(merged, host, companyName, format);
        if (!post) continue;
        seen.add(item.recordId);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Tribepad: error mapping job record ${item.recordId}: ${err.message}`);
      }
    }
  }

  /** Map a merged TribepadJob to a JobPostDto. */
  private mapToJobPost(
    job: TribepadJob,
    host: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title?.trim();
    if (!title) return null;

    const atsId = job.recordId ?? '';
    if (!atsId) return null;

    const jobUrl = job.detailUrl ?? `${host}${TRIBEPAD_JOB_DETAIL_PATH.replace('{id}', encodeURIComponent(atsId))}`;
    const applyUrl = job.applyUrl ?? `${host}${TRIBEPAD_APPLY_PATH.replace('{id}', encodeURIComponent(atsId))}`;

    const rawDescription = job.descriptionHtml ?? null;
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

    // Use the more precise detail-page closing date when available.
    const closingDateStr = job.closingDate ?? null;
    const datePosted = this.parseDate(closingDateStr);

    return new JobPostDto({
      id: `tribepad-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted,
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.TRIBEPAD,
      atsId,
      atsType: 'tribepad',
      department: job.category?.trim() || null,
      applyUrl,
    });
  }

  /**
   * Resolve the tenant host from `companySlug` (tried against tribepad-gro.com
   * first) or from a fully qualified `companyUrl`.
   */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      return TRIBEPAD_GRO_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
    }
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        // Use the full origin (scheme + host).
        return u.origin;
      } catch {
        // Malformed URL — fall through.
      }
    }
    return '';
  }

  /** Derive a display company name from the slug or host. */
  private deriveCompanyName(slugOrHost: string): string {
    // Strip protocol and domain suffix to get the slug portion.
    const cleaned = slugOrHost
      .replace(/^https?:\/\//, '')
      .replace(/\.(tribepad-gro|tribepad)\.com.*$/, '')
      .replace(/\..*$/, '');
    return cleaned
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Build a LocationDto from the free-text location chip. Tribepad locations
   * are typically a city or "City, Postcode" string — split on the last comma
   * to separate city from postcode / country.
   */
  private extractLocation(job: TribepadJob): LocationDto | null {
    const raw = job.location?.trim();
    if (!raw) return null;
    const parts = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    // Two-part: "City, Postcode" or "City, Country"
    const city = parts[0];
    const countryOrState = parts[parts.length - 1];
    // If the last part looks like a postcode (UK: letters+digits), treat it
    // as region/state; otherwise treat as country.
    const isPostcode = /^[A-Z]{1,2}\d/.test(countryOrState.toUpperCase());
    return new LocationDto({
      city: city ?? null,
      state: isPostcode ? countryOrState : null,
      country: isPostcode ? null : countryOrState,
    });
  }

  /** Detect remote roles from category, contract type, or title keywords. */
  private detectRemote(job: TribepadJob): boolean {
    const haystacks = [job.title, job.location, job.category, job.contractType];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }

  /**
   * Parse Tribepad's displayed closing date into a YYYY-MM-DD string.
   * The listing page uses `DD/MM/YY` and the detail page uses `DD/MM/YYYY`.
   * Returns null when the input is absent or unparseable.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      // Match DD/MM/YY or DD/MM/YYYY
      const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (match) {
        const [, dd, mm, yy] = match;
        const fullYear = yy.length === 2 ? `20${yy}` : yy;
        const d = new Date(`${fullYear}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`);
        if (!isNaN(d.getTime())) return toDateOnly(`${fullYear}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`);
      }
      // Attempt generic Date parse as fallback.
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
