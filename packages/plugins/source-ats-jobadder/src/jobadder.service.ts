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
  JOBADDER_HOST,
  JOBADDER_LISTING_PATH_TEMPLATE,
  JOBADDER_JOB_PATH_TEMPLATE,
  JOBADDER_DEFAULT_RESULTS,
  JOBADDER_MAX_CONCURRENCY,
  JOBADDER_REQUEST_DELAY_MS,
  JOBADDER_HEADERS,
} from './jobadder.constants';
import { JobAdderListing, JobAdderTenant } from './jobadder.types';

/**
 * JobAdder ATS careers scraper — generic, multi-tenant.
 *
 * JobAdder serves every customer's public Careerpage from one shared host
 * (`https://clientapps.jobadder.com/{accountId}/{slug}`). The Careerpage is
 * server-rendered HTML (JobAdder's only anonymous, slug-addressable surface —
 * the structured v2 jobs API requires OAuth2), so we parse the listing markup
 * for each open role and lazily fetch each role's detail page for the full
 * description (bounded `Promise.allSettled` fan-out so a single slow detail
 * page never nukes the batch).
 *
 * The tenant (`{accountId}/{slug}`) is taken from `companySlug` (which may be
 * the bare slug, or the `{accountId}/{slug}` pair) or derived from a
 * `companyUrl`. A missing tenant, an unknown tenant (HTTP 404), or any fetch
 * error degrades to an empty / partial result rather than throwing, so a single
 * tenant never aborts a batch run.
 */
@SourcePlugin({
  site: Site.JOBADDER,
  name: 'JobAdder',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class JobAdderService implements IScraper {
  private readonly logger = new Logger(JobAdderService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for JobAdder scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a JobAdder tenant (accountId/slug) from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JOBADDER_HEADERS);

    const resultsWanted = input.resultsWanted ?? JOBADDER_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching JobAdder jobs for tenant: ${tenant.accountId}/${tenant.slug}`);

      const listingHtml = await this.fetchListing(client, tenant);
      if (!listingHtml) return new JobResponseDto([]);

      const companyName = this.deriveCompanyName(listingHtml, tenant.slug);
      const listings = this.parseListings(listingHtml, tenant).slice(0, resultsWanted);

      // Enrich each role with its full detail-page description, bounded fan-out.
      await this.enrichDescriptions(client, listings);

      for (const listing of listings) {
        try {
          const post = this.processJob(listing, tenant, companyName, input.descriptionFormat);
          if (!post) continue;
          // processJob guarantees a non-empty atsId (returns null otherwise).
          const key = post.atsId as string;
          if (seen.has(key)) continue;
          seen.add(key);
          jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing JobAdder job ${listing.jobId}: ${err.message}`);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`JobAdder total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`JobAdder scrape error for ${tenant.accountId}/${tenant.slug}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /** Fetch the tenant's Careerpage listing HTML; HTTP 404 (unknown tenant) → null. */
  private async fetchListing(
    client: ReturnType<typeof createHttpClient>,
    tenant: JobAdderTenant,
  ): Promise<string | null> {
    const url = `${JOBADDER_HOST}${this.buildListingPath(tenant)}`;
    try {
      const response = await client.get<string>(url);
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 404) {
        this.logger.warn(`JobAdder tenant "${tenant.accountId}/${tenant.slug}" not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /** Parse the Careerpage listing HTML into one record per open role. */
  private parseListings(html: string, tenant: JobAdderTenant): JobAdderListing[] {
    const listings: JobAdderListing[] = [];
    // Each role is a `<div ... class="... job_items">` card.
    const cardRegex = /<div[^>]*class="[^"]*\bjob_items\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bjob_items\b|<\/div>\s*<\/div>\s*<\/div>|$)/gi;
    let match: RegExpExecArray | null;
    while ((match = cardRegex.exec(html)) !== null) {
      const card = match[1];
      const listing = this.parseCard(card, tenant);
      if (listing) listings.push(listing);
    }
    return listings;
  }

  /** Parse a single listing card's inner HTML into a `JobAdderListing`. */
  private parseCard(card: string, tenant: JobAdderTenant): JobAdderListing | null {
    // Primary anchor → detail URL + title. The path encodes the numeric job id.
    const anchor = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*\bviewjob\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(card)
      ?? /<a[^>]+href="(\/[^"]*\/\d+\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(card);
    if (!anchor) return null;

    const href = anchor[1];
    const title = this.cleanText(anchor[2]);
    if (!title) return null;

    const path = href.startsWith('http') ? new URL(href).pathname : href;
    const idMatch = /\/(\d+)\/([^/?#]+)\/?$/.exec(path);
    if (!idMatch) return null;
    const jobId = idMatch[1];
    const titleSlug = idMatch[2];

    const dateMatch = /<sub[^>]*>([\s\S]*?)<\/sub>/i.exec(card);
    const datePostedText = dateMatch ? this.cleanText(dateMatch[1]) : null;

    const bulletItems: string[] = [];
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let li: RegExpExecArray | null;
    while ((li = liRegex.exec(card)) !== null) {
      const text = this.cleanText(li[1]);
      if (text) bulletItems.push(text);
    }

    const snippetMatch = /<p[^>]*class="[^"]*\bjob_snippet\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(card);
    const snippet = snippetMatch ? this.cleanText(snippetMatch[1]) : null;

    return {
      jobId,
      jobUrl: `${JOBADDER_HOST}${this.buildJobPath(tenant, jobId, titleSlug)}`,
      titleSlug,
      title,
      datePostedText,
      bulletItems,
      snippet,
    };
  }

  /** Fetch each role's detail page for the full description (bounded fan-out). */
  private async enrichDescriptions(
    client: ReturnType<typeof createHttpClient>,
    listings: JobAdderListing[],
  ): Promise<void> {
    for (let i = 0; i < listings.length; i += JOBADDER_MAX_CONCURRENCY) {
      const chunk = listings.slice(i, i + JOBADDER_MAX_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map((listing) => this.fetchDescription(client, listing.jobUrl)),
      );
      settled.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          chunk[idx].descriptionHtml = result.value;
        } else {
          this.logger.warn(
            `JobAdder detail fetch failed for ${chunk[idx].jobId}: ${result.reason?.message ?? result.reason}`,
          );
        }
      });
      if (i + JOBADDER_MAX_CONCURRENCY < listings.length) {
        await randomSleep(JOBADDER_REQUEST_DELAY_MS, JOBADDER_REQUEST_DELAY_MS * 2);
      }
    }
  }

  /** Fetch one job-detail page and extract its description HTML. */
  private async fetchDescription(
    client: ReturnType<typeof createHttpClient>,
    jobUrl: string,
  ): Promise<string | null> {
    const response = await client.get<string>(jobUrl);
    const html = typeof response.data === 'string' ? response.data : '';
    return this.extractDescriptionHtml(html);
  }

  /** Pull the full description HTML out of a detail page's `description` container. */
  private extractDescriptionHtml(html: string): string | null {
    if (!html) return null;
    const block =
      /<div[^>]*class="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html) ??
      /<div[^>]*id="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
    if (block && block[1] && block[1].trim()) return block[1].trim();
    return null;
  }

  private processJob(
    listing: JobAdderListing,
    tenant: JobAdderTenant,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = listing.title;
    if (!title) return null;

    const atsId = String(listing.jobId ?? '');
    if (!atsId) return null;

    const rawDescription = listing.descriptionHtml ?? listing.snippet ?? null;
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

    const { location, department, employmentType, isRemote } = this.classifyBullets(
      listing.bulletItems,
      title,
    );

    return new JobPostDto({
      id: `jobadder-${atsId}`,
      title,
      companyName,
      jobUrl: listing.jobUrl,
      location,
      description,
      datePosted: this.parseDate(listing.datePostedText),
      isRemote,
      emails: extractEmails(description),
      site: Site.JOBADDER,
      atsId,
      atsType: 'jobadder',
      department,
      employmentType,
      applyUrl: listing.jobUrl,
    });
  }

  /**
   * The Careerpage merges classifications, the free-text location, and the
   * employment type into one `<ul>`. Classify each bullet heuristically:
   * an entry containing a comma or a known place token is the location; an
   * entry ending in "Job" (e.g. "Permanent Job") is the employment type; the
   * remaining entries are classifications (department).
   */
  private classifyBullets(
    bullets: string[],
    title: string,
  ): {
    location: LocationDto | null;
    department: string | null;
    employmentType: string | null;
    isRemote: boolean;
  } {
    let locationText: string | null = null;
    let employmentType: string | null = null;
    const classifications: string[] = [];

    for (const bullet of bullets) {
      const lower = bullet.toLowerCase();
      if (/\bjob\b$/.test(lower) || /(permanent|contract|temporary|casual|part[- ]?time|full[- ]?time|fixed[- ]?term|internship)/.test(lower)) {
        if (!employmentType) employmentType = bullet;
        continue;
      }
      if (!locationText && (bullet.includes(',') || /\bremote\b/i.test(bullet))) {
        locationText = bullet;
        continue;
      }
      classifications.push(bullet);
    }

    // Fallback: if nothing matched the location heuristic, take the last bullet
    // that is not the employment type as a best-effort location.
    if (!locationText) {
      const candidate = classifications.length > 0 ? classifications[classifications.length - 1] : null;
      if (candidate) locationText = candidate;
    }

    const isRemote =
      (locationText ? /\bremote\b|work from home|wfh/i.test(locationText) : false) ||
      /\bremote\b|work from home|wfh/i.test(title);

    return {
      location: this.buildLocation(locationText),
      department: classifications.length > 0 ? classifications[0] : null,
      employmentType,
      isRemote,
    };
  }

  /** Build a `LocationDto` from a free-text "City, Region, Country"-style label. */
  private buildLocation(text: string | null): LocationDto | null {
    if (!text || !text.trim()) return null;
    const parts = text
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    const city = parts[0];
    const country = parts[parts.length - 1];
    const state = parts.length >= 3 ? parts[1] : null;
    return new LocationDto({ city: city ?? null, state: state ?? null, country: country ?? null });
  }

  /** Resolve the tenant (accountId + slug) from an explicit slug or a Careerpage URL. */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): JobAdderTenant | null {
    // companySlug may be "{accountId}/{slug}" or a bare slug.
    if (companySlug && companySlug.trim()) {
      const segments = companySlug.trim().replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
      if (segments.length >= 2 && /^\d+$/.test(segments[0])) {
        return { accountId: segments[0], slug: segments[1] };
      }
      // A bare slug is not enough to address a Careerpage (the account id is
      // mandatory); only accept it when paired with a numeric account id.
    }
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const segments = u.pathname.split('/').filter(Boolean);
        // Careerpage path: /{accountId}/{slug}[/{jobId}/{titleSlug}].
        if (segments.length >= 2 && /^\d+$/.test(segments[0])) {
          return { accountId: segments[0], slug: segments[1] };
        }
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return null;
  }

  /** Derive a display company name from the Careerpage `<title>` or the slug. */
  private deriveCompanyName(html: string, slug: string): string {
    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
    if (titleMatch) {
      const raw = this.cleanText(titleMatch[1]);
      // Careerpage titles read "Jobs at {Company}".
      const m = /jobs?\s+at\s+(.+)$/i.exec(raw);
      if (m && m[1].trim()) return m[1].trim();
    }
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private buildListingPath(tenant: JobAdderTenant): string {
    return JOBADDER_LISTING_PATH_TEMPLATE.replace('{accountId}', encodeURIComponent(tenant.accountId)).replace(
      '{slug}',
      encodeURIComponent(tenant.slug),
    );
  }

  private buildJobPath(tenant: JobAdderTenant, jobId: string, titleSlug: string): string {
    return JOBADDER_JOB_PATH_TEMPLATE.replace('{accountId}', encodeURIComponent(tenant.accountId))
      .replace('{slug}', encodeURIComponent(tenant.slug))
      .replace('{jobId}', encodeURIComponent(jobId))
      .replace('{titleSlug}', encodeURIComponent(titleSlug));
  }

  /** Strip tags / decode the common HTML entities and collapse whitespace. */
  private cleanText(html: string): string {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Parse a JobAdder date label ("20th May, 2026"), an epoch (sec/ms), or an ISO
   * string into a YYYY-MM-DD string.
   */
  private parseDate(value: string | number | null | undefined): string | null {
    if (value == null) return null;
    try {
      if (typeof value === 'number') {
        const ms = value > 1e12 ? value : value > 1e10 ? value : value * 1000;
        return toDateOnly(ms);
      }
      // Strip ordinal suffixes (1st, 2nd, 3rd, 20th) before parsing.
      const normalized = value.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
      const parsed = new Date(normalized);
      if (!isNaN(parsed.getTime())) return toDateOnly(normalized);
    } catch {
      // ignore
    }
    return null;
  }
}
