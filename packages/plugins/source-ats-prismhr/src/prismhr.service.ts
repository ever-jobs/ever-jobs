import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  Site,
  DescriptionFormat,
  getCompensationInterval,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
  parseJobPostingLd,
} from '@ever-jobs/common';
import {
  PRISMHR_HOST_SUFFIX,
  PRISMHR_DEFAULT_RESULTS,
  PRISMHR_MAX_DETAIL_FETCHES,
  PRISMHR_DETAIL_CONCURRENCY,
  PRISMHR_DEFAULT_TIMEOUT_SECONDS,
  PRISMHR_HEADERS,
  PRISMHR_TITLE_COMPANY_REGEX,
  PRISMHR_REMOTE_REGEX,
  prismhrBoardUrl,
  prismhrDetailUrl,
} from './prismhr.constants';
import {
  PrismhrListItem,
  PrismhrDetailData,
  PrismhrBoardProps,
  PrismhrDetailTableProps,
} from './prismhr.types';

/**
 * PrismHR / HiringThing ATS careers scraper.
 *
 * PrismHR career boards live at `https://{slug}.prismhr-hire.com/`. The board
 * is a React SPA powered by HiringThing, but the server renders enough HTML
 * for both views this adapter needs (no headless browser required):
 *
 *   Board list page (`/`): a `data-react-props` JSON payload on the
 *   `HiringThing.Components.JobFiltersContainer` element carries the complete
 *   job list with IDs, titles, a state->city->[ids] location map,
 *   remotePositions[], and categories{}.
 *
 *   Detail page (`/job/{id}`): a schema.org `JobPosting` JSON-LD block with
 *   description, datePosted, hiringOrganization, and location; plus a
 *   `HiringThing.Components.ApplyButtonGroup` React-props JSON carrying
 *   remote flag, salary (min/max), pay_frequency, and category.
 *
 * The adapter reads the board list for job enumeration + coarse fields, then
 * fans out to detail pages for description/date/salary enrichment via the
 * shared JSON-LD extractor and the React props.
 *
 * Why this exists alongside `source-ats-hiringthing`: both target the same
 * underlying HiringThing platform, but at opposite ends. The `hiringthing`
 * adapter calls the authenticated owner-side REST API
 * (`api.hiringthing.com`, Basic Auth with an account's private API key) — it
 * returns only that one account's jobs and needs a key we do not have for
 * arbitrary companies, so it yields nothing when scraping third-party boards.
 * This adapter instead scrapes the anonymous public careers board
 * (`{slug}.prismhr-hire.com`), which needs no credentials and is addressable
 * by slug/URL for any tenant — the only viable path for general scraping. It
 * also populates fields the owner-API path leaves empty here (structured
 * location, isRemote, and real min/max compensation).
 */
@SourcePlugin({
  site: Site.PRISMHR,
  name: 'PrismHR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PrismhrService implements IScraper {
  private readonly logger = new Logger(PrismhrService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for PrismHR scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveTenant(input.companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a PrismHR tenant slug from input');
      return new JobResponseDto([]);
    }

    const timeoutSeconds = Math.min(
      input.requestTimeout ?? PRISMHR_DEFAULT_TIMEOUT_SECONDS,
      PRISMHR_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(PRISMHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? PRISMHR_DEFAULT_RESULTS;

    try {
      this.logger.log(`Fetching PrismHR jobs for tenant: ${slug}`);

      const boardHtml = await this.fetchText(client, prismhrBoardUrl(slug), slug);
      if (!boardHtml) {
        this.logger.log(`PrismHR: no board page for tenant "${slug}"`);
        return new JobResponseDto([]);
      }

      const { items, companyName } = this.parseBoard(boardHtml, slug);
      if (items.length === 0) {
        this.logger.log(`PrismHR tenant "${slug}" has no open roles`);
        return new JobResponseDto([]);
      }

      const wanted = Math.min(resultsWanted, PRISMHR_MAX_DETAIL_FETCHES);
      const selected = items.slice(0, wanted);

      const detailMap = await this.fetchDetails(client, slug, selected);

      const resolvedCompany = companyName ?? this.deriveCompanyName(slug);
      const jobPosts: JobPostDto[] = [];

      for (const item of selected) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const detail = detailMap.get(item.jobId) ?? null;
          jobPosts.push(this.toJobPost(item, slug, resolvedCompany, detail, input.descriptionFormat));
        } catch (err: any) {
          this.logger.warn(`Error processing PrismHR role ${item.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`PrismHR total: ${jobPosts.length} jobs for ${slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`PrismHR scrape error for ${slug}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Parse the board list page into a de-duped list of jobs.
   *
   * The board carries a `data-react-props` JSON payload on the
   * `HiringThing.Components.JobFiltersContainer` element with all job IDs,
   * titles, a `state -> city -> [ids]` location map, `remotePositions[]`,
   * and `categories{}`.
   */
  private parseBoard(html: string, slug: string): { items: PrismhrListItem[]; companyName: string | null } {
    const $ = cheerio.load(html);

    const titleText = $('title').first().text();
    const companyMatch = PRISMHR_TITLE_COMPANY_REGEX.exec(titleText.trim());
    let companyName = companyMatch ? this.cleanText(companyMatch[1]) : null;

    if (!companyName) {
      const ogTitle = $('meta[property="og:title"]').attr('content');
      if (ogTitle) companyName = this.cleanText(ogTitle);
    }

    const propsEl = $('[data-react-class="HiringThing.Components.JobFiltersContainer"]');
    const propsRaw = propsEl.attr('data-react-props');
    if (!propsRaw) {
      return { items: [], companyName };
    }

    let boardProps: PrismhrBoardProps;
    try {
      boardProps = JSON.parse(propsRaw) as PrismhrBoardProps;
    } catch {
      return { items: [], companyName };
    }

    const titles = boardProps.titles ?? [];
    const remoteSet = new Set(boardProps.remotePositions ?? []);

    const idToLocation = this.buildLocationMap(boardProps.locations ?? {});
    const idToCategory = this.buildCategoryMap(boardProps.categories ?? {});

    const items: PrismhrListItem[] = [];
    const seen = new Set<number>();

    for (const t of titles) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const loc = idToLocation.get(t.id);
      items.push({
        jobId: t.id,
        title: t.title,
        city: loc?.city ?? null,
        state: loc?.state ?? null,
        isRemote: remoteSet.has(t.id),
        department: idToCategory.get(t.id) ?? null,
      });
    }

    return { items, companyName };
  }

  /** Invert `{ state: { city: [ids] } }` → `Map<id, { city, state }>`. */
  private buildLocationMap(
    locations: Record<string, Record<string, number[]>>,
  ): Map<number, { city: string; state: string }> {
    const map = new Map<number, { city: string; state: string }>();
    for (const [state, cities] of Object.entries(locations)) {
      for (const [city, ids] of Object.entries(cities)) {
        for (const id of ids) {
          if (!map.has(id)) {
            map.set(id, { city, state });
          }
        }
      }
    }
    return map;
  }

  /** Invert `{ category: [ids] }` → `Map<id, category>`. */
  private buildCategoryMap(categories: Record<string, number[]>): Map<number, string> {
    const map = new Map<number, string>();
    for (const [category, ids] of Object.entries(categories)) {
      for (const id of ids) {
        if (!map.has(id)) {
          map.set(id, category);
        }
      }
    }
    return map;
  }

  /**
   * Fan out to detail pages in bounded batches, extracting the JSON-LD
   * `JobPosting` fields and React-props salary/remote/category.
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    items: PrismhrListItem[],
  ): Promise<Map<number, PrismhrDetailData>> {
    const result = new Map<number, PrismhrDetailData>();

    for (let i = 0; i < items.length; i += PRISMHR_DETAIL_CONCURRENCY) {
      const batch = items.slice(i, i + PRISMHR_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (item) => {
          const html = await this.fetchText(client, prismhrDetailUrl(slug, item.jobId), slug);
          return { jobId: item.jobId, data: html ? this.parseDetail(html) : null };
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

  /** Extract the JSON-LD + React-props fields from a detail page. */
  private parseDetail(html: string): PrismhrDetailData | null {
    const posting = parseJobPostingLd(html)[0];
    const reactProps = this.extractDetailReactProps(html);

    if (!posting && !reactProps) return null;

    const loc = posting?.locations[0] ?? null;
    const locInfo = reactProps?.location_info;

    const salary = this.parseSalary(reactProps);

    return {
      descriptionHtml: posting?.description ?? reactProps?.html_description ?? null,
      datePosted: posting?.datePosted ?? reactProps?.posted_at ?? null,
      employmentType: posting?.employmentType ?? null,
      hiringOrganizationName: posting?.hiringOrganizationName ?? reactProps?.company_name ?? null,
      isRemote: reactProps?.remote ?? posting?.remote ?? false,
      city: loc?.city ?? this.cleanText(locInfo?.city),
      state: loc?.region ?? this.cleanText(locInfo?.state),
      country: loc?.country ?? this.cleanText(locInfo?.country),
      minSalary: salary.min,
      maxSalary: salary.max,
      payFrequency: salary.frequency,
      currency: salary.currency,
      category: reactProps?.category ?? null,
    };
  }

  /** Extract the ApplyButtonGroup React props from the detail page. */
  private extractDetailReactProps(html: string): PrismhrDetailTableProps | null {
    const $ = cheerio.load(html);
    const el = $('[data-react-class="HiringThing.Components.ApplyButtonGroup"]').first();
    const raw = el.attr('data-react-props');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { jobObj?: { table?: PrismhrDetailTableProps } };
      return parsed?.jobObj?.table ?? null;
    } catch {
      return null;
    }
  }

  /** Parse salary from React props min/max_salary + pay_frequency. */
  private parseSalary(
    props: PrismhrDetailTableProps | null,
  ): { min: number | null; max: number | null; frequency: string | null; currency: string | null } {
    if (!props) return { min: null, max: null, frequency: null, currency: null };

    const minObj = props.min_salary;
    const maxObj = props.max_salary;
    const min = this.extractAmount(minObj);
    const max = this.extractAmount(maxObj);
    const currency = this.extractCurrency(minObj) ?? this.extractCurrency(maxObj);

    if (min == null && max == null) return { min: null, max: null, frequency: null, currency: null };

    const frequency = props.pay_frequency || null;
    return { min, max, frequency, currency };
  }

  /** Extract a numeric amount from a salary object (handles various shapes). */
  private extractAmount(obj: Record<string, unknown> | null | undefined): number | null {
    if (!obj || typeof obj !== 'object') return null;
    for (const key of ['amount', 'cents', 'value']) {
      const val = obj[key];
      if (typeof val === 'number' && Number.isFinite(val)) {
        return key === 'cents' ? val / 100 : val;
      }
      if (typeof val === 'string') {
        const num = parseFloat(val.replace(/[^0-9.]/g, ''));
        if (Number.isFinite(num)) return key === 'cents' ? num / 100 : num;
      }
    }
    return null;
  }

  /** Extract currency code from a salary object. */
  private extractCurrency(obj: Record<string, unknown> | null | undefined): string | null {
    if (!obj || typeof obj !== 'object') return null;
    const currency = obj['currency'] ?? obj['currency_iso'];
    return typeof currency === 'string' && currency.trim() ? currency.trim().toUpperCase() : null;
  }

  /** Map a list item + detail data -> JobPostDto. */
  private toJobPost(
    item: PrismhrListItem,
    slug: string,
    companyName: string,
    detail: PrismhrDetailData | null,
    format: DescriptionFormat | undefined,
  ): JobPostDto {
    const isRemote =
      (detail?.isRemote ?? false) ||
      item.isRemote ||
      (item.city != null && PRISMHR_REMOTE_REGEX.test(item.city)) ||
      PRISMHR_REMOTE_REGEX.test(item.title);

    const jobUrl = prismhrDetailUrl(slug, item.jobId);

    return new JobPostDto({
      id: `prismhr-${slug}-${item.jobId}`,
      title: item.title,
      companyName: detail?.hiringOrganizationName ?? companyName,
      jobUrl,
      location: this.buildLocation(item, detail, isRemote),
      description: this.formatDescription(detail?.descriptionHtml ?? null, format),
      datePosted: detail?.datePosted ? toDateOnly(detail.datePosted) : null,
      isRemote,
      emails: extractEmails(detail?.descriptionHtml ?? ''),
      site: Site.PRISMHR,
      atsId: String(item.jobId),
      atsType: 'prismhr',
      department: detail?.category ?? item.department,
      employmentType: detail?.employmentType ?? null,
      compensation: this.buildCompensation(detail),
      applyUrl: jobUrl,
    });
  }

  /** Build a LocationDto from detail JSON-LD / React-props, then list location. */
  private buildLocation(
    item: PrismhrListItem,
    detail: PrismhrDetailData | null,
    isRemote: boolean,
  ): LocationDto | null {
    if (detail && (detail.city || detail.state || detail.country)) {
      return new LocationDto({ city: detail.city, state: detail.state, country: detail.country });
    }
    if (item.city || item.state) {
      return new LocationDto({ city: item.city, state: item.state });
    }
    return isRemote ? new LocationDto({ city: 'Remote' }) : null;
  }

  /** Build CompensationDto from the detail React props salary fields. */
  private buildCompensation(detail: PrismhrDetailData | null): CompensationDto | null {
    if (!detail) return null;
    if (detail.minSalary == null && detail.maxSalary == null) return null;
    const rawFreq = detail.payFrequency ?? null;
    const interval = rawFreq
      ? getCompensationInterval(rawFreq) ?? getCompensationInterval(rawFreq.replace(/ly$/i, ''))
      : undefined;
    return new CompensationDto({
      minAmount: detail.minSalary ?? undefined,
      maxAmount: detail.maxSalary ?? undefined,
      currency: detail.currency ?? undefined,
      interval: interval ?? undefined,
    });
  }

  /** Convert the HTML job-ad body per `descriptionFormat`. */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * GET a board URL as text. Does NOT follow redirects: a live tenant serves a
   * direct 200; a tenant that has moved degrades to null.
   */
  private async fetchText(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    slug: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, {
        responseType: 'text',
        maxRedirects: 0,
      });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        this.logger.warn(`PrismHR board returned HTTP ${status} for ${slug}`);
        return null;
      }
      this.logger.warn(`PrismHR board fetch failed for ${slug}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Resolve the tenant slug from companySlug or companyUrl.
   *
   * Accepts a bare slug (the subdomain, e.g. `realta-fusion-inc`), a full
   * board URL, or a companyUrl on the `*.prismhr-hire.com` host (the subdomain
   * is the slug).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    const slug = companySlug?.trim();
    if (slug) {
      if (/^https?:\/\//i.test(slug) || slug.includes(PRISMHR_HOST_SUFFIX)) {
        const fromUrl = this.slugFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.replace(/^\/+|\/+$/g, '').toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.slugFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /** Extract the subdomain (the slug) from a `*.prismhr-hire.com` URL. */
  private slugFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (!host.endsWith(PRISMHR_HOST_SUFFIX)) return '';
      const sub = host.slice(0, -PRISMHR_HOST_SUFFIX.length);
      return sub || '';
    } catch {
      return '';
    }
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(slug: string): string {
    return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }

  /** Trim + collapse whitespace; null for empty. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.replace(/\s+/g, ' ').trim();
    return v.length > 0 ? v : null;
  }
}
