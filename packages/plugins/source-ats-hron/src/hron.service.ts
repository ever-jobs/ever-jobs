import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import { Injectable, Logger } from '@nestjs/common';
import {
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
  HRON_HOST,
  HRON_CAREER_PATH_TEMPLATE,
  HRON_DEFAULT_CAREER_PATH,
  HRON_JOB_PATH_TEMPLATE,
  HRON_JOBID_LINK_REGEX,
  HRON_JOBID_PARAM_REGEX,
  HRON_DEFAULT_RESULTS,
  HRON_MAX_CONCURRENCY,
  HRON_REQUEST_DELAY_MS,
  HRON_HEADERS,
} from './hron.constants';
import { HrOnListingItem, HrOnJobDetail, HrOnJobPostingLd } from './hron.types';

/**
 * HR-ON Recruit careers scraper — generic, multi-tenant.
 *
 * HR-ON Recruit (hr-on.com) is a Danish e-recruitment suite. Every customer
 * tenant publishes a branded, public, GDPR-compliant career page; HR-ON keeps
 * candidates on the company's own domain, so the public surface is
 * server-rendered HTML rather than a documented anonymous JSON feed. This
 * adapter therefore:
 *
 *   1. Fetches the tenant's career page (`companyUrl`, or a slug expanded
 *      against the HR-ON hosted path) and harvests every job-detail link
 *      matching `/jobposts*?jobid={ID}` — the stable cross-tenant contract that
 *      is emitted regardless of the tenant's theme.
 *   2. Fans out (bounded `Promise.allSettled`) to each detail page and extracts
 *      the title, company, location, dates, employment type, and full job-ad
 *      body from the rendered HTML (and from a schema.org `JobPosting` JSON-LD
 *      block when a tenant theme injects one).
 *
 * A missing tenant, an HTTP 4xx, or a malformed page degrades to an
 * empty/partial result — never throws — so a single tenant never aborts a
 * batch run. De-duplication is by numeric job id within the run.
 */
@SourcePlugin({
  site: Site.HRON,
  name: 'HR-ON Recruit',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HrOnService implements IScraper {
  private readonly logger = new Logger(HrOnService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for HR-ON scraper');
      return new JobResponseDto([]);
    }

    const careerUrl = this.resolveCareerUrl(input.companySlug, input.companyUrl);
    if (!careerUrl) {
      this.logger.warn('Could not resolve an HR-ON career URL from input');
      return new JobResponseDto([]);
    }
    const origin = this.originOf(careerUrl) || HRON_HOST;
    const fallbackCompanyName = this.deriveCompanyName(input.companySlug, careerUrl);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(HRON_HEADERS);

    const resultsWanted = input.resultsWanted ?? HRON_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching HR-ON career page: ${careerUrl}`);

      const listingHtml = await this.fetchHtml(client, careerUrl);
      if (!listingHtml) {
        this.logger.warn(`HR-ON: no career page returned for ${careerUrl}`);
        return new JobResponseDto([]);
      }

      // Harvest job-detail links by pattern, de-dupe by job id, cap before fan-out.
      const wantedItems: HrOnListingItem[] = [];
      for (const item of this.parseListing(listingHtml, origin)) {
        if (seen.has(item.jobId)) continue;
        seen.add(item.jobId);
        wantedItems.push(item);
        if (wantedItems.length >= resultsWanted) break;
      }

      this.logger.log(
        `HR-ON listing parsed: ${wantedItems.length} unique roles for ${careerUrl}`,
      );

      // Bounded concurrent fan-out over detail pages.
      for (let i = 0; i < wantedItems.length; i += HRON_MAX_CONCURRENCY) {
        const chunk = wantedItems.slice(i, i + HRON_MAX_CONCURRENCY);
        const settled = await Promise.allSettled(
          chunk.map((item) => this.fetchDetail(client, item)),
        );

        for (let j = 0; j < chunk.length; j += 1) {
          const item = chunk[j];
          const result = settled[j];
          let detail: HrOnJobDetail | null = null;
          if (result.status === 'fulfilled') {
            detail = result.value;
          } else {
            this.logger.warn(
              `HR-ON detail fetch failed for job ${item.jobId}: ` +
                `${result.reason?.message ?? result.reason}`,
            );
          }

          try {
            const post = this.mapToJobPost(
              item,
              detail,
              fallbackCompanyName,
              input.descriptionFormat,
            );
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`HR-ON: error mapping job ${item.jobId}: ${err.message}`);
          }
        }

        if (i + HRON_MAX_CONCURRENCY < wantedItems.length) {
          await randomSleep(HRON_REQUEST_DELAY_MS, HRON_REQUEST_DELAY_MS * 2);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`HR-ON total: ${trimmed.length} jobs for ${careerUrl}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`HR-ON scrape error for ${careerUrl}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial
    }
  }

  /**
   * Fetch an HTML document. Returns null on an unknown tenant (HTTP 4xx) or an
   * empty body — a graceful "no jobs" rather than a hard failure.
   */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html =
        typeof response.data === 'string' ? response.data : String(response.data ?? '');
      return html || null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`HR-ON tenant page not found (HTTP ${status}) for ${url}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Harvest every job-detail link from a career page. Links are matched by the
   * `/jobposts*?jobid={ID}` pattern (theme-independent) rather than by CSS
   * class. The numeric id is the ATS id; the detail URL is absolutised against
   * the career-page origin.
   */
  private parseListing(html: string, origin: string): HrOnListingItem[] {
    const items: HrOnListingItem[] = [];
    const byId = new Map<string, HrOnListingItem>();

    // Primary pass: raw regex over the markup catches every `?jobid=` href,
    // independent of the tenant's theme / DOM nesting.
    HRON_JOBID_LINK_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HRON_JOBID_LINK_REGEX.exec(html)) !== null) {
      const jobId = m[1];
      if (!jobId || byId.has(jobId)) continue;
      const detailUrl = this.buildDetailUrl(origin, jobId);
      const item: HrOnListingItem = { jobId, detailUrl };
      byId.set(jobId, item);
      items.push(item);
    }

    // Enrichment pass: walk the DOM to attach the title / location text that
    // sits with each link, so a partial JobPostDto is possible even if a detail
    // fetch later fails.
    try {
      const $ = cheerio.load(html);
      $('a[href*="jobid="]').each((_i, el) => {
        const href = $(el).attr('href') ?? '';
        const idMatch = href.match(HRON_JOBID_PARAM_REGEX);
        if (!idMatch) return;
        const jobId = idMatch[1];
        const item = byId.get(jobId);
        if (!item) return;

        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text && !item.title && !/^(read more|læs mere|apply|ansøg)/i.test(text)) {
          item.title = text;
        }

        // Look for a sibling/ancestor block that carries the role's location.
        const $card = $(el).closest('li, article, .row, .job, .vacancy, div').first();
        const blockText = $card.text().replace(/\s+/g, ' ').trim();
        const loc = this.extractLocationFromBlock(blockText);
        if (loc && !item.location) item.location = loc;
      });
    } catch {
      // DOM enrichment is best-effort — the regex pass already populated ids.
    }

    return items;
  }

  /** Pull a "Work location : …" / "Arbejdssted : …" value out of block text. */
  private extractLocationFromBlock(blockText: string): string | null {
    if (!blockText) return null;
    const m = blockText.match(
      /(?:work location|arbejdssted|location|sted)\s*:\s*([^|]+?)(?:\s+(?:application deadline|ansøgningsfrist|read more|læs mere)\b|$)/i,
    );
    if (m) {
      const v = m[1].replace(/\s+/g, ' ').trim();
      return v || null;
    }
    return null;
  }

  /** Fetch a job-detail page and extract its fields. Null on error. */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    item: HrOnListingItem,
  ): Promise<HrOnJobDetail | null> {
    const html = await this.fetchHtml(client, item.detailUrl);
    if (!html) return null;
    try {
      return this.parseDetail(html);
    } catch (err: any) {
      this.logger.warn(`HR-ON: error parsing detail for ${item.jobId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Parse a job-detail HTML page. The schema.org `JobPosting` JSON-LD (when a
   * tenant theme injects one) is the richest source; the rendered HTML supplies
   * a layered fallback for title, location, and the description body.
   */
  private parseDetail(html: string): HrOnJobDetail {
    const $ = cheerio.load(html);
    const detail: HrOnJobDetail = {};

    const ld = this.extractJsonLd($);
    if (ld) {
      detail.title = this.cleanText(ld.title);
      detail.companyName = this.cleanText(ld.hiringOrganization?.name);
      detail.datePosted = this.parseDate(ld.datePosted);
      detail.employmentType = this.normaliseEmploymentType(ld.employmentType);
      detail.isRemote =
        typeof ld.jobLocationType === 'string' &&
        ld.jobLocationType.toUpperCase() === 'TELECOMMUTE';
      const address = this.firstAddress(ld);
      if (address) {
        detail.city = this.cleanText(address.addressLocality);
        detail.state = this.cleanText(address.addressRegion);
        detail.country = this.cleanText(
          typeof address.addressCountry === 'object'
            ? address.addressCountry?.name
            : address.addressCountry,
        );
      }
      if (ld.description && ld.description.trim()) {
        detail.descriptionHtml = ld.description.trim();
      }
    }

    // HTML fallbacks for title.
    if (!detail.title) {
      detail.title =
        this.cleanText($('h1').first().text()) ||
        this.cleanText($('h2').first().text()) ||
        this.cleanText($('title').first().text());
    }

    // Free-text location from the page body when JSON-LD lacked structure.
    if (!detail.city && !detail.state && !detail.country && !detail.location) {
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
      detail.location = this.extractLocationFromBlock(bodyText);
    }

    // Description body: prefer a content container, else the JSON-LD summary.
    if (!detail.descriptionHtml) {
      const container = $(
        '#jobpost, .jobpost, .job-description, .jobposts, .vacancy-description, article, main',
      ).first();
      const containerHtml = container.length ? container.html() : null;
      if (containerHtml && containerHtml.trim()) {
        detail.descriptionHtml = containerHtml.trim();
      }
    }

    return detail;
  }

  /**
   * Extract the schema.org `JobPosting` object from any
   * `<script type="application/ld+json">` block. Tolerates arrays and
   * `@graph` wrappers and silently skips unparseable blocks.
   */
  private extractJsonLd($: cheerio.CheerioAPI): HrOnJobPostingLd | null {
    let found: HrOnJobPostingLd | null = null;
    $('script[type="application/ld+json"]').each((_i, el) => {
      if (found) return;
      const raw = $(el).contents().text().trim();
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        const candidates: any[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.['@graph'])
            ? parsed['@graph']
            : [parsed];
        for (const c of candidates) {
          const type = c?.['@type'];
          const isJobPosting = Array.isArray(type)
            ? type.includes('JobPosting')
            : type === 'JobPosting';
          if (isJobPosting) {
            found = c as HrOnJobPostingLd;
            return;
          }
        }
      } catch {
        // Malformed JSON-LD block — skip it.
      }
    });
    return found;
  }

  /** Map a merged listing item + detail into a JobPostDto. Null when unusable. */
  private mapToJobPost(
    item: HrOnListingItem,
    detail: HrOnJobDetail | null,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const atsId = (item.jobId ?? '').trim();
    if (!atsId) return null;

    const title = (detail?.title ?? item.title ?? '').trim();
    if (!title) return null;

    const jobUrl = item.detailUrl;

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

    const companyName = detail?.companyName?.trim() || fallbackCompanyName;

    return new JobPostDto({
      id: `hron-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.buildLocation(item, detail),
      description,
      datePosted: detail?.datePosted ?? null,
      isRemote: this.detectRemote(item, detail),
      emails: extractEmails(description),
      site: Site.HRON,
      atsId,
      atsType: 'hron',
      department: detail?.employmentType ?? null,
      employmentType: detail?.employmentType ?? null,
      applyUrl: jobUrl,
    });
  }

  /**
   * Build a LocationDto, preferring the structured JSON-LD address and falling
   * back to the free-text location string from the detail page or listing.
   */
  private buildLocation(item: HrOnListingItem, detail: HrOnJobDetail | null): LocationDto | null {
    const city = detail?.city ?? null;
    const state = detail?.state ?? null;
    const country = detail?.country ?? null;
    if (city || state || country) {
      return new LocationDto({ city, state, country });
    }
    const raw = (detail?.location ?? item.location ?? '').trim();
    if (!raw) return null;
    // HR-ON free-text locations may list several sites comma-separated; the
    // first is used as the primary city.
    const primary = raw.split(/[,/|]/)[0].trim() || raw;
    return new LocationDto({ city: primary, state: null, country: null });
  }

  /** Detect remote roles from the JSON-LD flag or the title/location text. */
  private detectRemote(item: HrOnListingItem, detail: HrOnJobDetail | null): boolean {
    if (detail?.isRemote) return true;
    const haystacks = [detail?.title, item.title, detail?.location, item.location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('work from home') ||
        v.includes('hjemmearbejde') ||
        v.includes('distancearbejde')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve the tenant's career-page URL from `companyUrl` (preferred) or a
   * `companySlug`. A slug containing a dot or scheme is treated as a host/URL;
   * a bare slug is expanded against the HR-ON hosted career path.
   */
  private resolveCareerUrl(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companyUrl && companyUrl.trim()) {
      const u = companyUrl.trim();
      return /^https?:\/\//i.test(u) ? u : `https://${u}`;
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (/^https?:\/\//i.test(slug)) return slug;
      if (slug.includes('.') && slug.includes('/')) return `https://${slug}`;
      if (slug.includes('.')) return `https://${slug}${HRON_DEFAULT_CAREER_PATH}`;
      // Bare slug → HR-ON hosted career path.
      const path = HRON_CAREER_PATH_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
      return `${HRON_HOST}${path}`;
    }
    return '';
  }

  /** Build an absolute job-detail URL for a given origin + job id. */
  private buildDetailUrl(origin: string, jobId: string): string {
    const path = HRON_JOB_PATH_TEMPLATE.replace('{id}', encodeURIComponent(jobId));
    const base = origin.endsWith('/') ? origin.slice(0, -1) : origin;
    return `${base}${path}`;
  }

  /** Return the scheme+host origin of a URL string, or '' when malformed. */
  private originOf(url: string): string {
    try {
      const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      return `${u.protocol}//${u.host}`;
    } catch {
      return '';
    }
  }

  /** Derive a display company name from the slug or career-URL host. */
  private deriveCompanyName(companySlug: string | undefined, careerUrl: string): string {
    let base = companySlug?.trim();
    if (!base || base.includes('.') || base.includes('/')) {
      try {
        const host = new URL(
          /^https?:\/\//i.test(careerUrl) ? careerUrl : `https://${careerUrl}`,
        ).host;
        const labels = host.split('.').filter((l) => l && l !== 'www');
        // For an HR-ON-hosted slug page the first path segment is the tenant.
        base = labels.length > 1 ? labels[0] : host;
      } catch {
        base = careerUrl;
      }
    }
    return base
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/\..*$/, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Trim and collapse whitespace; return null for empty/nullish input. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.replace(/\s+/g, ' ').trim();
    return v || null;
  }

  /** Normalise a schema.org employmentType into a human-readable label. */
  private normaliseEmploymentType(value: string | string[] | null | undefined): string | null {
    if (!value) return null;
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw || typeof raw !== 'string') return null;
    return (
      raw
        .trim()
        .toLowerCase()
        .split(/[_\s]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ') || null
    );
  }

  /** Pull the first PostalAddress out of the JSON-LD jobLocation. */
  private firstAddress(ld: HrOnJobPostingLd) {
    const loc = ld.jobLocation;
    if (!loc) return null;
    const place = Array.isArray(loc) ? loc[0] : loc;
    return place?.address ?? null;
  }

  /** Parse an ISO-8601 date into a `YYYY-MM-DD` string. Null when unparseable. */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const parsed = new Date(value.trim());
      if (!isNaN(parsed.getTime())) return toDateOnly(value.trim());
    } catch {
      // ignore
    }
    return null;
  }
}
