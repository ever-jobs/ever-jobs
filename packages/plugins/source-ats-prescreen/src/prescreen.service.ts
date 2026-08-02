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
  PRESCREEN_HOST_TEMPLATE,
  PRESCREEN_LEGACY_APEXES,
  PRESCREEN_JOB_DETAIL_PATH,
  PRESCREEN_JOB_FULL_PATH,
  PRESCREEN_FULL_QUERY,
  PRESCREEN_JOB_LIST_SELECTOR,
  PRESCREEN_JOB_ROW_SELECTOR,
  PRESCREEN_JOB_TITLE_SELECTOR,
  PRESCREEN_JOB_LOCATION_SELECTOR,
  PRESCREEN_MAX_CONCURRENCY,
  PRESCREEN_REQUEST_DELAY_MS,
  PRESCREEN_DEFAULT_RESULTS,
  PRESCREEN_HEADERS,
} from './prescreen.constants';
import {
  PrescreenListingItem,
  PrescreenJobPostingLd,
  PrescreenPlace,
  PrescreenJob,
} from './prescreen.types';

/**
 * Prescreen (prescreen.io) career-portal scraper — generic, multi-tenant.
 *
 * Prescreen is an Austrian cloud ATS (part of the XING / NEW WORK SE group).
 * Every customer tenant publishes a public, anonymous candidate career portal.
 * The candidate-facing host was rebranded from `{handle}.jobbase.io` /
 * `{handle}.prescreenapp.io` to the canonical `{handle}.onlyfy.jobs`; the legacy
 * hosts 301-redirect to it.
 *
 * The portal is server-rendered HTML — there is no anonymous JSON API (the
 * `api.prescreenapp.io` JSON feed requires an `apikey` header and is not used).
 * This adapter:
 *
 *   1. Fetches the listing page (`GET https://{handle}.onlyfy.jobs/`) and parses
 *      each `#jobList` row for the opaque job token, title, and location.
 *   2. Fans out (bounded `Promise.allSettled`) to each detail page
 *      (`GET /job/{token}`), extracting the `schema.org` `JobPosting` JSON-LD for
 *      structured fields (id, datePosted, employmentType, location, employer,
 *      remote flag), then fetches the full job-ad HTML fragment
 *      (`GET /job/show/{token}/full`) for the description body.
 *
 * The tenant `{handle}` is resolved from `input.companySlug` (preferred) or the
 * first sub-domain label of `input.companyUrl`. A single fetch error, an unknown
 * tenant, or a malformed payload degrades to an empty/partial result rather than
 * throwing, so a single tenant never aborts a batch run.
 */
@SourcePlugin({
  site: Site.PRESCREEN,
  name: 'Prescreen',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PrescreenService implements IScraper {
  private readonly logger = new Logger(PrescreenService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Prescreen scraper');
      return new JobResponseDto([]);
    }

    const handle = this.resolveHandle(input.companySlug, input.companyUrl);
    if (!handle) {
      this.logger.warn('Could not resolve a Prescreen tenant handle from input');
      return new JobResponseDto([]);
    }

    const host = PRESCREEN_HOST_TEMPLATE.replace('{handle}', encodeURIComponent(handle));
    const fallbackCompanyName = this.deriveCompanyName(handle);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(PRESCREEN_HEADERS);

    const resultsWanted = input.resultsWanted ?? PRESCREEN_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Prescreen jobs for handle: ${handle}`);

      const listing = await this.fetchListing(client, host);
      if (!listing || listing.length === 0) {
        this.logger.warn(`Prescreen: no jobs found for handle "${handle}"`);
        return new JobResponseDto([]);
      }

      const wanted = listing.slice(0, resultsWanted);

      // Bounded concurrent fan-out over the detail pages.
      for (let i = 0; i < wanted.length; i += PRESCREEN_MAX_CONCURRENCY) {
        if (jobPosts.length >= resultsWanted) break;
        const chunk = wanted.slice(i, i + PRESCREEN_MAX_CONCURRENCY);

        const settled = await Promise.allSettled(
          chunk.map((item) => this.fetchJob(client, host, item)),
        );

        for (const result of settled) {
          if (result.status === 'rejected') {
            this.logger.warn(
              `Prescreen detail fetch failed: ${result.reason?.message ?? result.reason}`,
            );
            continue;
          }
          const job = result.value;
          if (!job) continue;
          try {
            const post = this.mapToJobPost(job, host, fallbackCompanyName, input.descriptionFormat);
            if (!post) continue;
            const key = post.atsId as string;
            if (seen.has(key)) continue;
            seen.add(key);
            jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Prescreen job ${job.token}: ${err.message}`);
          }
        }

        if (i + PRESCREEN_MAX_CONCURRENCY < wanted.length && jobPosts.length < resultsWanted) {
          await randomSleep(PRESCREEN_REQUEST_DELAY_MS, PRESCREEN_REQUEST_DELAY_MS * 2);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Prescreen total: ${trimmed.length} jobs for ${fallbackCompanyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Prescreen scrape error for ${handle}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /**
   * Fetch the tenant portal landing page and parse every `#jobList` row.
   * Returns an empty array when the tenant is unknown or the page has no jobs.
   */
  private async fetchListing(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<PrescreenListingItem[]> {
    try {
      const response = await client.get<string>(`${host}/`, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      if (!html) return [];
      return this.parseListing(html, host);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 403 || status === 404) {
        this.logger.warn(`Prescreen tenant not found (HTTP ${status}) for ${host}`);
        return [];
      }
      throw err;
    }
  }

  /** Parse the `#jobList` rows of the portal landing page into listing items. */
  private parseListing(html: string, host: string): PrescreenListingItem[] {
    const $ = cheerio.load(html);
    const items: PrescreenListingItem[] = [];
    const seenTokens = new Set<string>();

    // Scope to the job list; fall back to the whole document (via the `:root`
    // selector) when the container class changed but the rows are still present.
    const list = $(PRESCREEN_JOB_LIST_SELECTOR);
    const rowScope = list.length ? `${PRESCREEN_JOB_LIST_SELECTOR} ${PRESCREEN_JOB_ROW_SELECTOR}` : PRESCREEN_JOB_ROW_SELECTOR;

    $(rowScope).each((_i, row) => {
      try {
        const item = this.parseRow($, row, host);
        if (!item || !item.token) return;
        if (seenTokens.has(item.token)) return;
        seenTokens.add(item.token);
        items.push(item);
      } catch (err: any) {
        this.logger.warn(`Prescreen: error parsing job row: ${err.message}`);
      }
    });

    // Layered fallback: if no rows matched (markup drift), harvest every
    // `/job/{token}` anchor on the page.
    if (items.length === 0) {
      $('a[href*="/job/"]').each((_i, a) => {
        const href = $(a).attr('href') ?? '';
        const token = this.extractToken(href);
        if (!token || seenTokens.has(token)) return;
        const title = $(a).text().trim();
        if (!title) return;
        seenTokens.add(token);
        items.push({
          token,
          title,
          location: null,
          detailUrl: `${host}${PRESCREEN_JOB_DETAIL_PATH.replace('{token}', token)}`,
        });
      });
    }

    return items;
  }

  /** Parse a single `#jobList` row element into a {@link PrescreenListingItem}. */
  private parseRow(
    $: cheerio.CheerioAPI,
    row: any,
    host: string,
  ): PrescreenListingItem | null {
    const $row = $(row);
    const anchor = $row.find(PRESCREEN_JOB_TITLE_SELECTOR).first();
    const href = anchor.attr('href') ?? $row.find('a[href*="/job/"]').first().attr('href') ?? '';
    const token = this.extractToken(href);
    if (!token) return null;

    const title =
      anchor.text().trim() || $row.find('a[href*="/job/"]').first().text().trim() || null;
    if (!title) return null;

    const location =
      $row.find(PRESCREEN_JOB_LOCATION_SELECTOR).first().text().trim() || null;

    return {
      token,
      title,
      location,
      detailUrl: `${host}${PRESCREEN_JOB_DETAIL_PATH.replace('{token}', token)}`,
    };
  }

  /**
   * Fetch a single job: the detail page (for the JSON-LD JobPosting) and the
   * full job-ad HTML fragment (for the description). Returns null only when the
   * detail page is entirely unusable; otherwise returns a best-effort record.
   */
  private async fetchJob(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    item: PrescreenListingItem,
  ): Promise<PrescreenJob | null> {
    const token = item.token;
    if (!token) return null;

    const detailUrl = item.detailUrl ?? `${host}${PRESCREEN_JOB_DETAIL_PATH.replace('{token}', token)}`;

    let ld: PrescreenJobPostingLd | null = null;
    try {
      const response = await client.get<string>(detailUrl, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      ld = this.extractJsonLd(html);
    } catch (err: any) {
      this.logger.warn(`Prescreen: detail fetch failed for ${token}: ${err.message}`);
    }

    // Full description body (best-effort; degrade to JSON-LD summary on failure).
    let descriptionHtml: string | null = null;
    try {
      const fullPath = PRESCREEN_JOB_FULL_PATH.replace('{token}', encodeURIComponent(token));
      const fullResponse = await client.get<string>(`${host}${fullPath}`, {
        params: { ...PRESCREEN_FULL_QUERY },
        responseType: 'text',
      });
      const fullHtml = typeof fullResponse.data === 'string' ? fullResponse.data : '';
      descriptionHtml = this.extractDescriptionFragment(fullHtml);
    } catch (err: any) {
      this.logger.warn(`Prescreen: full-ad fetch failed for ${token}: ${err.message}`);
    }

    if (!descriptionHtml && ld?.description) {
      descriptionHtml = ld.description;
    }

    const atsId = ld?.identifier?.value?.trim() || token;

    return {
      atsId,
      token,
      title: ld?.title?.trim() || item.title || null,
      descriptionHtml,
      listingLocation: item.location ?? null,
      ld,
      detailUrl,
    };
  }

  /**
   * Extract and parse the `schema.org` JobPosting JSON-LD block from a detail
   * page. Returns null when no JobPosting block is present or it fails to parse.
   */
  private extractJsonLd(html: string): PrescreenJobPostingLd | null {
    if (!html) return null;
    try {
      const $ = cheerio.load(html);
      let result: PrescreenJobPostingLd | null = null;
      $('script[type="application/ld+json"]').each((_i, el) => {
        const raw = $(el).contents().text().trim();
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw);
          const candidates = Array.isArray(parsed) ? parsed : [parsed];
          for (const c of candidates) {
            if (c && (c['@type'] === 'JobPosting' || c.title)) {
              result = c as PrescreenJobPostingLd;
              return false; // break
            }
          }
        } catch {
          // ignore unparseable JSON-LD blocks
        }
        return undefined;
      });
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Extract the job-ad body from the full fragment HTML. The fragment is a
   * standalone HTML document whose `<body>` holds the ad content; prefer the
   * body inner HTML and fall back to the whole fragment.
   */
  private extractDescriptionFragment(html: string): string | null {
    if (!html) return null;
    try {
      const $ = cheerio.load(html);
      const body = $('body');
      const inner = body.length ? body.html() : $.root().html();
      const trimmed = (inner ?? '').trim();
      return trimmed || null;
    } catch {
      return html.trim() || null;
    }
  }

  /** Map a merged {@link PrescreenJob} to a {@link JobPostDto}. */
  private mapToJobPost(
    job: PrescreenJob,
    host: string,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title?.trim();
    if (!title) return null;

    const atsId = job.atsId?.trim() || job.token?.trim() || '';
    if (!atsId) return null;

    const token = job.token ?? atsId;
    const jobUrl = job.detailUrl ?? `${host}${PRESCREEN_JOB_DETAIL_PATH.replace('{token}', encodeURIComponent(token))}`;

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

    const companyName = job.ld?.hiringOrganization?.name?.trim() || fallbackCompanyName;
    const department = job.ld?.employmentType?.trim() || null;

    return new JobPostDto({
      id: `prescreen-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.ld?.datePosted),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.PRESCREEN,
      atsId,
      atsType: 'prescreen',
      department,
      applyUrl: jobUrl,
    });
  }

  /**
   * Resolve the tenant handle from an explicit `companySlug` or from the first
   * sub-domain label of `companyUrl`. A legacy or canonical career-portal host
   * (`{handle}.onlyfy.jobs` / `.jobbase.io` / `.prescreenapp.io`) yields the
   * sub-domain label as the handle.
   */
  private resolveHandle(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      // A slug that is actually a portal host → take its first label.
      const slug = companySlug.trim();
      if (slug.includes('.')) {
        const label = this.firstLabel(slug);
        if (label) return label;
      }
      return slug;
    }
    if (companyUrl && companyUrl.trim()) {
      try {
        const u = new URL(companyUrl.trim());
        const label = this.firstLabel(u.hostname);
        if (label) return label;
      } catch {
        // Malformed URL — no handle recoverable.
      }
    }
    return '';
  }

  /**
   * Return the first meaningful sub-domain label of a hostname, skipping a
   * leading `www`. Returns null for an apex-only host.
   */
  private firstLabel(hostname: string): string | null {
    const labels = hostname
      .replace(/^https?:\/\//, '')
      .split(':')[0]
      .split('.')
      .filter(Boolean);
    if (labels.length === 0) return null;
    let first = labels[0];
    if (first === 'www' && labels.length > 1) first = labels[1];
    // Guard against passing a bare apex (e.g. "onlyfy.jobs") as a handle.
    const apexes = ['onlyfy', ...PRESCREEN_LEGACY_APEXES.map((a) => a.split('.')[0])];
    if (apexes.includes(first) && labels.length <= 2) return null;
    return first || null;
  }

  /**
   * Extract the opaque job token from a `/job/{token}` href. Accepts both the
   * listing href (`/job/{token}`) and any absolute URL variant. Returns null
   * when no token is present.
   */
  private extractToken(href: string | null | undefined): string | null {
    if (!href) return null;
    // Match the token segment after `/job/`, stopping before any further path
    // segment (e.g. `/job/{token}/full`) or query string.
    const match = href.match(/\/job\/([A-Za-z0-9]+)/);
    return match ? match[1] : null;
  }

  /** Derive a human-readable company name from the handle (used as a fallback). */
  private deriveCompanyName(handle: string): string {
    return handle
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Build a {@link LocationDto} from the JSON-LD `jobLocation.address`, falling
   * back to the free-text listing location label.
   */
  private extractLocation(job: PrescreenJob): LocationDto | null {
    const place = this.firstPlace(job.ld?.jobLocation);
    const address = place?.address;
    if (address && (address.addressLocality || address.addressRegion || address.addressCountry)) {
      return new LocationDto({
        city: address.addressLocality?.trim() || null,
        state: address.addressRegion?.trim() || null,
        country: address.addressCountry?.trim() || null,
      });
    }

    const label = job.listingLocation?.trim();
    if (!label) return null;
    const parts = label
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    return new LocationDto({
      city: parts[0] ?? null,
      state: parts.length >= 3 ? parts[1] : null,
      country: parts[parts.length - 1] ?? null,
    });
  }

  /** Normalise the JSON-LD `jobLocation` (Place or Place[]) to its first Place. */
  private firstPlace(
    jobLocation: PrescreenPlace | PrescreenPlace[] | null | undefined,
  ): PrescreenPlace | null {
    if (!jobLocation) return null;
    if (Array.isArray(jobLocation)) return jobLocation[0] ?? null;
    return jobLocation;
  }

  /**
   * Detect remote roles from the JSON-LD `jobLocationType` (`"TELECOMMUTE"`),
   * the title, the employment type, or the location label.
   */
  private detectRemote(job: PrescreenJob): boolean {
    if ((job.ld?.jobLocationType ?? '').toUpperCase() === 'TELECOMMUTE') return true;
    const haystacks = [
      job.title,
      job.listingLocation,
      job.ld?.employmentType,
      job.ld?.title,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('work from home') ||
        v.includes('wfh') ||
        v.includes('homeoffice') ||
        v.includes('home office') ||
        v.includes('telearbeit')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Parse a `YYYY-MM-DD` (JSON-LD `datePosted`) or other Date-parseable string
   * into a `YYYY-MM-DD` string. Returns null for null/undefined or unparseable.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const trimmed = value.trim();
      // Already an ISO date — return the date portion directly.
      const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) return isoMatch[1];
      const parsed = new Date(trimmed);
      if (!isNaN(parsed.getTime())) return toDateOnly(trimmed);
    } catch {
      // ignore
    }
    return null;
  }
}
