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
  BRASSRING_HOST,
  BRASSRING_ROOT_DOMAIN,
  BRASSRING_MATCHED_JOBS_PATH,
  BRASSRING_JOB_DETAILS_PATH,
  BRASSRING_JSONLD_REGEX,
  BRASSRING_REMOTE_REGEX,
  BRASSRING_HTML_TAG_REGEX,
  BRASSRING_DEFAULT_RESULTS,
  BRASSRING_PAGE_SIZE,
  BRASSRING_MAX_PAGES,
  BRASSRING_HEADERS,
} from './brassring.constants';
import {
  BrassRingTenant,
  BrassRingJob,
  BrassRingJobRaw,
  BrassRingJobPosting,
  BrassRingJobLocation,
  BrassRingPostalAddress,
  BrassRingMatchedJobsResponse,
} from './brassring.types';

/**
 * BrassRing (IBM Kenexa / Infinite BrassRing) ATS scraper — generic, multi-tenant.
 *
 * BrassRing hosts every customer's candidate-facing "Talent Gateway" portal under
 * the shared host `https://sjobs.brassring.com/`. A tenant is NOT a sub-domain or
 * slug — it is addressed by a `partnerid` + `siteid` pair carried as query
 * parameters. The jobs index is a client-rendered SPA ("TGnewUI"), so the adapter
 * instead calls the portal's own AJAX search endpoint
 * (`POST /TgNewUI/Search/Ajax/MatchedJobs`), which returns a JSON envelope of
 * matched roles (`{ Jobs: [...], JobsCount }`), and (when present) enriches each
 * role from its server-rendered detail page's schema.org `JobPosting` JSON-LD.
 *
 * The caller addresses a tenant by `companySlug` (the `partnerid:siteid` pair,
 * e.g. `25212:5164`, or `partnerid=25212&siteid=5164`) or by `companyUrl` (a
 * Talent Gateway URL whose `partnerid` / `siteid` query params identify the
 * tenant). The MatchedJobs envelope returns a page of roles plus a `JobsCount`
 * total, so we page client-side (bounded by `resultsWanted`). A single fetch
 * error, an unknown tenant (HTTP 4xx / zero roles), or a malformed page degrades
 * to an empty / partial result rather than throwing, so a single tenant never
 * nukes a batch run.
 */
@SourcePlugin({
  site: Site.BRASSRING,
  name: 'BrassRing',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class BrassRingService implements IScraper {
  private readonly logger = new Logger(BrassRingService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for BrassRing scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a BrassRing partnerid/siteid pair from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(BRASSRING_HEADERS);

    const resultsWanted = input.resultsWanted ?? BRASSRING_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      const label = `${tenant.partnerId}:${tenant.siteId}`;
      this.logger.log(`Fetching BrassRing matched jobs for tenant ${label}`);

      // The MatchedJobs endpoint pages a tenant's open roles; we page client-side.
      const rawJobs = await this.fetchAllJobs(client, tenant, resultsWanted);
      if (rawJobs.length === 0) {
        this.logger.log(`BrassRing tenant "${label}" has no open roles`);
        return new JobResponseDto([]);
      }

      for (const raw of rawJobs) {
        try {
          const job = this.normaliseJob(raw, tenant);
          if (!job) continue;
          if (seen.has(job.atsId)) continue;
          seen.add(job.atsId);

          // Best-effort enrichment from the detail page's JSON-LD (when present).
          const enriched = await this.enrichFromDetail(client, job, tenant);
          const post = this.processJob(enriched, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
          if (jobPosts.length >= resultsWanted) break;
        } catch (err: any) {
          this.logger.warn(`Error processing BrassRing role: ${err.message}`);
        }
      }

      this.logger.log(`BrassRing total: ${jobPosts.length} jobs for ${label}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`BrassRing scrape error for ${tenant.partnerId}:${tenant.siteId}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Page the MatchedJobs endpoint until we have enough roles, the tenant runs out,
   * or the page cap is hit. An unknown tenant (HTTP 4xx) or an empty envelope
   * degrades to an empty list.
   */
  private async fetchAllJobs(
    client: ReturnType<typeof createHttpClient>,
    tenant: BrassRingTenant,
    resultsWanted: number,
  ): Promise<BrassRingJobRaw[]> {
    const url = `${BRASSRING_HOST}${BRASSRING_MATCHED_JOBS_PATH}`;
    const all: BrassRingJobRaw[] = [];

    for (let page = 1; page <= BRASSRING_MAX_PAGES && all.length < resultsWanted; page++) {
      let envelope: BrassRingMatchedJobsResponse | null;
      try {
        envelope = await this.fetchJobsPage(client, url, tenant, page);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && status >= 400 && status < 500) {
          this.logger.warn(`BrassRing matched-jobs not found (HTTP ${status}) for ${tenant.partnerId}:${tenant.siteId}`);
          break;
        }
        throw err;
      }

      const jobs = Array.isArray(envelope?.Jobs) ? envelope!.Jobs! : [];
      if (jobs.length === 0) break;
      all.push(...jobs);

      // Stop once we've seen every advertised role (or the page wasn't full).
      const total = this.toCount(envelope?.JobsCount);
      if (total != null && all.length >= total) break;
      if (jobs.length < BRASSRING_PAGE_SIZE) break;
    }

    return all.slice(0, resultsWanted);
  }

  /** POST one page of the MatchedJobs search and return its parsed JSON envelope. */
  private async fetchJobsPage(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: BrassRingTenant,
    page: number,
  ): Promise<BrassRingMatchedJobsResponse> {
    const body = {
      partnerId: tenant.partnerId,
      siteId: tenant.siteId,
      keyword: '',
      location: '',
      pageNumber: page,
      noOfRecords: BRASSRING_PAGE_SIZE,
      sortField: '',
      sortDirection: '',
    };
    const response = await client.post<BrassRingMatchedJobsResponse>(url, body);
    const data = response?.data;
    return data && typeof data === 'object' ? data : {};
  }

  /**
   * Map a raw MatchedJobs entry into a normalised BrassRingJob. Returns null when
   * no usable id or title is present.
   */
  private normaliseJob(raw: BrassRingJobRaw, tenant: BrassRingTenant): BrassRingJob | null {
    const title = this.cleanText(raw.Title) ?? this.cleanText(raw.JobTitle) ?? this.cleanText(raw.Jobtitle);
    if (!title) return null;

    const req = this.cleanText(raw.Autoreqid) ?? this.cleanText(raw.AutoReqId) ?? this.cleanText(raw.Areq);
    const jobId = this.idToString(raw.Jobid) ?? this.idToString(raw.JobId);
    const atsId = req ?? jobId;
    if (!atsId) return null;

    const url = this.resolveJobUrl(raw, tenant, req, jobId);
    const locationText =
      this.cleanText(raw.Location) ?? this.cleanText(raw.JobLocation) ?? this.cleanText(raw.Locations);
    const descriptionText =
      this.cleanText(raw.Description) ?? this.cleanText(raw.JobDescription) ?? this.cleanText(raw.Summary);

    const city = this.cleanText(raw.City) ?? this.cityFromText(locationText);
    const state = this.cleanText(raw.State) ?? this.stateFromText(locationText);
    const country = this.cleanText(raw.Country);

    return {
      atsId,
      url,
      title: this.decodeEntities(title),
      companyName: null,
      descriptionHtml: null,
      description: descriptionText ? this.decodeEntities(this.stripHtml(descriptionText)) : null,
      city,
      state,
      country,
      department:
        this.cleanText(raw.Department) ?? this.cleanText(raw.Category) ?? this.cleanText(raw.JobCategory),
      employmentType:
        this.cleanText(raw.EmploymentType) ?? this.cleanText(raw.JobType) ?? this.cleanText(raw.Schedule),
      datePosted: this.parseDate(raw.PostingDate) ?? this.parseDate(raw.PostedDate) ?? this.parseDate(raw.DatePosted),
      isRemote: this.detectRemote(title, locationText, descriptionText),
    };
  }

  /**
   * Fetch the role's detail page and, when it pre-renders a schema.org
   * `JobPosting` JSON-LD block, fill any gaps (HTML body, company, employment type,
   * structured location, date). A 4xx or a page without JSON-LD leaves the listing
   * fields untouched — enrichment is strictly best-effort.
   */
  private async enrichFromDetail(
    client: ReturnType<typeof createHttpClient>,
    job: BrassRingJob,
    tenant: BrassRingTenant,
  ): Promise<BrassRingJob> {
    let html = '';
    try {
      const response = await client.get<string>(job.url, { responseType: 'text' });
      html = typeof response.data === 'string' ? response.data : '';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`BrassRing detail ${job.atsId} not found (HTTP ${status})`);
        return job;
      }
      // A transient detail-page error must not drop the listing-derived role.
      this.logger.warn(`BrassRing detail ${job.atsId} fetch failed: ${err.message}`);
      return job;
    }

    const posting = this.findJobPosting(html);
    if (!posting) return job;

    const address = this.firstAddress(posting.jobLocation);
    const descriptionHtml = this.cleanText(posting.description);

    return {
      ...job,
      title: this.cleanText(posting.title) ? this.decodeEntities(this.cleanText(posting.title)!) : job.title,
      companyName: this.organizationName(posting.hiringOrganization) ?? job.companyName,
      canonicalUrl: this.cleanText(posting.url) ?? job.canonicalUrl,
      descriptionHtml: descriptionHtml ? this.decodeEntities(descriptionHtml) : job.descriptionHtml,
      city: this.cleanText(address?.addressLocality) ?? job.city,
      state: this.cleanText(address?.addressRegion) ?? job.state,
      country: this.countryName(address?.addressCountry) ?? job.country,
      department: this.cleanText(posting.industry) ?? job.department,
      employmentType: this.normaliseEmploymentType(posting.employmentType) ?? job.employmentType,
      datePosted: this.parseDate(posting.datePosted) ?? job.datePosted,
      isRemote: job.isRemote || this.detectRemoteFromPosting(posting),
    };
  }

  /**
   * Scan every `application/ld+json` block for a `JobPosting` object. Each block
   * may be a single object, an array of objects, or a `@graph` envelope; we narrow
   * defensively and return the first `JobPosting` found.
   */
  private findJobPosting(html: string): BrassRingJobPosting | null {
    const re = new RegExp(BRASSRING_JSONLD_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Malformed JSON-LD block — skip it and keep scanning.
        continue;
      }
      const posting = this.extractPosting(parsed);
      if (posting) return posting;
    }
    return null;
  }

  /** Recursively locate a `JobPosting` node within a parsed JSON-LD value. */
  private extractPosting(value: unknown): BrassRingJobPosting | null {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.extractPosting(item);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (this.isJobPostingType(obj['@type'])) return obj as BrassRingJobPosting;
      // schema.org `@graph` envelope: search its members.
      if (Array.isArray(obj['@graph'])) return this.extractPosting(obj['@graph']);
    }
    return null;
  }

  /** True when a JSON-LD `@type` value names a JobPosting. */
  private isJobPostingType(type: unknown): boolean {
    if (typeof type === 'string') return type.toLowerCase() === 'jobposting';
    if (Array.isArray(type)) return type.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
    return false;
  }

  /** Map a normalised BrassRingJob → JobPostDto. */
  private processJob(
    job: BrassRingJob,
    tenant: BrassRingTenant,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.atsId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url || job.canonicalUrl;
    if (!jobUrl) return null;

    const companyName = this.deriveCompanyName(job.companyName, tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, job.description ?? null, format);

    return new JobPostDto({
      id: `brassring-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description),
      site: Site.BRASSRING,
      atsId,
      atsType: 'brassring',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: job.canonicalUrl || jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. When a detail-page JSON-LD
   * HTML body is available we prefer it so markdown / plain conversion is
   * consistent, falling back to the plain-text listing summary when no HTML body
   * exists.
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
      // Only a plain-text body is available; surface it as-is for every format.
      return text;
    }
    return null;
  }

  /**
   * Resolve the tenant `partnerid` + `siteid` pair. A `companyUrl` whose query
   * carries both params (on the `brassring.com` host) is used verbatim; otherwise
   * a `companySlug` of the form `partnerid:siteid`, `partnerid/siteid`,
   * `partnerid-siteid`, or `partnerid=…&siteid=…` is parsed. Returns null when
   * neither yields a complete pair.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): BrassRingTenant | null {
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    if (companySlug && companySlug.trim()) {
      const fromSlug = this.tenantFromSlug(companySlug.trim());
      if (fromSlug) return fromSlug;
    }
    return null;
  }

  /** Parse a `partnerid`/`siteid` pair out of a full Talent Gateway URL. */
  private tenantFromUrl(companyUrl: string): BrassRingTenant | null {
    try {
      const u = new URL(companyUrl);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(BRASSRING_ROOT_DOMAIN)) return null;
      const partnerId = this.firstParam(u.searchParams, ['partnerid', 'partnerId', 'PartnerId']);
      const siteId = this.firstParam(u.searchParams, ['siteid', 'siteId', 'SiteId']);
      if (partnerId && siteId) return { partnerId, siteId };
    } catch {
      // Malformed URL — fall through to the slug.
    }
    return null;
  }

  /**
   * Parse a `partnerid`/`siteid` pair out of a slug. Accepts `partnerid:siteid`,
   * `partnerid/siteid`, `partnerid-siteid`, `partnerid_siteid`, two bare numbers,
   * or a `partnerid=…&siteid=…` query fragment.
   */
  private tenantFromSlug(slug: string): BrassRingTenant | null {
    // `partnerid=…&siteid=…` (or a full URL passed as the slug).
    const paramMatch = /partnerid=(\d+)[^]*?siteid=(\d+)/i.exec(slug);
    if (paramMatch) return { partnerId: paramMatch[1], siteId: paramMatch[2] };

    // Two numbers separated by a delimiter: `25212:5164`, `25212/5164`, `25212-5164`.
    const pairMatch = /(\d{2,})\s*[:/_\-\s]\s*(\d{2,})/.exec(slug);
    if (pairMatch) return { partnerId: pairMatch[1], siteId: pairMatch[2] };

    return null;
  }

  /** Return the first present query-param value across a set of casings. */
  private firstParam(params: URLSearchParams, keys: string[]): string | null {
    for (const key of keys) {
      const value = params.get(key);
      if (value && value.trim()) return value.trim();
    }
    return null;
  }

  /**
   * Build the public detail-page URL for a role from its requisition id (`Areq`)
   * when available, else from the numeric job id, preferring an absolute URL the
   * envelope already advertised.
   */
  private resolveJobUrl(
    raw: BrassRingJobRaw,
    tenant: BrassRingTenant,
    req: string | null,
    jobId: string | null,
  ): string {
    const advertised = this.cleanText(raw.JobUrl) ?? this.cleanText(raw.Joburl) ?? this.cleanText(raw.Url);
    if (advertised && /^https?:\/\//i.test(advertised)) return advertised;
    if (advertised && advertised.startsWith('/')) return `${BRASSRING_HOST}${advertised}`;

    const base = `${BRASSRING_HOST}${BRASSRING_JOB_DETAILS_PATH}?PageType=JobDetails&partnerid=${encodeURIComponent(
      tenant.partnerId,
    )}&siteid=${encodeURIComponent(tenant.siteId)}`;
    if (req) return `${base}&Areq=${encodeURIComponent(req)}`;
    if (jobId) return `${base}&jobid=${encodeURIComponent(jobId)}`;
    return base;
  }

  private deriveCompanyName(company: string | null | undefined, tenant: BrassRingTenant): string {
    const base = typeof company === 'string' && company.trim() ? company.trim() : '';
    if (base) {
      return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
    // No tenant display name on the wire — surface the addressing pair.
    return `BrassRing ${tenant.partnerId}/${tenant.siteId}`;
  }

  /**
   * Surface the structured location parts (locality / region / country) as a
   * LocationDto, leaving location null when nothing usable is present.
   */
  private extractLocation(job: BrassRingJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the title, the location text, or the body. */
  private detectRemote(
    title: string | null,
    location: string | null,
    description: string | null,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, description];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (BRASSRING_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Detect remote roles from a detail-page JSON-LD `JobPosting`. */
  private detectRemoteFromPosting(posting: BrassRingJobPosting): boolean {
    const locType = this.cleanText(posting.jobLocationType);
    if (locType && /telecommute|remote/i.test(locType)) return true;
    const title = this.cleanText(posting.title);
    return !!(title && BRASSRING_REMOTE_REGEX.test(title));
  }

  /** Return the first `PostalAddress` from a `jobLocation` (object or array). */
  private firstAddress(
    jobLocation: BrassRingJobLocation | BrassRingJobLocation[] | null | undefined,
  ): BrassRingPostalAddress | null {
    if (!jobLocation) return null;
    const first = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
    const address = first?.address;
    return address && typeof address === 'object' ? address : null;
  }

  /** Resolve the hiring-organisation display name (object `name` or bare string). */
  private organizationName(
    org: BrassRingJobPosting['hiringOrganization'],
  ): string | null {
    if (!org) return null;
    if (typeof org === 'string') return this.cleanText(org);
    return this.cleanText(org.name);
  }

  /** Resolve the country display value (a bare code/name, or an object with `name`). */
  private countryName(country: BrassRingPostalAddress['addressCountry']): string | null {
    if (!country) return null;
    if (typeof country === 'string') return this.cleanText(country);
    return this.cleanText(country.name);
  }

  /**
   * Normalise a schema.org `employmentType` (e.g. `FULL_TIME`, `PART_TIME`,
   * `CONTRACTOR`, or an array thereof) into a readable label
   * (`Full Time`, `Part Time`, …). Free-text values are passed through trimmed.
   */
  private normaliseEmploymentType(value: string | string[] | null | undefined): string | null {
    const raw = Array.isArray(value) ? value.find((v) => typeof v === 'string' && v.trim()) : value;
    const cleaned = this.cleanText(raw);
    if (!cleaned) return null;
    return cleaned
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Pull a leading city token out of a free-text "City, State[, Country]" label. */
  private cityFromText(location: string | null): string | null {
    if (!location) return null;
    const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts[0] : null;
  }

  /** Pull a trailing region token out of a free-text "City, State[, Country]" label. */
  private stateFromText(location: string | null): string | null {
    if (!location) return null;
    const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
    return parts.length > 1 ? parts[1] : null;
  }

  /** Coerce a `JobsCount` value (number or numeric string) into a number. */
  private toCount(value: number | string | null | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const n = Number(value.replace(/[^\d]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /** Coerce a job-id value (number or string) into a trimmed string, or null. */
  private idToString(value: string | number | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return this.cleanText(typeof value === 'string' ? value : null);
  }

  /** Parse a date string into a YYYY-MM-DD string. */
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

  /** Strip HTML tags from a marked-up blob, returning trimmed plain text. */
  private stripHtml(value: string): string {
    return value.replace(BRASSRING_HTML_TAG_REGEX, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }

  /** Decode the handful of HTML/XML entities that appear in JSON / meta tags. */
  private decodeEntities(value: string): string {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, d) => {
        const code = Number(d);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&amp;/g, '&');
  }
}
