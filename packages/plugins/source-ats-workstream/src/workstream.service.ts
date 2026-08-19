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
  WORKSTREAM_HOST,
  WORKSTREAM_POSITIONS_PATH_TEMPLATE,
  WORKSTREAM_LOCALE_PARAM,
  WORKSTREAM_MAX_CONCURRENCY,
  WORKSTREAM_REQUEST_DELAY_MS,
  WORKSTREAM_DEFAULT_RESULTS,
  WORKSTREAM_HEADERS,
  WORKSTREAM_JOB_HREF_REGEX,
} from './workstream.constants';
import { WorkstreamListJob, WorkstreamDetailJob } from './workstream.types';

/**
 * Workstream hourly-hiring ATS scraper — generic, multi-tenant.
 *
 * Workstream (workstream.us) is an all-in-one HR and hiring platform for the
 * hourly/deskless workforce.  Every employer account is addressed by a short
 * opaque hex UUID and a brand slug, e.g. `36047dd7/jamba`.  Public careers
 * pages are served as server-rendered HTML at
 * `https://www.workstream.us/j/{accountId}/{brandSlug}`.
 *
 * There is no public anonymous JSON API — Workstream's REST API
 * (`public-api.workstream.us/positions`) requires OAuth2 bearer tokens and is
 * deliberately NOT used.  Instead we:
 *
 *   1. Fetch the positions listing page (`/j/{companyPath}/positions`) and
 *      extract all job-detail href links from the HTML.
 *   2. Fan out to each job-detail page with a bounded `Promise.allSettled` to
 *      hydrate the full description and structured location, limited to
 *      `resultsWanted`.
 *
 * Tenant resolution:
 *   - `input.companySlug` is the preferred source; expected format is
 *     `{accountId}/{brandSlug}` (e.g. `36047dd7/jamba`).
 *   - `input.companyUrl` is used as fallback — the `/j/…` path is extracted.
 *   - An unknown or dead tenant (HTTP 404, HTTP 410, or "Record does not exist"
 *     page) degrades to an empty result rather than throwing.
 *
 * A single fetch error or malformed page always degrades to a partial/empty
 * result, never throws out of `scrape()`, so a single tenant never nukes a
 * batch run.
 */
@SourcePlugin({
  site: Site.WORKSTREAM,
  name: 'Workstream',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class WorkstreamService implements IScraper {
  private readonly logger = new Logger(WorkstreamService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Workstream scraper');
      return new JobResponseDto([]);
    }

    const companyPath = this.resolveCompanyPath(input.companySlug, input.companyUrl);
    if (!companyPath) {
      this.logger.warn('Could not resolve a Workstream company path from input');
      return new JobResponseDto([]);
    }

    const companyName = this.deriveCompanyName(companyPath);
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(WORKSTREAM_HEADERS);

    const resultsWanted = input.resultsWanted ?? WORKSTREAM_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Workstream positions listing for: ${companyPath}`);

      const listJobs = await this.fetchPositionsList(client, companyPath);
      if (listJobs.length === 0) {
        this.logger.log(`Workstream: no positions found for ${companyPath}`);
        return new JobResponseDto([]);
      }

      const toFetch = listJobs.slice(0, resultsWanted);
      this.logger.log(`Workstream: found ${listJobs.length} job links, fetching ${toFetch.length} details`);

      // Bounded concurrent fan-out over detail pages.
      for (let i = 0; i < toFetch.length; i += WORKSTREAM_MAX_CONCURRENCY) {
        const chunk = toFetch.slice(i, i + WORKSTREAM_MAX_CONCURRENCY);
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
                      `Workstream detail fetch failed for ${listJob.jobId}: ${
                        (result as PromiseRejectedResult).reason?.message ??
                        (result as PromiseRejectedResult).reason
                      }`,
                    );
                    return null;
                  })();

            const post = this.processJob(listJob, detail, companyName, input.descriptionFormat);
            if (!post) continue;
            if (seen.has(post.atsId as string)) continue;
            seen.add(post.atsId as string);
            jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(
              `Workstream job processing error for ${listJob.jobId}: ${err.message}`,
            );
          }
        }

        if (i + WORKSTREAM_MAX_CONCURRENCY < toFetch.length) {
          await randomSleep(WORKSTREAM_REQUEST_DELAY_MS, WORKSTREAM_REQUEST_DELAY_MS * 2);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Workstream total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Workstream scrape error for ${companyPath}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Fetch the positions listing page and extract all job-link stubs.
   * HTTP 404 / 410 / "Record does not exist" → returns empty array (no throw).
   */
  private async fetchPositionsList(
    client: ReturnType<typeof createHttpClient>,
    companyPath: string,
  ): Promise<WorkstreamListJob[]> {
    const path = WORKSTREAM_POSITIONS_PATH_TEMPLATE.replace('{companyPath}', companyPath);
    const url = `${WORKSTREAM_HOST}${path}`;

    try {
      const response = await client.get<string>(url);
      const html: string = typeof response.data === 'string' ? response.data : '';
      return this.parseJobLinks(html, companyPath);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 410) {
        this.logger.warn(`Workstream company not found (HTTP ${status}) for ${companyPath}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Parse all job href links from the positions listing HTML.
   * Each link contains the location slug, job slug, and 8-char hex job id.
   */
  private parseJobLinks(html: string, companyPath: string): WorkstreamListJob[] {
    if (!html || html.includes('Record does not exist')) {
      return [];
    }

    const results: WorkstreamListJob[] = [];
    // Extract all href attributes from anchor tags in the HTML.
    const hrefRegex = /href="([^"]+)"/g;
    let match: RegExpExecArray | null;

    while ((match = hrefRegex.exec(html)) !== null) {
      const href = match[1];
      const jobMatch = WORKSTREAM_JOB_HREF_REGEX.exec(href);
      if (!jobMatch) continue;

      const locationSlug = jobMatch[1];
      const jobSlug = jobMatch[2];
      const jobId = jobMatch[3];

      // Skip apply sub-pages and already-seen jobs.
      if (href.includes('/apply')) continue;

      const jobUrl = href.startsWith('http')
        ? href.split('?')[0]
        : `${WORKSTREAM_HOST}${href.split('?')[0]}`;

      results.push({ jobUrl, jobId, locationSlug, jobSlug });
    }

    // De-duplicate by jobId at the list-parse level.
    const seen = new Set<string>();
    return results.filter((j) => {
      if (seen.has(j.jobId)) return false;
      seen.add(j.jobId);
      return true;
    });
  }

  /**
   * Fetch a single job detail page and extract rich job data.
   * HTTP 404 / 410 → returns null (no throw).
   */
  private async fetchJobDetail(
    client: ReturnType<typeof createHttpClient>,
    listJob: WorkstreamListJob,
  ): Promise<WorkstreamDetailJob | null> {
    const url = `${listJob.jobUrl}?${WORKSTREAM_LOCALE_PARAM}`;
    try {
      const response = await client.get<string>(url);
      const html: string = typeof response.data === 'string' ? response.data : '';
      return this.parseJobDetail(html, listJob.jobUrl);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 410) {
        this.logger.warn(`Workstream job detail not found (HTTP ${status}) for ${listJob.jobId}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse rich job data from an individual job detail HTML page.
   * Uses lightweight regex-based extraction to avoid a heavy DOM parser dependency.
   */
  private parseJobDetail(html: string, jobUrl: string): WorkstreamDetailJob {
    if (!html) return { applyUrl: `${jobUrl}/apply?${WORKSTREAM_LOCALE_PARAM}` };

    // Title: look for the primary h1 or og:title meta.
    const title =
      this.extractMetaContent(html, 'og:title') ??
      this.extractFirstTagContent(html, 'h1');

    // Company name: look for og:site_name or a branded header element.
    const companyName =
      this.extractMetaContent(html, 'og:site_name') ??
      this.extractFirstTagContent(html, 'title')
        ?.split(' - ')
        ?.pop()
        ?.trim() ??
      null;

    // Description: take the largest block of content inside typical job description wrappers.
    const description = this.extractDescription(html);

    // Employment type: look for text patterns.
    const employmentType = this.extractEmploymentType(html);

    // Pay: look for pay-rate text patterns.
    const payRaw = this.extractPayInfo(html);

    // Location: parse from og:description or address-like text.
    const locationParts = this.extractLocation(html);

    // Remote detection.
    const isRemote = this.detectRemote(html, title ?? '');

    const applyUrl = `${jobUrl}/apply?${WORKSTREAM_LOCALE_PARAM}`;

    return {
      title,
      companyName,
      description,
      employmentType,
      payRaw,
      city: locationParts.city,
      state: locationParts.state,
      country: locationParts.country,
      addressRaw: locationParts.raw,
      isRemote,
      applyUrl,
    };
  }

  /** Map list job + detail data → JobPostDto. */
  private processJob(
    listJob: WorkstreamListJob,
    detail: WorkstreamDetailJob | null,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const atsId = listJob.jobId;
    if (!atsId) return null;

    // Derive a readable title: prefer detail title, fall back to humanising the slug.
    const title = detail?.title ?? this.humaniseSlug(listJob.jobSlug);
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

    const location = this.buildLocation(detail, listJob.locationSlug);

    return new JobPostDto({
      id: `workstream-${atsId}`,
      title,
      companyName: detail?.companyName ?? fallbackCompanyName,
      jobUrl: listJob.jobUrl,
      location,
      description,
      datePosted: null, // Not available in the public HTML surface.
      isRemote: detail?.isRemote ?? this.detectRemoteFromSlug(listJob.jobSlug),
      emails: extractEmails(description),
      site: Site.WORKSTREAM,
      atsId,
      atsType: 'workstream',
      department: null,
      employmentType: detail?.employmentType ?? null,
      applyUrl: detail?.applyUrl ?? `${listJob.jobUrl}/apply?${WORKSTREAM_LOCALE_PARAM}`,
    });
  }

  // ─── Resolution helpers ────────────────────────────────────────────────────

  /**
   * Resolve the `{accountId}/{brandSlug}` company path from caller input.
   * Accepts:
   *   - `companySlug` like `36047dd7/jamba` (preferred)
   *   - `companyUrl`  like `https://www.workstream.us/j/36047dd7/jamba`
   */
  private resolveCompanyPath(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        // Expect path like /j/{accountId}/{brandSlug} or /j/{accountId}/{brandSlug}/...
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts[0] === 'j' && parts.length >= 3) {
          return `${parts[1]}/${parts[2]}`;
        }
        // Fallback: return everything after /j/
        if (parts[0] === 'j' && parts.length === 2) {
          return parts[1];
        }
      } catch {
        // Malformed URL — no path recoverable.
      }
    }
    return '';
  }

  /** Build a human-readable company name from the company path. */
  private deriveCompanyName(companyPath: string): string {
    // Take the slug portion after the UUID (the part after the first `/`).
    const slug = companyPath.includes('/') ? companyPath.split('/')[1] : companyPath;
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Turn a hyphenated job slug into a human-readable title. */
  private humaniseSlug(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ─── HTML extraction helpers ───────────────────────────────────────────────

  /** Extract a `<meta property="{prop}" content="...">` value. */
  private extractMetaContent(html: string, prop: string): string | null {
    const re = new RegExp(
      `<meta[^>]+property="${prop.replace(/\./g, '\\.')}[^"]*"[^>]+content="([^"]*)"`,
      'i',
    );
    const m = re.exec(html);
    if (m) return this.cleanText(m[1]);
    // Also try reversed attribute order.
    const re2 = new RegExp(
      `<meta[^>]+content="([^"]*)"[^>]+property="${prop.replace(/\./g, '\\.')}[^"]*"`,
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
   * Extract the job description from the HTML. Workstream detail pages contain
   * the description in a large block. We take the biggest contiguous HTML
   * fragment that contains paragraph/list content to approximate the description.
   */
  private extractDescription(html: string): string | null {
    // Try to find a large contiguous block of descriptive HTML.
    // Look for sections that have multiple <p> or <li> tags.
    const sectionRe = /<(?:div|section|article)[^>]*>([\s\S]{200,4000}?)<\/(?:div|section|article)>/gi;
    let bestBlock: string | null = null;
    let bestScore = 0;
    let m: RegExpExecArray | null;

    while ((m = sectionRe.exec(html)) !== null) {
      const block = m[1];
      // Score: number of <p> and <li> tags (more = more likely to be description).
      const score = (block.match(/<[pli][^>]*>/g) ?? []).length;
      if (score > bestScore && block.length > 100) {
        bestScore = score;
        bestBlock = block;
      }
    }

    return bestBlock ?? null;
  }

  /** Extract employment type (Full-time, Part-time) from HTML. */
  private extractEmploymentType(html: string): string | null {
    const re = /\b(Full-?time|Part-?time|Contract|Temporary|Seasonal|Internship)\b/i;
    const m = re.exec(html);
    return m ? m[1] : null;
  }

  /** Extract a pay/compensation string (e.g. "$17.13 - 20.00 per hour") from HTML. */
  private extractPayInfo(html: string): string | null {
    // Look for dollar-amount patterns followed by an interval word.
    const re = /\$[\d,]+(?:\.\d{1,2})?(?:\s*[-–]\s*[\d,]+(?:\.\d{1,2})?)?\s*(?:per\s+(?:hour|hr|year|yr|week|month)|\/\s*(?:hr|hour|yr|year))/i;
    const m = re.exec(html);
    return m ? m[0].trim() : null;
  }

  /** Extract structured location parts from the HTML. */
  private extractLocation(
    html: string,
  ): { city: string | null; state: string | null; country: string | null; raw: string | null } {
    // Try the og:description meta which often contains the address.
    const ogDesc = this.extractMetaContent(html, 'og:description');
    if (ogDesc) {
      const loc = this.parseAddressString(ogDesc);
      if (loc.city || loc.state) return { ...loc, raw: ogDesc };
    }

    // Look for a US-style address pattern: "City, ST ZIP" or "City, State ZIP".
    const addrRe =
      /([A-Za-z\s]+),\s+([A-Z]{2})\s+\d{5}/;
    const addrMatch = addrRe.exec(html);
    if (addrMatch) {
      return {
        city: addrMatch[1].trim(),
        state: addrMatch[2].trim(),
        country: 'US',
        raw: addrMatch[0],
      };
    }

    return { city: null, state: null, country: null, raw: null };
  }

  /** Parse a free-text address string into city / state / country parts. */
  private parseAddressString(
    raw: string,
  ): { city: string | null; state: string | null; country: string | null } {
    // Matches patterns like "San Jose, CA 95130" or "1030 El Paseo, San Jose, CA 95130".
    const re = /([A-Za-z][A-Za-z\s]+),\s+([A-Z]{2})(?:\s+\d{5})?/;
    const m = re.exec(raw);
    if (m) {
      return { city: m[1].trim(), state: m[2].trim(), country: 'US' };
    }
    // Comma-split fallback.
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return { city: parts[0], state: parts[1], country: null };
    }
    return { city: null, state: null, country: null };
  }

  /** Build a LocationDto from detail data, falling back to the location slug. */
  private buildLocation(
    detail: WorkstreamDetailJob | null,
    locationSlug: string,
  ): LocationDto | null {
    if (detail?.city || detail?.state) {
      return new LocationDto({
        city: detail.city ?? null,
        state: detail.state ?? null,
        country: detail.country ?? null,
      });
    }
    // Fall back to humanising the location slug (e.g. "san-jose-5497" → "San Jose").
    if (locationSlug) {
      const city = locationSlug
        .replace(/-\d+$/, '') // strip trailing numeric location id
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      return new LocationDto({ city, state: null, country: null });
    }
    return null;
  }

  /** Detect remote roles from the HTML page. */
  private detectRemote(html: string, title: string): boolean {
    const text = (title + ' ' + html).toLowerCase();
    return (
      text.includes('remote') ||
      text.includes('work from home') ||
      text.includes('wfh') ||
      text.includes('anywhere')
    );
  }

  /** Detect remote from just the job slug when no detail is available. */
  private detectRemoteFromSlug(slug: string): boolean {
    return slug.toLowerCase().includes('remote');
  }

  /** Trim and clean a raw string extracted from HTML. */
  private cleanText(s: string): string | null {
    const t = s.replace(/\s+/g, ' ').trim();
    return t || null;
  }
}
