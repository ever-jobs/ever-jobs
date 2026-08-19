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
  toDateOnly,
} from '@ever-jobs/common';
import {
  VARBI_HOST_TEMPLATE,
  VARBI_LISTING_PATH,
  VARBI_JOB_PATH_TEMPLATE,
  VARBI_APPLY_PATH_TEMPLATE,
  VARBI_ATS_TYPE,
  VARBI_DEFAULT_RESULTS,
  VARBI_MAX_DETAIL_FETCHES,
  VARBI_HEADERS,
  VARBI_ROW_REGEX,
  VARBI_JOB_ID_REGEX,
  VARBI_TITLE_REGEX,
  VARBI_TOWN_REGEX,
  VARBI_SUBCOMPANY_REGEX,
  VARBI_ENDS_REGEX,
  VARBI_JOB_DESC_REGEX,
  VARBI_OG_META_REGEX_TEMPLATE,
  VARBI_PAGE_TITLE_REGEX,
} from './varbi.constants';
import { VarbiJob, VarbiListing } from './varbi.types';

/**
 * Varbi ATS careers scraper — generic, multi-tenant.
 *
 * Varbi (varbi.com, Sweden — "Grade Varbi Recruit") publishes every tenant's
 * open roles on a public, server-rendered career page
 * (`GET https://{tenant}.varbi.com/en/`). The page lists every open vacancy in
 * one HTML table — there is no server-side pagination, so we fetch once and
 * slice client-side to honour `resultsWanted`. Each row carries the title,
 * city, company/department and application deadline plus a link to the public
 * job-ad page (`…/what:job/jobID:{jobID}/`), from which the full advert body is
 * optionally enriched (bounded to the sliced result set).
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g.
 * `kth`, `lu`, `uu`) or by `companyUrl`. A single fetch error, an unknown
 * tenant (HTTP 4xx) or a malformed page degrades to an empty / partial result
 * rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.VARBI,
  name: 'Varbi',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class VarbiService implements IScraper {
  private readonly logger = new Logger(VarbiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Varbi scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Varbi tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(VARBI_HEADERS);

    const resultsWanted = input.resultsWanted ?? VARBI_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      const host = VARBI_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));

      // One fetch yields the tenant's complete open-roles list.
      const listing = await this.fetchListing(client, host, tenant);
      if (!listing) {
        this.logger.warn(`Could not load a Varbi career page for "${tenant}"`);
        return new JobResponseDto([]);
      }

      const companyName = this.deriveCompanyName(listing.company, tenant);
      this.logger.log(`Varbi listing for ${companyName}: ${listing.jobs.length} open roles`);

      // Slice the raw rows first so per-job description enrichment is bounded.
      const wanted = listing.jobs.slice(0, Math.min(resultsWanted, VARBI_MAX_DETAIL_FETCHES));
      const detailFormat = input.descriptionFormat;

      for (const job of wanted) {
        try {
          // Enrich the advert body from the job-ad page (best-effort).
          await this.enrichDescription(client, host, job);
          const post = this.processJob(job, companyName, detailFormat);
          if (!post) continue;
          const key = post.atsId as string;
          if (seen.has(key)) continue;
          seen.add(key);
          jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Varbi job ${job?.job_id}: ${err.message}`);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Varbi total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Varbi scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Fetch and parse the tenant career page into a {@link VarbiListing}. An
   * unknown sub-domain returns HTTP 404 (or other 4xx); we treat that as "no
   * jobs" rather than a hard failure.
   */
  private async fetchListing(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    tenant: string,
  ): Promise<VarbiListing | null> {
    const url = `${host}${VARBI_LISTING_PATH}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      if (!html) {
        this.logger.warn(`Varbi career page for "${tenant}" was empty`);
        return null;
      }
      return this.parseListing(html, host);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Varbi tenant "${tenant}" not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse the listing-table HTML into open-role rows. Each `<tr>` holds the
   * title (`pos-title`), city (`pos-town`), company/department
   * (`pos-subcompany`) and application deadline (`pos-ends`) cells plus a
   * repeated `…/what:job/jobID:{jobID}/` link.
   */
  private parseListing(html: string, host: string): VarbiListing {
    const company = this.parsePageCompany(html);
    const jobs: VarbiJob[] = [];
    const seen = new Set<string>();

    const rowRegex = new RegExp(VARBI_ROW_REGEX.source, VARBI_ROW_REGEX.flags);
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const row = rowMatch[1];
      if (!row) continue;

      const jobId = this.firstJobId(row);
      if (!jobId || seen.has(jobId)) continue;

      const title = this.cleanText(this.firstGroup(row, VARBI_TITLE_REGEX));
      if (!title) continue; // a row without a title cell is a header / chrome row

      seen.add(jobId);

      const town = this.cleanText(this.firstGroup(row, VARBI_TOWN_REGEX));
      const subcompany = this.cleanText(this.firstGroup(row, VARBI_SUBCOMPANY_REGEX));
      const deadline = this.firstGroup(row, VARBI_ENDS_REGEX);

      jobs.push({
        job_id: jobId,
        title,
        job_url: `${host}${VARBI_JOB_PATH_TEMPLATE.replace('{jobID}', jobId)}`,
        apply_url: `${host}${VARBI_APPLY_PATH_TEMPLATE.replace('{jobID}', jobId)}`,
        town: town || null,
        subcompany: subcompany || null,
        application_deadline: deadline || null,
      });
    }

    return { company, jobs };
  }

  /**
   * Best-effort enrichment of a single role's advert body from its job-ad page.
   * Failures (4xx / network / parse) leave the role with no description rather
   * than aborting the run.
   */
  private async enrichDescription(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    job: VarbiJob,
  ): Promise<void> {
    const jobId = job.job_id ?? job.jobId;
    if (!jobId) return;
    const url = job.job_url ?? job.jobUrl ?? `${host}${VARBI_JOB_PATH_TEMPLATE.replace('{jobID}', jobId)}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      if (!html) return;

      const body = this.firstGroup(html, VARBI_JOB_DESC_REGEX);
      if (body && body.trim()) job.description_html = body.trim();

      const og = this.ogContent(html, 'description');
      if (og) job.description_text = this.decodeEntities(og).trim();
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Varbi job ad ${jobId} not found (HTTP ${status})`);
        return;
      }
      this.logger.warn(`Varbi job ad ${jobId} fetch failed: ${err.message}`);
    }
  }

  private processJob(
    job: VarbiJob,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = this.cleanText(job.title ?? job.name);
    if (!title) return null;

    const atsId = String(job.job_id ?? job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.job_url ?? job.jobUrl;
    if (!jobUrl) return null;

    const applyUrl = job.apply_url ?? job.applyUrl ?? jobUrl;
    const rawHtml = job.description_html ?? job.descriptionHtml ?? null;
    const rawText = job.description_text ?? job.descriptionText ?? null;
    const description = this.formatDescription(rawHtml, rawText, format);

    return new JobPostDto({
      id: `varbi-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.application_deadline ?? job.applicationDeadline),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description ?? ''),
      site: Site.VARBI,
      atsId,
      atsType: VARBI_ATS_TYPE,
      department: this.extractDepartment(job),
      employmentType: job.employment_type ?? job.employmentType ?? null,
      applyUrl,
    });
  }

  /**
   * Convert the advert body per `descriptionFormat`. The job-ad page yields an
   * HTML body (`job-desc`); we prefer it so markdown / plain conversion is
   * consistent, falling back to the `og:description` plain-text summary when no
   * HTML body was harvested.
   */
  private formatDescription(
    html: string | null,
    text: string | null,
    format?: DescriptionFormat,
  ): string | null {
    if (html) {
      if (format === DescriptionFormat.HTML) return html;
      if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
      return htmlToPlainText(html);
    }
    if (text) {
      // Only the og:description summary is available; surface it for every format.
      return text;
    }
    return null;
  }

  /**
   * Resolve the Varbi tenant token (sub-domain label) from an explicit
   * `companySlug` or from a `companyUrl` (the first meaningful sub-domain
   * label).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const host = u.host.split(':')[0];
        const labels = host.split('.').filter(Boolean);
        // A tenant career host is `{tenant}.varbi.com`: the first non-`www`
        // label is the tenant.
        const first = labels[0];
        if (first && first !== 'www') return first;
        if (labels[1]) return labels[1];
        // Fall back to the trailing path segment for embed-style URLs.
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments.length > 0) return segments[segments.length - 1];
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  /**
   * Derive the tenant company name from the parsed page `<title>`, else the
   * sub-domain label. Varbi titles read "Vacancies at {Company}" / "Lediga jobb
   * hos {Company}"; we strip that boilerplate prefix.
   */
  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const raw = typeof company === 'string' && company.trim() ? company.trim() : '';
    if (raw) return raw;
    return tenant
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Extract a clean company name from the page `<title>` boilerplate. */
  private parsePageCompany(html: string): string | null {
    const title = this.cleanText(this.firstGroup(html, VARBI_PAGE_TITLE_REGEX));
    if (!title) return null;
    return (
      title
        // English: "Vacancies at X" / "Job opening - X"; Swedish: "Lediga jobb hos X".
        .replace(/^vacancies at\s+/i, '')
        .replace(/^lediga jobb hos\s+/i, '')
        .replace(/^job opening\s*[-–]\s*/i, '')
        .trim() || null
    );
  }

  /**
   * Varbi rows surface a free-text town/city plus a "company, department" blob.
   * We map the town to the city slot and leave state/country unset (Varbi spans
   * multiple countries and does not expose a structured country per row).
   */
  private extractLocation(job: VarbiJob): LocationDto | null {
    const city = this.cleanText(job.town ?? job.city);
    if (!city) return null;
    return new LocationDto({ city });
  }

  /**
   * Department is the trailing segment of the "company, department"
   * sub-company blob (Varbi formats it as "{Org}, {Unit}").
   */
  private extractDepartment(job: VarbiJob): string | null {
    const explicit = this.cleanText(job.department);
    if (explicit) return explicit;
    const blob = this.cleanText(job.subcompany);
    if (!blob) return null;
    const parts = blob.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) return parts[parts.length - 1];
    return blob;
  }

  /** Detect remote roles from the city, title, or sub-company text. */
  private detectRemote(job: VarbiJob): boolean {
    const haystacks: Array<string | null | undefined> = [
      job.town ?? job.city,
      job.title ?? job.name,
      job.subcompany,
      job.description_text ?? job.descriptionText,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('distans') || // Swedish "distansarbete"
        v.includes('etätyö') ||
        v.includes('work from home') ||
        v.includes('wfh')
      ) {
        return true;
      }
    }
    return false;
  }

  /** Parse a `YYYY-MM-DD` (or ISO-8601) string into a `YYYY-MM-DD` string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }

  /** First numeric jobID captured within a chunk of HTML. */
  private firstJobId(html: string): string | null {
    const regex = new RegExp(VARBI_JOB_ID_REGEX.source, 'i');
    const match = html.match(regex);
    return match && match[1] ? match[1] : null;
  }

  /** First capture group of a single-shot regex, or null. */
  private firstGroup(html: string, regex: RegExp): string | null {
    const match = html.match(regex);
    return match && match[1] != null ? match[1] : null;
  }

  /** Read an `og:{prop}` meta content value, decoding HTML entities. */
  private ogContent(html: string, prop: string): string | null {
    const regex = new RegExp(VARBI_OG_META_REGEX_TEMPLATE.replace('{prop}', prop), 'i');
    const match = html.match(regex);
    if (!match || match[1] == null) return null;
    const value = this.decodeEntities(match[1]).trim();
    return value || null;
  }

  /** Strip tags, collapse whitespace and decode common entities from a cell. */
  private cleanText(value: string | null | undefined): string | null {
    if (value == null) return null;
    const stripped = this.decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    return stripped || null;
  }

  /** Decode the handful of HTML entities that appear in Varbi cells. */
  private decodeEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }
}
