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
  RECRUITIS_CAREERS_BASE,
  RECRUITIS_TENANT_URL_TEMPLATE,
  RECRUITIS_JOB_BLOCK_SELECTOR,
  RECRUITIS_JOB_TITLE_SELECTOR,
  RECRUITIS_JOB_CHIP_SELECTOR,
  RECRUITIS_PAGINATION_SUMMARY_SELECTOR,
  RECRUITIS_PAGINATION_NEXT_SELECTOR,
  RECRUITIS_PAGINATION_DISABLED_CLASS,
  RECRUITIS_DESCRIPTION_SELECTOR,
  RECRUITIS_PAGE_PARAM,
  RECRUITIS_MAX_PAGES,
  RECRUITIS_MAX_CONCURRENCY,
  RECRUITIS_REQUEST_DELAY_MS,
  RECRUITIS_DEFAULT_RESULTS,
  RECRUITIS_HEADERS,
} from './recruitis.constants';
import {
  RecruitisJobListItem,
  RecruitisJobDetail,
  RecruitisListingPage,
} from './recruitis.types';

/**
 * Recruitis hosted career-site scraper — generic, multi-tenant.
 *
 * Recruitis (recruitis.io) is a Czech ATS. Every customer tenant is served a
 * public, branded, server-rendered career site under the shared apex
 * `jobs.recruitis.io`:
 *
 *     https://jobs.recruitis.io/{tenant}
 *
 * The tenant slug (e.g. `recruitisio`, `allwyn`) is carried by
 * `input.companySlug`, or derived from the first path segment of
 * `input.companyUrl`.
 *
 * The scraper fetches that anonymous HTML page and parses each role block
 * (`div.row.job`) with cheerio. The listing block carries the title, the
 * detail-page href (whose leading numeric segment is the ATS id), and meta
 * chips (location, category, employment type, education). A per-role detail
 * fetch then retrieves the full HTML description from `#job-description`. Detail
 * fetches fan out concurrently via `Promise.allSettled`; an individual failure
 * degrades to a role with a null description rather than aborting.
 *
 * Pagination walks `?page=n` until the "next" control is disabled, a page
 * yields no new roles, or the run cap is reached. An unknown tenant (HTTP 404)
 * or a malformed page degrades to an empty/partial result — this service never
 * throws to the caller, so a single tenant never aborts a batch run.
 *
 * The authenticated REST API at `app.recruitis.io/api2/jobs` requires a
 * per-company bearer token and is deliberately not used.
 */
@SourcePlugin({
  site: Site.RECRUITIS,
  name: 'Recruitis',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class RecruitisService implements IScraper {
  private readonly logger = new Logger(RecruitisService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Recruitis scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(input.companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Recruitis tenant from input');
      return new JobResponseDto([]);
    }

    const tenantUrl = RECRUITIS_TENANT_URL_TEMPLATE.replace(
      '{tenant}',
      encodeURIComponent(tenant),
    );
    const companyName = this.deriveCompanyName(tenant);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(RECRUITIS_HEADERS);

    const resultsWanted = input.resultsWanted ?? RECRUITIS_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const items: RecruitisJobListItem[] = [];

    try {
      this.logger.log(`Fetching Recruitis career site for tenant: ${tenant}`);

      // Walk listing pages until we have enough roles, the next control is
      // disabled, or a page yields no new roles.
      for (let page = 1; page <= RECRUITIS_MAX_PAGES; page += 1) {
        const html = await this.fetchListingHtml(client, tenantUrl, page);
        if (html === null) {
          if (page === 1) {
            this.logger.warn(`Recruitis tenant not found or no career site: ${tenant}`);
            return new JobResponseDto([]);
          }
          break;
        }

        const listing = this.parseListing(html, tenant);
        let added = 0;
        for (const item of listing.items) {
          const key = item.atsId ?? '';
          if (!key || seen.has(key)) continue;
          seen.add(key);
          items.push(item);
          added += 1;
          if (items.length >= resultsWanted) break;
        }

        this.logger.log(
          `Recruitis listing page ${page}: ${listing.items.length} blocks, ` +
            `${added} new (running total ${items.length}) for ${tenant}`,
        );

        if (items.length >= resultsWanted) break;
        if (!listing.hasNext || added === 0) break;

        await randomSleep(RECRUITIS_REQUEST_DELAY_MS, RECRUITIS_REQUEST_DELAY_MS * 2);
      }

      const wanted = items.slice(0, resultsWanted);
      const jobPosts = await this.fetchDescriptionsAndMap(
        client,
        wanted,
        companyName,
        input.descriptionFormat,
      );

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Recruitis total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Recruitis scrape error for ${tenant}: ${err.message}`);
      // Best-effort: map whatever listing items we already collected.
      try {
        const jobPosts = await this.fetchDescriptionsAndMap(
          client,
          items.slice(0, resultsWanted),
          companyName,
          input.descriptionFormat,
        );
        return new JobResponseDto(jobPosts.slice(0, resultsWanted));
      } catch {
        return new JobResponseDto([], classifyScrapeError(err));
      }
    }
  }

  /**
   * Fetch one listing page of HTML. Returns the HTML string, or null when the
   * tenant / page is unknown (HTTP 404 / 400 / 403) — the caller degrades to
   * an empty or partial result.
   */
  private async fetchListingHtml(
    client: ReturnType<typeof createHttpClient>,
    tenantUrl: string,
    page: number,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(tenantUrl, {
        params: { [RECRUITIS_PAGE_PARAM]: page },
        responseType: 'text',
      });
      return typeof response.data === 'string'
        ? response.data
        : String(response.data ?? '');
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 400 || status === 403) {
        this.logger.warn(
          `Recruitis listing not found (HTTP ${status}) for ${tenantUrl}`,
        );
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse one listing-page HTML document into structured items plus pagination
   * metadata. Returns an empty listing on any parse failure.
   */
  private parseListing(html: string, tenant: string): RecruitisListingPage {
    try {
      const $ = cheerio.load(html);
      const items: RecruitisJobListItem[] = [];

      $(RECRUITIS_JOB_BLOCK_SELECTOR).each((_i, el) => {
        const $block = $(el);
        const $title = $block.find(RECRUITIS_JOB_TITLE_SELECTOR).first();
        const title = $title.text().trim() || null;
        const href = $title.attr('href') ?? null;
        if (!title && !href) return;

        const atsId = this.extractAtsId(href);
        const jobUrl = this.absoluteUrl(href);

        // Meta chips, in DOM order: location, category, employment, education.
        const chips: string[] = [];
        $block.find(RECRUITIS_JOB_CHIP_SELECTOR).each((_j, chipEl) => {
          const text = this.cleanChip($(chipEl).text());
          if (text) chips.push(text);
        });

        items.push({
          atsId,
          title,
          jobUrl,
          location: chips[0] ?? null,
          category: chips[1] ?? null,
          employmentType: chips[2] ?? null,
          education: chips[3] ?? null,
        });
      });

      const total = this.parseTotal($(RECRUITIS_PAGINATION_SUMMARY_SELECTOR).text());
      const hasNext = this.detectHasNext($);

      return { items, total, hasNext };
    } catch (err: any) {
      this.logger.warn(`Recruitis listing parse error for ${tenant}: ${err.message}`);
      return { items: [], total: null, hasNext: false };
    }
  }

  /**
   * Concurrently fetch the HTML description for each listing item and map every
   * item to a `JobPostDto`. A detail-fetch failure degrades to a null
   * description (the role is still emitted). Uses `Promise.allSettled` so a
   * single failure never aborts the batch.
   */
  private async fetchDescriptionsAndMap(
    client: ReturnType<typeof createHttpClient>,
    items: RecruitisJobListItem[],
    companyName: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto[]> {
    const out: JobPostDto[] = [];
    if (items.length === 0) return out;

    for (let i = 0; i < items.length; i += RECRUITIS_MAX_CONCURRENCY) {
      const chunk = items.slice(i, i + RECRUITIS_MAX_CONCURRENCY);
      const detailResults = await Promise.allSettled(
        chunk.map((item) => this.fetchJobDetail(client, item)),
      );

      for (let j = 0; j < chunk.length; j += 1) {
        const item = chunk[j];
        const result = detailResults[j];
        let detail: RecruitisJobDetail | null = null;
        if (result.status === 'fulfilled') {
          detail = result.value;
        } else {
          this.logger.warn(
            `Recruitis detail fetch failed for job ${item.atsId ?? '?'}: ` +
              `${result.reason?.message ?? result.reason}`,
          );
        }

        try {
          const post = this.processJob(item, detail, companyName, format);
          if (post) out.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing Recruitis job ${item.atsId ?? '?'}: ${err.message}`,
          );
        }
      }

      if (i + RECRUITIS_MAX_CONCURRENCY < items.length) {
        await randomSleep(RECRUITIS_REQUEST_DELAY_MS, RECRUITIS_REQUEST_DELAY_MS * 2);
      }
    }

    return out;
  }

  /**
   * Fetch and parse one job-detail page. Returns the HTML description plus any
   * chips repeated in the detail header, or null on failure.
   */
  private async fetchJobDetail(
    client: ReturnType<typeof createHttpClient>,
    item: RecruitisJobListItem,
  ): Promise<RecruitisJobDetail | null> {
    const url = item.jobUrl;
    if (!url) return null;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html =
        typeof response.data === 'string' ? response.data : String(response.data ?? '');
      return this.parseDetail(html);
    } catch {
      return null;
    }
  }

  /** Extract the HTML description (and fallback chips) from a detail page. */
  private parseDetail(html: string): RecruitisJobDetail | null {
    try {
      const $ = cheerio.load(html);
      const $desc = $(RECRUITIS_DESCRIPTION_SELECTOR).first();
      const description = $desc.length ? ($desc.html() ?? '').trim() || null : null;

      const chips: string[] = [];
      $(`.media-body ${RECRUITIS_JOB_CHIP_SELECTOR}`).each((_i, el) => {
        const text = this.cleanChip($(el).text());
        if (text) chips.push(text);
      });

      return {
        description,
        location: chips[0] ?? null,
        category: chips[1] ?? null,
        employmentType: chips[2] ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Map a listing item + optional detail into a `JobPostDto`. */
  private processJob(
    item: RecruitisJobListItem,
    detail: RecruitisJobDetail | null,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = item.title?.trim();
    if (!title) return null;

    const atsId = item.atsId?.trim();
    if (!atsId) return null;

    const jobUrl = item.jobUrl ?? `${RECRUITIS_CAREERS_BASE}`;

    const rawDescription = detail?.description ?? null;
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

    const locationLabel = item.location ?? detail?.location ?? null;
    const department = item.category ?? detail?.category ?? null;

    return new JobPostDto({
      id: `recruitis-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.locationFromLabel(locationLabel),
      description,
      datePosted: null,
      isRemote: this.detectRemote(item, rawDescription),
      emails: extractEmails(description),
      site: Site.RECRUITIS,
      atsId,
      atsType: 'recruitis',
      department,
      applyUrl: jobUrl,
    });
  }

  /**
   * Resolve the tenant slug from an explicit `companySlug` or from the first
   * path segment of a `companyUrl` (e.g. `recruitisio` from
   * `https://jobs.recruitis.io/recruitisio`). Returns an empty string when
   * neither yields a usable slug.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments.length > 0) return decodeURIComponent(segments[0]);
        // No path → fall back to the first sub-domain label (custom domain).
        const labels = u.hostname.split('.').filter(Boolean);
        const label = labels[0];
        if (label && label !== 'www' && label !== 'jobs') return label;
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  /** Extract the numeric job id from a detail href like `/{tenant}/490653-slug`. */
  private extractAtsId(href: string | null): string | null {
    if (!href) return null;
    const segments = href.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    const match = last.match(/^(\d+)/);
    return match ? match[1] : null;
  }

  /** Resolve a possibly-relative href against the careers apex. */
  private absoluteUrl(href: string | null): string | null {
    if (!href) return null;
    const trimmed = href.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `${RECRUITIS_CAREERS_BASE}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
  }

  /** Normalise a chip's text: collapse whitespace, strip non-breaking spaces. */
  private cleanChip(text: string | null | undefined): string | null {
    if (!text) return null;
    const cleaned = text
      .replace(/ /g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || null;
  }

  /** Derive a human-readable company name from the tenant slug. */
  private deriveCompanyName(tenant: string): string {
    return tenant
      .replace(/[-_.]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Split a free-text "City, Region, Country" chip into a `LocationDto`.
   * Returns null for an empty label.
   */
  private locationFromLabel(label: string | null | undefined): LocationDto | null {
    if (!label) return null;
    const parts = label
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    const city = parts[0];
    const state = parts.length >= 3 ? parts[1] : null;
    const country = parts[parts.length - 1];
    return new LocationDto({
      city: city ?? null,
      state: state ?? null,
      country: country ?? null,
    });
  }

  /** Detect remote roles from the location chip, title, or description text. */
  private detectRemote(
    item: RecruitisJobListItem,
    rawDescription: string | null,
  ): boolean {
    const haystacks = [
      item.location,
      item.title,
      item.employmentType,
      rawDescription,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      // English + Czech remote markers.
      if (
        v.includes('remote') ||
        v.includes('work from home') ||
        v.includes('wfh') ||
        v.includes('home office') ||
        v.includes('na dalku')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Parse the total open-role count from the pagination summary text, e.g.
   * "Zobrazeno 1 az 6 inzeratu z 6" → 6. Returns null when not parseable.
   */
  private parseTotal(summary: string | null | undefined): number | null {
    if (!summary) return null;
    const numbers = summary.match(/\d+/g);
    if (!numbers || numbers.length === 0) return null;
    const last = parseInt(numbers[numbers.length - 1], 10);
    return isNaN(last) ? null : last;
  }

  /**
   * Detect whether a non-disabled "next page" control is present.
   * The last page marks the next control with a `--disabled` CSS class.
   */
  private detectHasNext($: cheerio.CheerioAPI): boolean {
    const $next = $(RECRUITIS_PAGINATION_NEXT_SELECTOR);
    if ($next.length === 0) return false;
    let enabled = false;
    $next.each((_i, el) => {
      const cls = $(el).attr('class') ?? '';
      if (!cls.includes(RECRUITIS_PAGINATION_DISABLED_CLASS)) enabled = true;
    });
    return enabled;
  }
}
