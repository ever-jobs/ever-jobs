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
  APPLICANTSTACK_HOST_TEMPLATE,
  APPLICANTSTACK_ROOT_DOMAIN,
  APPLICANTSTACK_OPENINGS_PATH,
  APPLICANTSTACK_DETAIL_PATH,
  APPLICANTSTACK_APPLY_PATH,
  APPLICANTSTACK_DEFAULT_RESULTS,
  APPLICANTSTACK_HEADERS,
  APPLICANTSTACK_ROW_REGEX,
  APPLICANTSTACK_DETAIL_LINK_REGEX,
  APPLICANTSTACK_CELL_REGEX,
  APPLICANTSTACK_SUMMARY_FIELD_TEMPLATE,
  APPLICANTSTACK_DESCRIPTION_REGEX,
  APPLICANTSTACK_OG_DESCRIPTION_REGEX,
  APPLICANTSTACK_OG_SITE_NAME_REGEX,
  APPLICANTSTACK_TITLE_TAG_REGEX,
  APPLICANTSTACK_BOARD_GONE_REGEX,
  APPLICANTSTACK_REMOTE_REGEX,
} from './applicantstack.constants';
import { ApplicantStackJob, ApplicantStackOpening, ApplicantStackDetail } from './applicantstack.types';

/**
 * ApplicantStack (SwipeClock / WorkforceHub) ATS careers scraper — generic,
 * multi-tenant.
 *
 * ApplicantStack (applicantstack.com, US SMB ATS) hosts every customer's open
 * roles on a public, server-rendered job board at
 * `https://{tenant}.applicantstack.com/x/openings`. That openings index is one
 * HTML `<table>` whose every body row is an open role (title + detail link,
 * posted date, "Industry - Job Category", city), so the adapter enumerates the
 * whole tenant from a single document. For each role it surfaces (up to
 * `resultsWanted`) it then fetches the server-rendered detail page
 * (`/x/detail/{jobId}`) to enrich the role with its full job-ad body and
 * company name.
 *
 * The caller addresses a tenant by `companySlug` (the board sub-domain label,
 * e.g. `atwork443`) or by `companyUrl` (a board URL whose first sub-domain label
 * is the tenant). The openings table lists every open role in one document
 * (there is no server-side pagination of the job set), so we parse it once and
 * slice client-side to honour `resultsWanted`. A single fetch error, an unknown
 * tenant (HTTP 4xx), a retired board placeholder, or a malformed page degrades
 * to an empty / partial result rather than throwing, so a single tenant never
 * nukes a batch run.
 */
@SourcePlugin({
  site: Site.APPLICANTSTACK,
  name: 'ApplicantStack',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ApplicantStackService implements IScraper {
  private readonly logger = new Logger(ApplicantStackService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for ApplicantStack scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve an ApplicantStack tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(APPLICANTSTACK_HEADERS);

    const resultsWanted = input.resultsWanted ?? APPLICANTSTACK_DEFAULT_RESULTS;
    const host = APPLICANTSTACK_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching ApplicantStack openings for tenant: ${tenant}`);

      // The openings table enumerates every open role for the tenant in one document.
      const openings = await this.fetchOpenings(client, host);
      if (openings.length === 0) {
        this.logger.log(`ApplicantStack tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Only enrich + emit as many roles as the caller asked for (deduped first).
      const wanted = openings
        .filter((o) => !seen.has(o.jobId) && seen.add(o.jobId))
        .slice(0, resultsWanted);

      const tenantCompany = this.deriveCompanyName(undefined, tenant);
      for (const opening of wanted) {
        try {
          const post = await this.processOpening(client, opening, tenant, tenantCompany, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing ApplicantStack job ${opening.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`ApplicantStack total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`ApplicantStack scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Fetch and parse the tenant openings table into open-role rows. An unknown
   * sub-domain (HTTP 4xx) or a retired board placeholder degrades to an empty
   * list.
   */
  private async fetchOpenings(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<ApplicantStackOpening[]> {
    const url = `${host}${APPLICANTSTACK_OPENINGS_PATH}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      if (!html || APPLICANTSTACK_BOARD_GONE_REGEX.test(html)) {
        this.logger.warn(`ApplicantStack board "${host}" is empty or retired`);
        return [];
      }
      return this.parseOpenings(html, host);
    } catch (err: any) {
      // An unknown sub-domain / disabled board returns HTTP 404 (or other 4xx);
      // treat that as "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`ApplicantStack openings not found (HTTP ${status}) at ${url}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Extract each open role from the openings table's rows. Every body row holds
   * one `/x/detail/{jobId}` anchor (title) plus the Date Posted, "Industry - Job
   * Category" and City cells; header / pager rows carry no detail anchor and are
   * skipped.
   */
  private parseOpenings(html: string, host: string): ApplicantStackOpening[] {
    const openings: ApplicantStackOpening[] = [];
    const seen = new Set<string>();

    APPLICANTSTACK_ROW_REGEX.lastIndex = 0;
    let row: RegExpExecArray | null;
    while ((row = APPLICANTSTACK_ROW_REGEX.exec(html)) !== null) {
      const block = row[1] ?? '';
      const linkMatch = APPLICANTSTACK_DETAIL_LINK_REGEX.exec(block);
      if (!linkMatch) continue;

      const jobId = linkMatch[1];
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);

      const title = this.cleanText(this.stripTags(this.decodeEntities(linkMatch[2] ?? '')));
      if (!title) continue;

      // The remaining `<td>` cells are: Date Posted, "Industry - Job Category",
      // City. Read them positionally and defensively (a tenant may omit some).
      const cells = this.extractCells(block);
      // cells[0] is the title cell (already captured); the rest are the columns.
      const [, datePosted, category, city] = cells;

      openings.push({
        jobId,
        url: `${host}${APPLICANTSTACK_DETAIL_PATH}/${jobId}`,
        title,
        datePosted: this.cleanText(datePosted) ?? null,
        category: this.cleanText(category) ?? null,
        city: this.cleanText(city) ?? null,
      });
    }

    return openings;
  }

  /** Read each `<td>` cell's decoded, tag-stripped text from a table row block. */
  private extractCells(block: string): Array<string | null> {
    const cells: Array<string | null> = [];
    const re = new RegExp(APPLICANTSTACK_CELL_REGEX.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      cells.push(this.cleanText(this.stripTags(this.decodeEntities(m[1] ?? ''))));
    }
    return cells;
  }

  /** Enrich one opening from its detail page, then map it to a JobPostDto. */
  private async processOpening(
    client: ReturnType<typeof createHttpClient>,
    opening: ApplicantStackOpening,
    tenant: string,
    tenantCompany: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const detail = await this.fetchDetail(client, opening);
    const job = this.assembleJob(opening, detail, tenant, tenantCompany);
    return this.processJob(job, format);
  }

  /**
   * Fetch + parse a single detail page. A closed / removed role (HTTP 4xx) or a
   * malformed page simply yields no enrichment — the openings-table row still
   * carries the title, date, category and city.
   */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    opening: ApplicantStackOpening,
  ): Promise<ApplicantStackDetail | null> {
    try {
      const response = await client.get<string>(opening.url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      if (!html) return null;
      return this.parseDetail(html);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`ApplicantStack detail ${opening.jobId} not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /** Parse a detail page's HTML into the enrichment fields. */
  private parseDetail(html: string): ApplicantStackDetail {
    const siteName = this.firstGroup(html, APPLICANTSTACK_OG_SITE_NAME_REGEX);
    const titleTag = this.firstGroup(html, APPLICANTSTACK_TITLE_TAG_REGEX);
    const ogDescription = this.firstGroup(html, APPLICANTSTACK_OG_DESCRIPTION_REGEX);
    const bodyHtml = this.firstGroup(html, APPLICANTSTACK_DESCRIPTION_REGEX);

    // og:title / og:site_name / <title> are "{company} - {title}" or
    // "{title} - {company}"; the detail summary table is authoritative for the
    // structured fields, so we only mine a company display name from the metas.
    const company = this.companyFromMeta(siteName, titleTag);

    return {
      company: company ? this.decodeEntities(company) : null,
      descriptionHtml: bodyHtml ? bodyHtml.trim() : null,
      descriptionText: ogDescription ? this.decodeEntities(ogDescription) : null,
      datePosted: this.summaryField(html, 'Date Posted'),
      category: this.summaryField(html, 'Industry - Job Category'),
      city: this.summaryField(html, 'City'),
      referenceId: this.summaryField(html, 'ID'),
    };
  }

  /** Read one "Job post summary" field (e.g. `<th>City:</th><td>Riverside</td>`). */
  private summaryField(html: string, label: string): string | null {
    const pattern = APPLICANTSTACK_SUMMARY_FIELD_TEMPLATE.replace('{label}', this.escapeRegex(label));
    const m = new RegExp(pattern, 'i').exec(html);
    if (!m) return null;
    return this.cleanText(this.stripTags(this.decodeEntities(m[1] ?? '')));
  }

  /** Merge an openings-table row with its detail enrichment into a single role. */
  private assembleJob(
    opening: ApplicantStackOpening,
    detail: ApplicantStackDetail | null,
    tenant: string,
    tenantCompany: string,
  ): ApplicantStackJob {
    const company = this.deriveCompanyName(detail?.company ?? undefined, tenant) || tenantCompany;
    return {
      jobId: opening.jobId,
      url: opening.url,
      applyUrl: opening.url.replace(APPLICANTSTACK_DETAIL_PATH, APPLICANTSTACK_APPLY_PATH),
      title: opening.title,
      companyName: company,
      descriptionHtml: detail?.descriptionHtml ?? null,
      descriptionText: detail?.descriptionText ?? null,
      city: detail?.city ?? opening.city ?? null,
      category: detail?.category ?? opening.category ?? null,
      datePosted: detail?.datePosted ?? opening.datePosted ?? null,
    };
  }

  /** Map a normalised ApplicantStackJob → JobPostDto. */
  private processJob(job: ApplicantStackJob, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const description = this.formatDescription(job.descriptionHtml ?? null, job.descriptionText ?? null, format);

    return new JobPostDto({
      id: `applicantstack-${atsId}`,
      title,
      companyName: job.companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.datePosted),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.APPLICANTSTACK,
      atsId,
      atsType: 'applicantstack',
      department: this.extractDepartment(job),
      employmentType: this.extractEmploymentType(job),
      applyUrl: job.applyUrl || jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. ApplicantStack detail pages
   * surface the body as HTML inside `<div class="listing_description">` (and a
   * short plain-text `og:description` fallback). We prefer HTML so markdown /
   * plain conversion is consistent, falling back to the plain-text blurb when no
   * HTML body is present.
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
      // Only a plain-text blurb is available; surface it as-is for every format.
      return text;
    }
    return null;
  }

  /**
   * Resolve the ApplicantStack tenant token from an explicit `companySlug` or
   * from a `companyUrl` (the first meaningful sub-domain label of an
   * `applicantstack.com` host).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim().toLowerCase();
      // A caller may also pass a bare host (e.g. "atwork443.applicantstack.com").
      if (slug.includes(APPLICANTSTACK_ROOT_DOMAIN)) {
        const host = slug.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const first = host.split('.').filter(Boolean)[0];
        if (first && first !== 'www') return first;
      } else {
        return slug;
      }
    }
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const host = u.host.split(':')[0].toLowerCase();
        if (host.endsWith(APPLICANTSTACK_ROOT_DOMAIN)) {
          const labels = host.split('.').filter(Boolean);
          // A tenant board host is `{tenant}.applicantstack.com`: the first
          // non-`www` label is the tenant.
          const first = labels[0];
          if (first && first !== 'www') return first;
          if (labels[1] && labels[1] !== 'applicantstack') return labels[1];
        }
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  /**
   * Derive a display company name from the detail page's metadata when present,
   * else from the tenant slug. Slug-derived names are de-slugified and
   * title-cased.
   */
  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    if (typeof company === 'string' && company.trim()) return company.trim();
    return (tenant || '')
      .replace(/[-_]+/g, ' ')
      .replace(/\d+$/g, '')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * The `og:site_name` / `<title>` are `"{company} - {title}"` or
   * `"{title} - {company}"`. We prefer `og:site_name`'s leading company segment,
   * falling back to the `<title>` tail.
   */
  private companyFromMeta(siteName: string | null, titleTag: string | null): string | null {
    if (siteName) {
      const head = siteName.split(' - ')[0]?.trim();
      if (head) return head;
    }
    if (titleTag) {
      const parts = titleTag.split(' - ').map((p) => p.trim()).filter(Boolean);
      // `<title>` is "{title} - {company}" → the trailing segment is the company.
      if (parts.length >= 2) return parts[parts.length - 1];
    }
    return null;
  }

  /** Surface the City (from the table / detail summary) as the role's location. */
  private extractLocation(job: ApplicantStackJob): LocationDto | null {
    const city = this.cleanText(job.city);
    if (!city) return null;
    // ApplicantStack rows split "City, ST" into a bare city in most tenants; when
    // a "City, State" pair is present we split it so downstream consumers get both.
    const parts = city.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return new LocationDto({ city: parts[0], state: parts[1] });
    }
    return new LocationDto({ city });
  }

  /**
   * Derive a department from the "Industry - Job Category" column. The leading
   * "{Industry}" segment is the closest analogue to a department / org unit.
   */
  private extractDepartment(job: ApplicantStackJob): string | null {
    const cat = this.cleanText(job.category);
    if (!cat) return null;
    const head = cat.split(/\s+-\s+/)[0]?.trim();
    return head || cat;
  }

  /**
   * ApplicantStack openings rows do not carry a structured employment type; mine
   * a Full/Part-time (or contract / temporary) hint from the title or body when
   * present, else leave it null.
   */
  private extractEmploymentType(job: ApplicantStackJob): string | null {
    const haystacks: Array<string | null | undefined> = [job.title, job.descriptionText, job.descriptionHtml];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const m = field.match(
        /\b(full[\s-]?time|part[\s-]?time|temporary|temp[\s-]?to[\s-]?hire|contract|seasonal|internship|per\s+diem)\b/i,
      );
      if (m && m[1]) {
        return m[1]
          .toLowerCase()
          .replace(/[\s-]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());
      }
    }
    return null;
  }

  /** Detect remote roles from the title, location, category, or body. */
  private detectRemote(job: ApplicantStackJob): boolean {
    const haystacks: Array<string | null | undefined> = [
      job.title,
      job.city,
      job.category,
      job.descriptionText,
      job.descriptionHtml,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (APPLICANTSTACK_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Parse a `MM/DD/YYYY` (or any parseable) string into a `YYYY-MM-DD` string. */
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

  /** Run a regex and return its first capture group, trimmed, or null. */
  private firstGroup(html: string, regex: RegExp): string | null {
    const match = regex.exec(html);
    if (match && typeof match[1] === 'string') {
      const v = match[1].trim();
      return v.length > 0 ? v : null;
    }
    return null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }

  /** Strip HTML tags from a captured fragment, collapsing whitespace. */
  private stripTags(value: string): string {
    return value
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Escape a literal string for safe inclusion in a `RegExp`. */
  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Decode the handful of HTML entities that appear in cell / meta content. */
  private decodeEntities(value: string): string {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#x2F;/gi, '/')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, d) => {
        const code = Number(d);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&amp;/g, '&');
  }
}
