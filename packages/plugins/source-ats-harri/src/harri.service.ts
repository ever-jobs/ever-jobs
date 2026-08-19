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
  HARRI_HOST,
  HARRI_EMPLOYER_PATH_TEMPLATE,
  HARRI_JOB_HREF_REGEX,
  HARRI_MAX_CONCURRENCY,
  HARRI_REQUEST_DELAY_MS,
  HARRI_DEFAULT_RESULTS,
  HARRI_HEADERS,
} from './harri.constants';
import { HarriListJob, HarriDetailJob } from './harri.types';

/**
 * Harri hospitality hiring platform scraper — generic, multi-tenant.
 *
 * Harri (harri.com) is an all-in-one workforce management and talent
 * acquisition platform built for the hospitality and service industries.
 * Each employer tenant has a public careers page at `harri.com/{slug}`,
 * e.g. `https://harri.com/riverstation-careers`.
 *
 * Harri's underlying JSON API requires authentication and is deliberately NOT
 * used. Instead we:
 *
 *   1. Fetch the employer's careers page and parse all job-link hrefs from the
 *      server-rendered HTML. Each href follows the pattern
 *      `/{slug}/job/{jobId}-{titleSlug}`.
 *   2. Fan out with a bounded `Promise.allSettled` to each job-detail page to
 *      extract title, location, description, employment type, pay, and remote
 *      status from Open Graph meta tags and heuristic HTML extraction.
 *
 * Tenant resolution:
 *   - `input.companySlug` — preferred; the employer's slug,
 *     e.g. `riverstation-careers`.
 *   - `input.companyUrl` — fallback; the first path segment of the URL is
 *     used, e.g. `https://harri.com/riverstation-careers` → `riverstation-careers`.
 *
 * A single fetch failure, an unknown tenant (HTTP 404/410), or a malformed
 * page degrades to an empty/partial result rather than throwing, so a single
 * tenant never aborts a batch run.
 */
@SourcePlugin({
  site: Site.HARRI,
  name: 'Harri',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HarriService implements IScraper {
  private readonly logger = new Logger(HarriService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Harri scraper');
      return new JobResponseDto([]);
    }

    const employerSlug = this.resolveEmployerSlug(input.companySlug, input.companyUrl);
    if (!employerSlug) {
      this.logger.warn('Could not resolve a Harri employer slug from input');
      return new JobResponseDto([]);
    }

    const companyName = this.deriveCompanyName(employerSlug);
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(HARRI_HEADERS);

    const resultsWanted = input.resultsWanted ?? HARRI_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Harri careers page for employer: ${employerSlug}`);

      const listJobs = await this.fetchJobList(client, employerSlug);
      if (listJobs.length === 0) {
        this.logger.log(`Harri: no job links found for ${employerSlug}`);
        return new JobResponseDto([]);
      }

      const toFetch = listJobs.slice(0, resultsWanted);
      this.logger.log(
        `Harri: found ${listJobs.length} job links, fetching ${toFetch.length} details`,
      );

      // Bounded concurrent fan-out over job-detail pages.
      for (let i = 0; i < toFetch.length; i += HARRI_MAX_CONCURRENCY) {
        const chunk = toFetch.slice(i, i + HARRI_MAX_CONCURRENCY);
        const settled = await Promise.allSettled(
          chunk.map((listJob) => this.fetchJobDetail(client, listJob)),
        );

        for (let idx = 0; idx < settled.length; idx++) {
          const result = settled[idx];
          const listJob = chunk[idx];
          try {
            const detail =
              result.status === 'fulfilled'
                ? result.value
                : (() => {
                    this.logger.warn(
                      `Harri detail fetch failed for ${listJob.jobId}: ${
                        (result as PromiseRejectedResult).reason?.message ??
                        (result as PromiseRejectedResult).reason
                      }`,
                    );
                    return null;
                  })();

            const post = this.processJob(listJob, detail, companyName, input.descriptionFormat);
            if (!post) continue;
            const key = post.atsId as string;
            if (seen.has(key)) continue;
            seen.add(key);
            jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(
              `Harri job processing error for ${listJob.jobId}: ${err.message}`,
            );
          }
        }

        if (i + HARRI_MAX_CONCURRENCY < toFetch.length) {
          await randomSleep(HARRI_REQUEST_DELAY_MS, HARRI_REQUEST_DELAY_MS * 2);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Harri total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Harri scrape error for ${employerSlug}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Fetch the employer careers listing page and parse all job href stubs.
   * HTTP 404 / 410 (unknown tenant) → returns empty array without throwing.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    employerSlug: string,
  ): Promise<HarriListJob[]> {
    const path = HARRI_EMPLOYER_PATH_TEMPLATE.replace('{slug}', encodeURIComponent(employerSlug));
    const url = `${HARRI_HOST}${path}`;

    try {
      const response = await client.get<string>(url);
      const html: string = typeof response.data === 'string' ? response.data : '';
      return this.parseJobLinks(html);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 410) {
        this.logger.warn(`Harri employer not found (HTTP ${status}) for ${employerSlug}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Parse all job-detail href links from the employer's careers listing HTML.
   * Deduplicates by jobId at the parse level.
   */
  private parseJobLinks(html: string): HarriListJob[] {
    if (!html) return [];

    const results: HarriListJob[] = [];
    const seen = new Set<string>();
    // Extract all href attribute values from the HTML.
    const hrefRegex = /href="([^"]+)"/g;
    let match: RegExpExecArray | null;

    while ((match = hrefRegex.exec(html)) !== null) {
      const href = match[1];

      // Skip apply sub-pages (they share the same job URL prefix).
      if (href.includes('/apply')) continue;

      const jobMatch = HARRI_JOB_HREF_REGEX.exec(href);
      if (!jobMatch) continue;

      const employerSlug = jobMatch[1];
      const jobId = jobMatch[2];
      const titleSlug = jobMatch[3];

      if (seen.has(jobId)) continue;
      seen.add(jobId);

      const jobUrl = `${HARRI_HOST}${href.split('?')[0]}`;
      results.push({ jobUrl, jobId, employerSlug, titleSlug });
    }

    return results;
  }

  /**
   * Fetch a single job-detail page and extract rich data from the HTML.
   * HTTP 404 / 410 → returns null without throwing.
   */
  private async fetchJobDetail(
    client: ReturnType<typeof createHttpClient>,
    listJob: HarriListJob,
  ): Promise<HarriDetailJob | null> {
    try {
      const response = await client.get<string>(listJob.jobUrl);
      const html: string = typeof response.data === 'string' ? response.data : '';
      return this.parseJobDetail(html, listJob);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 410) {
        this.logger.warn(
          `Harri job detail not found (HTTP ${status}) for ${listJob.jobId}`,
        );
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse rich job data from a single job-detail page's HTML.
   * Uses Open Graph meta tags as the primary source; falls back to heuristic
   * regex extraction when meta tags are absent.
   */
  private parseJobDetail(html: string, listJob: HarriListJob): HarriDetailJob {
    if (!html) {
      return { applyUrl: `${listJob.jobUrl}/apply/${listJob.jobId}` };
    }

    // Title: prefer og:title, fall back to <h1>.
    const title =
      this.extractMetaContent(html, 'og:title') ??
      this.extractFirstTagContent(html, 'h1');

    // Company name: prefer og:site_name, fall back to the <title> element's trailing segment.
    const companyName =
      this.extractMetaContent(html, 'og:site_name') ??
      this.extractTitleCompanyName(html);

    // Description: extract the biggest descriptive HTML block.
    const description = this.extractDescription(html);

    // Location: try og:description first (often contains address), then address patterns.
    const locationResult = this.extractLocation(html);

    // Remote detection from title and HTML body text.
    const isRemote = this.detectRemote(html, title ?? '');

    // Employment type from common keyword patterns.
    const employmentType = this.extractEmploymentType(html);

    // Pay/compensation string if present.
    const payRaw = this.extractPayInfo(html);

    const applyUrl = `${listJob.jobUrl}/apply/${listJob.jobId}`;

    return {
      title,
      companyName,
      description,
      locationRaw: locationResult.raw,
      city: locationResult.city,
      state: locationResult.state,
      country: locationResult.country,
      isRemote,
      employmentType,
      payRaw,
      applyUrl,
    };
  }

  /** Map a list stub + detail → JobPostDto. */
  private processJob(
    listJob: HarriListJob,
    detail: HarriDetailJob | null,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const atsId = listJob.jobId;
    if (!atsId) return null;

    // Derive title: prefer detail title, fall back to humanising the URL slug.
    const title = detail?.title ?? this.humaniseSlug(listJob.titleSlug);
    if (!title) return null;

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

    const location = this.buildLocation(detail);

    return new JobPostDto({
      id: `harri-${atsId}`,
      title,
      companyName: detail?.companyName ?? fallbackCompanyName,
      jobUrl: listJob.jobUrl,
      location,
      description,
      datePosted: null, // Not available in the public HTML surface.
      isRemote: detail?.isRemote ?? this.detectRemoteFromSlug(listJob.titleSlug),
      emails: extractEmails(description),
      site: Site.HARRI,
      atsId,
      atsType: 'harri',
      department: null,
      employmentType: detail?.employmentType ?? null,
      applyUrl: detail?.applyUrl ?? `${listJob.jobUrl}/apply/${listJob.jobId}`,
    });
  }

  // ─── Resolution helpers ────────────────────────────────────────────────────

  /**
   * Resolve the employer slug from `companySlug` or by extracting the first
   * non-empty path segment of `companyUrl`.
   *
   * Examples:
   *   - `companySlug: 'riverstation-careers'` → `'riverstation-careers'`
   *   - `companyUrl: 'https://harri.com/riverstation-careers'` → `'riverstation-careers'`
   */
  private resolveEmployerSlug(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const parts = u.pathname.split('/').filter(Boolean);
        // The first path segment on harri.com is the employer slug.
        if (parts.length > 0 && parts[0] !== 'jobs') return parts[0];
      } catch {
        // Malformed URL — no slug recoverable.
      }
    }
    return '';
  }

  /** Derive a human-readable company name from the employer slug. */
  private deriveCompanyName(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Turn a hyphenated title slug into a human-readable title. */
  private humaniseSlug(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ─── HTML extraction helpers ───────────────────────────────────────────────

  /**
   * Extract a `<meta property="{prop}" content="...">` value.
   * Tries both attribute orderings (property-first and content-first).
   */
  private extractMetaContent(html: string, prop: string): string | null {
    const escapedProp = prop.replace(/\./g, '\\.');
    // property="..." content="..."
    const re1 = new RegExp(
      `<meta[^>]+property="${escapedProp}[^"]*"[^>]+content="([^"]*)"`,
      'i',
    );
    const m1 = re1.exec(html);
    if (m1) return this.cleanText(m1[1]);
    // content="..." property="..."
    const re2 = new RegExp(
      `<meta[^>]+content="([^"]*)"[^>]+property="${escapedProp}[^"]*"`,
      'i',
    );
    const m2 = re2.exec(html);
    return m2 ? this.cleanText(m2[1]) : null;
  }

  /** Extract the text content of the first occurrence of a given HTML tag. */
  private extractFirstTagContent(html: string, tag: string): string | null {
    const re = new RegExp(`<${tag}[^>]*>([^<]+)<\\/${tag}>`, 'i');
    const m = re.exec(html);
    return m ? this.cleanText(m[1]) : null;
  }

  /**
   * Attempt to extract a company name from the `<title>` element.
   * Many Harri pages use the pattern "Job Title - Company Name" in the title tag.
   */
  private extractTitleCompanyName(html: string): string | null {
    const titleContent = this.extractFirstTagContent(html, 'title');
    if (!titleContent) return null;
    // Take everything after the last " - " as the company name.
    const idx = titleContent.lastIndexOf(' - ');
    if (idx > 0) return this.cleanText(titleContent.slice(idx + 3));
    return null;
  }

  /**
   * Extract the job description from the page HTML.
   * Looks for the largest `<div>` / `<section>` / `<article>` block that
   * contains multiple paragraph or list-item tags — a reliable proxy for the
   * job description body on Harri's server-rendered detail pages.
   */
  private extractDescription(html: string): string | null {
    // Heuristic: find the block with the most <p> / <li> / <ul> / <ol> elements.
    const sectionRe =
      /<(?:div|section|article)[^>]*>([\s\S]{150,5000}?)<\/(?:div|section|article)>/gi;
    let bestBlock: string | null = null;
    let bestScore = 0;
    let m: RegExpExecArray | null;

    while ((m = sectionRe.exec(html)) !== null) {
      const block = m[1];
      const score = (block.match(/<[pli][^>]*>/g) ?? []).length;
      if (score > bestScore && block.length > 80) {
        bestScore = score;
        bestBlock = block;
      }
    }

    return bestBlock ?? null;
  }

  /** Extract an employment type string from the HTML body text. */
  private extractEmploymentType(html: string): string | null {
    const re = /\b(Full[\s-]?[Tt]ime|Part[\s-]?[Tt]ime|Contract|Temporary|Seasonal|Internship)\b/i;
    const m = re.exec(html);
    return m ? m[1] : null;
  }

  /** Extract a pay/compensation string from the HTML if present. */
  private extractPayInfo(html: string): string | null {
    const re =
      /(?:\$|£|€)[\d,]+(?:\.\d{1,2})?(?:\s*[-–]\s*(?:\$|£|€)?[\d,]+(?:\.\d{1,2})?)?\s*(?:per\s+(?:hour|hr|year|yr|week|month)|\/\s*(?:hr|hour|yr|year))/i;
    const m = re.exec(html);
    return m ? m[0].trim() : null;
  }

  /**
   * Extract a structured location from the HTML.
   * Primary: `og:description` meta (often contains the address on Harri pages).
   * Fallback: US-style "City, ST ZIP" address pattern anywhere in the HTML.
   */
  private extractLocation(
    html: string,
  ): { city: string | null; state: string | null; country: string | null; raw: string | null } {
    const ogDesc = this.extractMetaContent(html, 'og:description');
    if (ogDesc) {
      const loc = this.parseAddressString(ogDesc);
      if (loc.city || loc.state) return { ...loc, raw: ogDesc };
    }

    // US-style "City, ST ZIP" fallback.
    const usAddrRe = /([A-Za-z][A-Za-z\s]+),\s+([A-Z]{2})\s+\d{5}/;
    const usMatch = usAddrRe.exec(html);
    if (usMatch) {
      return {
        city: usMatch[1].trim(),
        state: usMatch[2].trim(),
        country: 'US',
        raw: usMatch[0],
      };
    }

    // UK postcode pattern fallback (Harri is heavily used in the UK hospitality sector).
    const ukAddrRe = /([A-Za-z][A-Za-z\s,.-]+),\s+([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/i;
    const ukMatch = ukAddrRe.exec(html);
    if (ukMatch) {
      return {
        city: ukMatch[1].replace(/,\s*$/, '').trim(),
        state: null,
        country: 'GB',
        raw: ukMatch[0],
      };
    }

    return { city: null, state: null, country: null, raw: null };
  }

  /**
   * Parse a free-text address or description string into city / state / country.
   * Handles US-style "City, ST" or "City, State" and simple comma-separated parts.
   */
  private parseAddressString(
    raw: string,
  ): { city: string | null; state: string | null; country: string | null } {
    // US: "San Jose, CA 95130" or "1030 El Paseo, San Jose, CA 95130".
    const usRe = /([A-Za-z][A-Za-z\s]+),\s+([A-Z]{2})(?:\s+\d{5})?/;
    const usMatch = usRe.exec(raw);
    if (usMatch) {
      return { city: usMatch[1].trim(), state: usMatch[2].trim(), country: 'US' };
    }
    // Generic comma-split.
    const parts = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      return { city: parts[0], state: parts[1], country: null };
    }
    return { city: null, state: null, country: null };
  }

  /** Build a LocationDto from the detail data. */
  private buildLocation(detail: HarriDetailJob | null): LocationDto | null {
    if (!detail) return null;
    if (detail.city || detail.state || detail.country) {
      return new LocationDto({
        city: detail.city ?? null,
        state: detail.state ?? null,
        country: detail.country ?? null,
      });
    }
    // Fall back to splitting the raw location string if structured parts are absent.
    if (detail.locationRaw) {
      const loc = this.parseAddressString(detail.locationRaw);
      if (loc.city || loc.state) {
        return new LocationDto({
          city: loc.city ?? null,
          state: loc.state ?? null,
          country: loc.country ?? null,
        });
      }
    }
    return null;
  }

  /** Detect remote roles from the HTML text and title. */
  private detectRemote(html: string, title: string): boolean {
    const text = (title + ' ' + html).toLowerCase();
    return (
      text.includes('remote') ||
      text.includes('work from home') ||
      text.includes('wfh') ||
      text.includes('fully remote') ||
      text.includes('anywhere')
    );
  }

  /** Detect remote from the title slug alone when detail is unavailable. */
  private detectRemoteFromSlug(slug: string): boolean {
    return slug.toLowerCase().includes('remote');
  }

  /** Trim, collapse whitespace, and return null for empty strings. */
  private cleanText(s: string): string | null {
    const t = s.replace(/\s+/g, ' ').trim();
    return t || null;
  }
}
