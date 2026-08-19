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
  REXX_HOST_TEMPLATE,
  REXX_PORTAL_SUFFIX,
  REXX_LISTING_PATH,
  REXX_JOB_ID_REGEX,
  REXX_LISTING_CONTAINER_SELECTOR,
  REXX_JOB_CARD_SELECTOR,
  REXX_JOB_TITLE_SELECTOR,
  REXX_JOB_LEVEL_SELECTOR,
  REXX_JOB_LOCATION_SELECTOR,
  REXX_JOB_WORKMODE_SELECTOR,
  REXX_COUNT_ATTR,
  REXX_MAX_CONCURRENCY,
  REXX_REQUEST_DELAY_MS,
  REXX_DEFAULT_RESULTS,
  REXX_HEADERS,
} from './rexx.constants';
import {
  RexxListingItem,
  RexxJobPostingLd,
  RexxJob,
  RexxPlace,
  RexxPostalAddress,
} from './rexx.types';

/**
 * rexx systems career-portal scraper — generic, multi-tenant.
 *
 * rexx systems is a German HR / recruiting suite. Each customer tenant runs a
 * branded public job market served from `https://{tenant}-portal.rexx-systems.com`
 * (or a custom career domain). No anonymous JSON/XML feed is exposed; the public
 * surface is server-rendered HTML, so this adapter:
 *
 *   1. Fetches the listing page (`GET /stellenangebote.html`) and parses each
 *      `<article.joboffer_container>` card to extract the numeric job id, title,
 *      detail URL, location, work mode, and career level.
 *   2. Fan-outs (bounded `Promise.allSettled`) to each job-detail page
 *      (`/{slug}-de-j{id}.html`), which embeds a complete schema.org
 *      `JobPosting` JSON-LD object — the primary source for the description
 *      HTML, dates, employment type, structured address, and employer name.
 *
 * Tenant resolution: `companySlug` (the portal sub-domain label, e.g. `icotek`)
 * is preferred and expanded to `{tenant}-portal.rexx-systems.com`; otherwise a
 * fully qualified `companyUrl` origin is used verbatim.
 *
 * A missing tenant, an HTTP error, or a malformed payload degrades to an
 * empty/partial result — never throws — so a single tenant never aborts a
 * batch run. De-duplication is by numeric job id within the run.
 */
@SourcePlugin({
  site: Site.REXX,
  name: 'rexx systems',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class RexxService implements IScraper {
  private readonly logger = new Logger(RexxService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for rexx scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(input.companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve a rexx tenant host from input');
      return new JobResponseDto([]);
    }
    const fallbackCompanyName = this.deriveCompanyName(input.companySlug, host);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(REXX_HEADERS);

    const resultsWanted = input.resultsWanted ?? REXX_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching rexx job market for host: ${host}`);

      const listing = await this.fetchListing(client, host);
      if (!listing) {
        this.logger.warn(`rexx: no listing returned for ${host}`);
        return new JobResponseDto([]);
      }

      this.logger.log(
        `rexx listing parsed: ${listing.total} total reported, ` +
          `${listing.items.length} cards for ${host}`,
      );

      // De-dupe listing rows by job id and cap to resultsWanted before fan-out.
      const wantedItems: RexxListingItem[] = [];
      for (const item of listing.items) {
        const id = item.jobId ?? '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        wantedItems.push(item);
        if (wantedItems.length >= resultsWanted) break;
      }

      // Bounded concurrent fan-out over detail pages to fetch JSON-LD.
      for (let i = 0; i < wantedItems.length; i += REXX_MAX_CONCURRENCY) {
        const chunk = wantedItems.slice(i, i + REXX_MAX_CONCURRENCY);
        const settled = await Promise.allSettled(
          chunk.map((item) => this.fetchDetail(client, item)),
        );

        for (let j = 0; j < chunk.length; j += 1) {
          const item = chunk[j];
          const result = settled[j];
          let ld: RexxJobPostingLd | null = null;
          if (result.status === 'fulfilled') {
            ld = result.value;
          } else {
            this.logger.warn(
              `rexx detail fetch failed for job ${item.jobId}: ` +
                `${result.reason?.message ?? result.reason}`,
            );
          }

          try {
            const post = this.mapToJobPost(
              { ...item, ld },
              host,
              fallbackCompanyName,
              input.descriptionFormat,
            );
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(
              `rexx: error mapping job ${item.jobId}: ${err.message}`,
            );
          }
        }

        if (i + REXX_MAX_CONCURRENCY < wantedItems.length) {
          await randomSleep(REXX_REQUEST_DELAY_MS, REXX_REQUEST_DELAY_MS * 2);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`rexx total: ${trimmed.length} jobs for ${host}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`rexx scrape error for ${host}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Fetch and parse the public job-market listing page. Returns null when the
   * tenant is unknown (HTTP 4xx) or the body is empty.
   */
  private async fetchListing(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<{ items: RexxListingItem[]; total: number } | null> {
    const url = `${host}${REXX_LISTING_PATH}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html =
        typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (!html) return null;
      return this.parseListing(html, host);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 403 || status === 404) {
        this.logger.warn(`rexx tenant not found (HTTP ${status}) for ${host}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse the listing HTML into job rows. Extracts the total open-role count
   * from the container's `data-count` attribute (falling back to the card
   * count) and one {@link RexxListingItem} per `<article.joboffer_container>`.
   */
  private parseListing(
    html: string,
    host: string,
  ): { items: RexxListingItem[]; total: number } {
    const $ = cheerio.load(html);
    const items: RexxListingItem[] = [];

    let total = 0;
    const countRaw = $(REXX_LISTING_CONTAINER_SELECTOR).first().attr(REXX_COUNT_ATTR);
    if (countRaw) {
      const n = parseInt(countRaw, 10);
      if (!isNaN(n)) total = n;
    }

    $(REXX_JOB_CARD_SELECTOR).each((_i, card) => {
      try {
        const item = this.parseJobCard($, card, host);
        if (item) items.push(item);
      } catch (err: any) {
        this.logger.warn(`rexx: error parsing job card: ${err.message}`);
      }
    });

    if (total === 0) total = items.length;
    return { items, total };
  }

  /** Parse a single `<article.joboffer_container>` card into a listing item. */
  private parseJobCard(
    $: cheerio.CheerioAPI,
    card: any,
    host: string,
  ): RexxListingItem | null {
    const $card = $(card);

    // Detail URL: prefer the title anchor href; fall back to the onclick handler.
    const anchor = $card.find(REXX_JOB_TITLE_SELECTOR).first();
    let detailUrl = anchor.attr('href')?.trim() || null;
    if (!detailUrl) {
      const onclick = $card.attr('onclick') ?? '';
      const m = onclick.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
      if (m) detailUrl = m[1];
    }
    if (!detailUrl) return null;

    // Normalise to an absolute URL.
    if (!/^https?:\/\//i.test(detailUrl)) {
      detailUrl = detailUrl.startsWith('/')
        ? `${host}${detailUrl}`
        : `${host}/${detailUrl}`;
    }

    const jobId = this.extractJobId(detailUrl);
    if (!jobId) return null;

    const title = anchor.text().trim() || null;
    if (!title) return null;

    const location = $card.find(REXX_JOB_LOCATION_SELECTOR).first().text().trim() || null;
    const workMode = $card.find(REXX_JOB_WORKMODE_SELECTOR).first().text().trim() || null;
    const careerLevel = $card.find(REXX_JOB_LEVEL_SELECTOR).first().text().trim() || null;

    return { jobId, title, detailUrl, location, workMode, careerLevel };
  }

  /**
   * Fetch a detail page and extract its schema.org `JobPosting` JSON-LD block.
   * Returns null on error or when no JSON-LD JobPosting is present — the
   * listing row alone is enough to emit a partial JobPostDto.
   */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    item: RexxListingItem,
  ): Promise<RexxJobPostingLd | null> {
    const url = item.detailUrl;
    if (!url) return null;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html =
        typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (!html) return null;
      return this.extractJsonLd(html);
    } catch (err: any) {
      this.logger.warn(
        `rexx: detail page fetch failed for ${url}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Extract the schema.org `JobPosting` object from any
   * `<script type="application/ld+json">` block on the page. Tolerates
   * arrays and `@graph` wrappers, and silently skips unparseable blocks.
   */
  private extractJsonLd(html: string): RexxJobPostingLd | null {
    const $ = cheerio.load(html);
    let found: RexxJobPostingLd | null = null;

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
            found = c as RexxJobPostingLd;
            return;
          }
        }
      } catch {
        // Malformed JSON-LD block — skip it.
      }
    });

    return found;
  }

  /** Map a merged listing row + detail JSON-LD into a JobPostDto. */
  private mapToJobPost(
    job: RexxJob,
    host: string,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const ld = job.ld ?? null;

    const title = (ld?.title ?? job.title ?? '').trim();
    if (!title) return null;

    const atsId = (job.jobId ?? '').trim();
    if (!atsId) return null;

    const jobUrl = job.detailUrl ?? host;

    const rawDescription = this.buildDescriptionHtml(ld);
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

    const companyName =
      ld?.hiringOrganization?.name?.trim() || fallbackCompanyName;

    const department =
      this.normaliseEmploymentType(ld?.employmentType) ||
      job.careerLevel?.trim() ||
      null;

    return new JobPostDto({
      id: `rexx-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(ld?.datePosted),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.REXX,
      atsId,
      atsType: 'rexx',
      department,
      applyUrl: jobUrl,
    });
  }

  /**
   * Compose the full job description HTML from the JSON-LD parts, in the same
   * order they appear on the rendered page: intro, responsibilities,
   * qualifications, benefits. Returns null when none are present.
   */
  private buildDescriptionHtml(ld: RexxJobPostingLd | null): string | null {
    if (!ld) return null;
    const parts: string[] = [];
    const push = (label: string, value?: string | null) => {
      if (value && value.trim()) {
        parts.push(`<h3>${label}</h3>${value.trim()}`);
      }
    };
    if (ld.description && ld.description.trim()) parts.push(ld.description.trim());
    push('Aufgaben', ld.responsibilities);
    push('Qualifikation', ld.qualifications);
    push('Benefits', ld.jobBenefits);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  /** Resolve the tenant host origin from `companySlug` or `companyUrl`. */
  private resolveHost(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      let label = companySlug.trim().toLowerCase();
      // A slug containing a dot is treated as a bare host.
      if (label.includes('.')) {
        return /^https?:\/\//i.test(label) ? this.originOf(label) : `https://${label}`;
      }
      // Ensure the conventional "-portal" suffix on the sub-domain label.
      if (!label.endsWith(REXX_PORTAL_SUFFIX)) {
        label = `${label}${REXX_PORTAL_SUFFIX}`;
      }
      return REXX_HOST_TEMPLATE.replace(
        '{tenant}',
        encodeURIComponent(label.replace(new RegExp(`${REXX_PORTAL_SUFFIX}$`), '')),
      );
    }
    if (companyUrl && companyUrl.trim()) {
      return this.originOf(companyUrl.trim());
    }
    return '';
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

  /** Derive a display company name from the slug or host as a fallback. */
  private deriveCompanyName(
    companySlug: string | undefined,
    host: string,
  ): string {
    let base = companySlug?.trim();
    if (!base) {
      try {
        base = new URL(host).host.split('.')[0];
      } catch {
        base = host;
      }
    }
    return base
      .replace(/^https?:\/\//, '')
      .replace(new RegExp(`${REXX_PORTAL_SUFFIX}$`, 'i'), '')
      .replace(/\.(rexx-systems\.com).*$/i, '')
      .replace(/\..*$/, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Extract the numeric job id from a detail-page URL. */
  private extractJobId(url: string): string | null {
    const m = url.match(REXX_JOB_ID_REGEX);
    return m ? m[1] : null;
  }

  /**
   * Build a LocationDto from the structured JSON-LD address when available,
   * falling back to the free-text locality chip from the listing card.
   */
  private extractLocation(job: RexxJob): LocationDto | null {
    const address = this.firstAddress(job.ld?.jobLocation);
    if (address) {
      const city = address.addressLocality?.trim() || null;
      const state = address.addressRegion?.trim() || null;
      const country = address.addressCountry?.trim() || null;
      if (city || state || country) {
        return new LocationDto({ city, state, country });
      }
    }
    const raw = job.location?.trim();
    if (!raw) return null;
    return new LocationDto({ city: raw, state: null, country: null });
  }

  /** Pull the first PostalAddress out of a Place or array of Places. */
  private firstAddress(
    location: RexxPlace | RexxPlace[] | null | undefined,
  ): RexxPostalAddress | null {
    if (!location) return null;
    const place = Array.isArray(location) ? location[0] : location;
    return place?.address ?? null;
  }

  /**
   * Detect remote roles from the work-mode chip, the title, or the structured
   * location. rexx uses "Homeoffice / Mobil" for remote-capable roles.
   */
  private detectRemote(job: RexxJob): boolean {
    const haystacks = [job.workMode, job.title, job.location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('homeoffice') ||
        v.includes('home office') ||
        v.includes('remote') ||
        v.includes('mobil')
      ) {
        return true;
      }
    }
    return false;
  }

  /** Normalise a schema.org employmentType into a human-readable label. */
  private normaliseEmploymentType(
    value: string | string[] | null | undefined,
  ): string | null {
    if (!value) return null;
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw) return null;
    return raw
      .trim()
      .toLowerCase()
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') || null;
  }

  /**
   * Parse an ISO-8601 date string (e.g. "2026-04-30") into a `YYYY-MM-DD`
   * string. Returns null for null/undefined or unparseable inputs.
   */
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
