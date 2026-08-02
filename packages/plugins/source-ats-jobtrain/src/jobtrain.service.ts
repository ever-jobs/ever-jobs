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
  toDateOnly,
} from '@ever-jobs/common';
import {
  JOBTRAIN_HOST,
  JOBTRAIN_ROOT_DOMAIN,
  JOBTRAIN_JOBCARD_PATH_TEMPLATE,
  JOBTRAIN_JOBDETAIL_PATH_TEMPLATE,
  JOBTRAIN_JOBID_REGEX,
  JOBTRAIN_LDJSON_REGEX,
  JOBTRAIN_REMOTE_REGEX,
  JOBTRAIN_DEFAULT_RESULTS,
  JOBTRAIN_DEFAULT_TIMEOUT_SECONDS,
  JOBTRAIN_HEADERS,
} from './jobtrain.constants';
import { JobtrainJob, JobtrainJobPosting } from './jobtrain.types';

/**
 * Jobtrain ATS careers scraper — generic, multi-tenant.
 *
 * Jobtrain (jobtrain.co.uk, UK) hosts every customer's career site under a
 * tenant path on the shared career host (`https://www.jobtrain.co.uk/{tenant}/`).
 * The listing page is rendered client-side, so the adapter instead enumerates a
 * tenant's live roles from the public `_JobCard` HTML partial
 * (`GET /{tenant}/Home/_JobCard`, which lists every open
 * `/{tenant}/Job/JobDetail?JobId={id}` card) and parses each server-rendered
 * detail page for its schema.org `JobPosting` JSON-LD block (title, datePosted,
 * employmentType, location, hiring organisation, HTML body).
 *
 * The caller addresses a tenant by `companySlug` (the career path segment, e.g.
 * `crossreach`) or by `companyUrl` (any page on the tenant career path, whose
 * first path segment is the tenant). The `_JobCard` partial lists every live
 * role in one document — there is no server-side pagination of the job set — so
 * we enumerate once and fetch only as many detail pages as the caller asked for
 * to honour `resultsWanted`. A single fetch error, an unknown tenant (HTTP 4xx),
 * or a malformed page degrades to an empty / partial result rather than
 * throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.JOBTRAIN,
  name: 'Jobtrain',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class JobtrainService implements IScraper {
  private readonly logger = new Logger(JobtrainService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Jobtrain scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Jobtrain tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      // Bound the per-request timeout. The createHttpClient factory keys off
      // `requestTimeout` (seconds), and ScraperInputDto defaults requestTimeout
      // to 60s — longer than callers' budgets — so we CAP it rather than rely on
      // a fallback. `www.jobtrain.co.uk` can connect-then-hang on an unknown or
      // overloaded tenant; capping at 15s keeps the graceful-degradation path
      // fast. A caller may still request a shorter timeout; we only bound the top.
      requestTimeout: Math.min(
        input.requestTimeout ?? JOBTRAIN_DEFAULT_TIMEOUT_SECONDS,
        JOBTRAIN_DEFAULT_TIMEOUT_SECONDS,
      ),
    });
    client.setHeaders(JOBTRAIN_HEADERS);

    const resultsWanted = input.resultsWanted ?? JOBTRAIN_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Jobtrain job cards for tenant: ${tenant}`);

      // The card partial enumerates every live role for the tenant in one doc.
      const jobIds = await this.fetchJobIds(client, tenant);
      if (jobIds.length === 0) {
        this.logger.log(`Jobtrain tenant "${tenant}" has no live roles`);
        return new JobResponseDto([]);
      }

      // Only fetch as many detail pages as the caller asked for (deduped first).
      const wanted = jobIds.filter((id) => !seen.has(id) && seen.add(id)).slice(0, resultsWanted);

      for (const jobId of wanted) {
        try {
          const post = await this.processJob(client, tenant, jobId, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Jobtrain job ${jobId}: ${err.message}`);
        }
      }

      this.logger.log(`Jobtrain total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Jobtrain scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Fetch the tenant's `_JobCard` partial and extract its distinct job ids. An
   * unknown tenant (HTTP 4xx) or an empty / unparseable partial degrades to an
   * empty list.
   */
  private async fetchJobIds(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<string[]> {
    const url = `${JOBTRAIN_HOST}${JOBTRAIN_JOBCARD_PATH_TEMPLATE.replace(
      '{tenant}',
      encodeURIComponent(tenant),
    )}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      return this.parseJobIds(html);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Jobtrain card partial not found (HTTP ${status}) at ${url}`);
        return [];
      }
      throw err;
    }
  }

  /** Extract the distinct numeric job ids from the `_JobCard` HTML fragment. */
  private parseJobIds(html: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const re = new RegExp(JOBTRAIN_JOBID_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const id = match[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  /** Fetch + parse a single detail page, then map it to a JobPostDto. */
  private async processJob(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    jobId: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const url = `${JOBTRAIN_HOST}${JOBTRAIN_JOBDETAIL_PATH_TEMPLATE.replace(
      '{tenant}',
      encodeURIComponent(tenant),
    ).replace('{jobId}', encodeURIComponent(jobId))}`;

    let html = '';
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      html = typeof response.data === 'string' ? response.data : '';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        // A closed / removed role 404s; skip it without failing the batch.
        this.logger.warn(`Jobtrain job ${jobId} not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }

    const job: JobtrainJob = { jobId, url, posting: this.parsePosting(html) };
    return this.mapJob(job, tenant, format);
  }

  /**
   * Parse the first schema.org `JobPosting` JSON-LD block from a detail page. A
   * page may carry several JSON-LD scripts (breadcrumbs, organisation, …); we
   * return the first one whose `@type` is `JobPosting`.
   */
  private parsePosting(html: string): JobtrainJobPosting | null {
    const re = new RegExp(JOBTRAIN_LDJSON_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const raw = (match[1] ?? '').trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(this.decodeEntities(raw));
        const node = this.findJobPosting(parsed);
        if (node) return node;
      } catch {
        // Malformed JSON-LD block — try the next script tag.
      }
    }
    return null;
  }

  /**
   * Locate the `JobPosting` node within a parsed JSON-LD value, tolerating a
   * bare object, an array of nodes, or an `@graph` wrapper.
   */
  private findJobPosting(value: any): JobtrainJobPosting | null {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findJobPosting(item);
        if (found) return found;
      }
      return null;
    }
    if (this.isJobPostingType(value['@type'])) return value as JobtrainJobPosting;
    if (Array.isArray(value['@graph'])) return this.findJobPosting(value['@graph']);
    return null;
  }

  /** True when a JSON-LD `@type` value denotes a `JobPosting`. */
  private isJobPostingType(type: unknown): boolean {
    if (typeof type === 'string') return type.toLowerCase() === 'jobposting';
    if (Array.isArray(type)) return type.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
    return false;
  }

  /** Map a normalised JobtrainJob → JobPostDto. */
  private mapJob(
    job: JobtrainJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const posting = job.posting;
    if (!posting) return null;

    const title = this.cleanText(posting.title);
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    // Prefer the clean detail URL we fetched (no `&Source=` tracking suffix);
    // fall back to the canonical `url` the posting advertises.
    const jobUrl = job.url || this.cleanText(posting.url);
    if (!jobUrl) return null;

    const companyName = this.deriveCompanyName(posting.hiringOrganization?.name, tenant);
    const rawHtml = this.cleanText(posting.description);
    const description = this.formatDescription(rawHtml, format);

    return new JobPostDto({
      id: `jobtrain-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(posting),
      description,
      datePosted: this.parseDate(posting.datePosted),
      isRemote: this.detectRemote(posting),
      emails: extractEmails(description),
      site: Site.JOBTRAIN,
      atsId,
      atsType: 'jobtrain',
      department: this.extractDepartment(posting),
      employmentType: this.cleanText(posting.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The JSON-LD `description`
   * is an HTML body; we surface it as HTML, Markdown, or plain text on request,
   * defaulting to plain text.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the Jobtrain tenant path segment from an explicit `companySlug` or
   * from a `companyUrl` on the `jobtrain.co.uk` host (its first path segment).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim().toLowerCase();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.toLowerCase();
        if (hostname.endsWith(JOBTRAIN_ROOT_DOMAIN)) {
          const segments = u.pathname.split('/').filter(Boolean);
          // The tenant is the first path segment (e.g. `/crossreach/Home/Job`).
          if (segments.length > 0) return decodeURIComponent(segments[0]).toLowerCase();
        }
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : tenant) || tenant;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Map the JSON-LD `jobLocation.address` (`PostalAddress`) to a `LocationDto`.
   * Returns null when no usable location part is present (never fabricated).
   */
  private extractLocation(posting: JobtrainJobPosting): LocationDto | null {
    const address = posting.jobLocation?.address;
    if (!address) return null;
    const city = this.cleanText(address.addressLocality);
    const state = this.cleanText(address.addressRegion);
    const country = this.cleanText(address.addressCountry);
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Surface the hiring organisation's department, when the posting names one. */
  private extractDepartment(posting: JobtrainJobPosting): string | null {
    // schema.org JobPosting has no first-class department on the Jobtrain feed;
    // the region label is the closest org-unit signal, so leave department null
    // rather than fabricate one from the role title.
    void posting;
    return null;
  }

  /** Detect remote / home-working roles from the title, employment type, or body. */
  private detectRemote(posting: JobtrainJobPosting): boolean {
    const haystacks: Array<string | null | undefined> = [
      posting.title,
      posting.employmentType,
      posting.jobLocation?.address?.addressLocality,
      posting.jobLocation?.address?.addressRegion,
      posting.description,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (JOBTRAIN_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Parse an ISO / `YYYY-MM-DD` string into a `YYYY-MM-DD` string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    // Jobtrain uses a `0001-01-01` placeholder for un-dated legacy roles; treat
    // it as "no date" rather than an absurd year.
    if (/^0001-01-01/.test(value)) return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }

  /**
   * Decode the handful of numeric / named HTML entities Jobtrain emits inside
   * its JSON-LD strings (e.g. `&#xA3;` for `£`) before `JSON.parse`. The values
   * are JSON-string-escaped already, so we only decode the HTML-entity layer.
   */
  private decodeEntities(value: string): string {
    return value
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&#(\d+);/g, (_, dec) => {
        const code = Number(dec);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&nbsp;/g, ' ');
  }
}
