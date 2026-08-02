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
  KEKA_HOST_TEMPLATE,
  KEKA_ROOT_DOMAIN,
  KEKA_JOBS_API_PATHS,
  KEKA_JOB_DETAIL_PATH_TEMPLATE,
  KEKA_JSONLD_REGEX,
  KEKA_OG_TITLE_REGEX,
  KEKA_OG_URL_REGEX,
  KEKA_OG_DESCRIPTION_REGEX,
  KEKA_TITLE_TAG_REGEX,
  KEKA_REMOTE_REGEX,
  KEKA_DEFAULT_RESULTS,
  KEKA_HEADERS,
} from './keka.constants';
import {
  KekaApiJob,
  KekaJob,
  KekaJobPosting,
  KekaJobLocation,
  KekaJobsApiResponse,
  KekaPostalAddress,
} from './keka.types';

/**
 * Keka ATS careers scraper — generic, multi-tenant.
 *
 * Keka (keka.com, India HR + payroll + hiring; product "Keka Hire") powers each
 * customer's candidate career site on its own sub-domain at
 * `https://{tenant}.keka.com/careers/`. The jobs index is a client-rendered SPA,
 * so the adapter instead enumerates the tenant's open roles from the public,
 * unauthenticated published-jobs JSON feed (`/k/careers/api/mwf/careers/jobs`,
 * and alias paths probed in order), and — when a feed object lacks the company
 * name — enriches each role from its server-rendered detail page
 * (`/careers/jobdetails/{jobId}`) schema.org `JobPosting` JSON-LD (with `og:`
 * meta tags as defensive fallbacks).
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g.
 * `algoworks`) or by `companyUrl` (a portal URL whose first sub-domain label is
 * the tenant). The feed lists every open role in one document — there is no
 * server-side pagination of the job set — so we fetch once and slice client-side
 * to honour `resultsWanted`. A single fetch error, an unknown tenant (HTTP 4xx),
 * or a malformed page degrades to an empty / partial result rather than throwing,
 * so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.KEKA,
  name: 'Keka',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class KekaService implements IScraper {
  private readonly logger = new Logger(KekaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Keka scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve a Keka careers host from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(KEKA_HEADERS);

    const resultsWanted = input.resultsWanted ?? KEKA_DEFAULT_RESULTS;
    const tenant = this.deriveTenant(companySlug, host);
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Keka published jobs from: ${host}`);

      // The published-jobs feed enumerates every open role for the tenant.
      const rawJobs = await this.fetchJobs(client, host);
      if (rawJobs.length === 0) {
        this.logger.log(`Keka tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Normalise + de-dup by job id, then honour resultsWanted before any
      // per-role detail enrichment fetch.
      const normalised: KekaJob[] = [];
      for (const raw of rawJobs) {
        const job = this.normaliseApiJob(raw, host);
        if (!job) continue;
        if (seen.has(job.jobId)) continue;
        seen.add(job.jobId);
        normalised.push(job);
      }

      const wanted = normalised.slice(0, resultsWanted);

      for (const job of wanted) {
        try {
          const post = await this.processJob(client, job, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Keka job ${job.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`Keka total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Keka scrape error for ${host}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Fetch and parse the tenant published-jobs feed. The feed has fronted the same
   * job set under a handful of paths across tenant versions; we probe them in
   * order and use the first that yields roles. An unknown sub-domain (HTTP 4xx)
   * or a missing feed degrades to an empty list.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<KekaApiJob[]> {
    for (const path of KEKA_JOBS_API_PATHS) {
      const url = `${host}${path}`;
      try {
        const response = await client.get<unknown>(url, { responseType: 'json' });
        const jobs = this.extractJobsArray(response.data);
        if (jobs.length > 0) return jobs;
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && status >= 400 && status < 500) {
          // This path / tenant 4xx'd; try the next alias path.
          this.logger.warn(`Keka jobs feed not found (HTTP ${status}) at ${url}`);
          continue;
        }
        throw err;
      }
    }
    return [];
  }

  /**
   * Narrow the feed response into a job array. The payload may be a bare array,
   * or wrapped in a `{ data | jobs | result | records: [...] }` envelope; a
   * JSON string body is parsed first. Anything else yields an empty list.
   */
  private extractJobsArray(data: unknown): KekaApiJob[] {
    let value: unknown = data;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return [];
      }
    }
    if (Array.isArray(value)) return value as KekaApiJob[];
    if (value && typeof value === 'object') {
      const env = value as KekaJobsApiResponse;
      const arr = env.data ?? env.jobs ?? env.result ?? env.records;
      if (Array.isArray(arr)) return arr;
    }
    return [];
  }

  /** Normalise a raw feed job into a KekaJob, or null when it lacks an id/title. */
  private normaliseApiJob(raw: KekaApiJob, host: string): KekaJob | null {
    const jobId = this.firstId(raw.id, raw.jobId, raw.identifier);
    if (!jobId) return null;

    const title = this.cleanText(raw.title) ?? this.cleanText(raw.jobTitle) ?? this.cleanText(raw.name);
    if (!title) return null;

    const url = this.resolveDetailUrl(raw, host, jobId);
    const descriptionHtml = this.cleanText(raw.jobDescription) ?? this.cleanText(raw.description);

    return {
      jobId,
      url,
      canonicalUrl: url,
      title,
      companyName: null,
      descriptionHtml: descriptionHtml ?? null,
      description: null,
      city: this.cleanText(raw.city) ?? this.cleanText(raw.location),
      state: this.cleanText(raw.state) ?? this.cleanText(raw.region),
      country: this.cleanText(raw.country),
      department: this.cleanText(raw.department) ?? this.cleanText(raw.departmentName),
      employmentType: this.normaliseEmploymentType(
        this.cleanText(raw.employmentType) ?? this.cleanText(raw.jobType),
      ),
      datePosted:
        this.parseDate(raw.postedDate) ??
        this.parseDate(raw.publishedDate) ??
        this.parseDate(raw.createdDate),
      isRemote: this.resolveRemoteFlag(raw),
    };
  }

  /**
   * Map a normalised KekaJob → JobPostDto. When the feed object did not carry a
   * company name (or a usable HTML body), the role's server-rendered detail page
   * is consulted once for its schema.org `JobPosting` JSON-LD enrichment.
   */
  private async processJob(
    client: ReturnType<typeof createHttpClient>,
    job: KekaJob,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const enriched = await this.enrichFromDetail(client, job);

    const title = enriched.title;
    if (!title) return null;

    const atsId = String(enriched.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = enriched.url || enriched.canonicalUrl;
    if (!jobUrl) return null;

    const companyName = this.deriveCompanyName(enriched.companyName, tenant);
    const description = this.formatDescription(
      enriched.descriptionHtml ?? null,
      enriched.description ?? null,
      format,
    );

    return new JobPostDto({
      id: `keka-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(enriched),
      description,
      datePosted: enriched.datePosted ?? null,
      isRemote: enriched.isRemote ?? false,
      emails: extractEmails(description),
      site: Site.KEKA,
      atsId,
      atsType: 'keka',
      department: this.cleanText(enriched.department),
      employmentType: this.cleanText(enriched.employmentType),
      applyUrl: enriched.canonicalUrl || jobUrl,
    });
  }

  /**
   * Enrich a feed job from its detail page when the company name (or an HTML
   * body) is missing. A 4xx / fetch error / malformed page leaves the feed-only
   * job untouched — enrichment is strictly additive and never fatal.
   */
  private async enrichFromDetail(
    client: ReturnType<typeof createHttpClient>,
    job: KekaJob,
  ): Promise<KekaJob> {
    if (job.companyName && job.descriptionHtml) return job;

    let html = '';
    try {
      const response = await client.get<string>(job.url, { responseType: 'text' });
      html = typeof response.data === 'string' ? response.data : '';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Keka job ${job.jobId} detail not found (HTTP ${status})`);
        return job;
      }
      // Network / 5xx — skip enrichment, keep the feed-only job.
      return job;
    }

    const detail = this.parseDetail(html);
    return {
      ...job,
      title: job.title ?? detail.title,
      companyName: job.companyName ?? detail.companyName,
      canonicalUrl: job.canonicalUrl ?? detail.canonicalUrl,
      descriptionHtml: job.descriptionHtml ?? detail.descriptionHtml,
      description: job.description ?? detail.description,
      city: job.city ?? detail.city,
      state: job.state ?? detail.state,
      country: job.country ?? detail.country,
      department: job.department ?? detail.department,
      employmentType: job.employmentType ?? detail.employmentType,
      datePosted: job.datePosted ?? detail.datePosted,
      isRemote: job.isRemote || detail.isRemote || false,
    };
  }

  /** Parse a detail page's HTML (JSON-LD JobPosting + og: fallbacks) into a partial KekaJob. */
  private parseDetail(html: string): Partial<KekaJob> {
    const posting = this.findJobPosting(html);

    const ogTitle = this.firstGroup(html, KEKA_OG_TITLE_REGEX);
    const titleTag = this.firstGroup(html, KEKA_TITLE_TAG_REGEX);
    const ogDescription = this.firstGroup(html, KEKA_OG_DESCRIPTION_REGEX);
    const ogUrl = this.firstGroup(html, KEKA_OG_URL_REGEX);

    const title =
      this.cleanText(posting?.title) ??
      this.leadingTitle(ogTitle) ??
      this.leadingTitle(titleTag);

    const address = this.firstAddress(posting?.jobLocation);
    const companyName = this.organizationName(posting?.hiringOrganization);
    const descriptionHtml = this.cleanText(posting?.description);

    return {
      canonicalUrl: this.cleanText(posting?.url) ?? (ogUrl ? this.decodeEntities(ogUrl) : null),
      title: title ? this.decodeEntities(title) : null,
      companyName: companyName ? this.decodeEntities(companyName) : null,
      descriptionHtml: descriptionHtml ? this.decodeEntities(descriptionHtml) : null,
      description: ogDescription ? this.decodeEntities(ogDescription) : null,
      city: this.cleanText(address?.addressLocality),
      state: this.cleanText(address?.addressRegion),
      country: this.countryName(address?.addressCountry),
      department: this.cleanText(posting?.industry),
      employmentType: this.normaliseEmploymentType(posting?.employmentType),
      datePosted: this.parseDate(posting?.datePosted),
      isRemote: this.detectRemote(posting, title, address),
    };
  }

  /**
   * Scan every `application/ld+json` block for a `JobPosting` object. Each block
   * may be a single object, an array of objects, or a `@graph` envelope; we
   * narrow defensively and return the first `JobPosting` found.
   */
  private findJobPosting(html: string): KekaJobPosting | null {
    const re = new RegExp(KEKA_JSONLD_REGEX.source, 'gi');
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
  private extractPosting(value: unknown): KekaJobPosting | null {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.extractPosting(item);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (this.isJobPostingType(obj['@type'])) return obj as KekaJobPosting;
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

  /**
   * Convert the job-ad body per `descriptionFormat`. The feed / JSON-LD
   * `description` is an HTML body; we prefer it so markdown / plain conversion is
   * consistent, falling back to the plain-text `og:description` blob when no HTML
   * body exists.
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
   * Resolve the tenant careers host. An explicit `companySlug` is expanded into
   * the canonical `{tenant}.keka.com` host; a `companyUrl` on the `keka.com`
   * domain has its origin used verbatim. Returns an empty string when neither
   * yields a host.
   */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.toLowerCase();
        if (hostname === KEKA_ROOT_DOMAIN || hostname.endsWith(`.${KEKA_ROOT_DOMAIN}`)) {
          return `${u.protocol}//${u.host}`;
        }
      } catch {
        // Malformed URL — fall through to the slug.
      }
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim().toLowerCase();
      // A caller may also pass a bare host (e.g. "algoworks.keka.com").
      if (slug.includes(KEKA_ROOT_DOMAIN)) {
        const host = slug.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        return `https://${host}`;
      }
      return KEKA_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(slug));
    }
    return '';
  }

  /** Derive the tenant token (sub-domain label) from the slug or resolved host. */
  private deriveTenant(companySlug: string | undefined, host: string): string {
    if (companySlug && companySlug.trim() && !companySlug.includes('.')) {
      return companySlug.trim();
    }
    try {
      const label = new URL(host).hostname.split('.')[0] || '';
      return label;
    } catch {
      return companySlug?.trim() || host;
    }
  }

  /**
   * Resolve a role's absolute public detail-page URL. The feed may advertise a
   * full or relative `jobDetailUrl` / `url`; otherwise we synthesise the canonical
   * `{host}/careers/jobdetails/{jobId}` path.
   */
  private resolveDetailUrl(raw: KekaApiJob, host: string, jobId: string): string {
    const advertised = this.cleanText(raw.jobDetailUrl) ?? this.cleanText(raw.url);
    if (advertised) {
      if (/^https?:\/\//i.test(advertised)) return advertised;
      const path = advertised.startsWith('/') ? advertised : `/${advertised}`;
      return `${host}${path}`;
    }
    return `${host}${KEKA_JOB_DETAIL_PATH_TEMPLATE.replace('{jobId}', encodeURIComponent(jobId))}`;
  }

  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : tenant) || tenant;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the location parts (city / state / country) as a LocationDto, leaving
   * location null when nothing usable is present.
   */
  private extractLocation(job: KekaJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Resolve the feed's remote flag, tolerating boolean and string truthy values. */
  private resolveRemoteFlag(raw: KekaApiJob): boolean {
    const flag = raw.isRemote ?? raw.remote;
    if (typeof flag === 'boolean') return flag;
    if (typeof flag === 'string') return /^(true|yes|1|remote)$/i.test(flag.trim());
    const haystack = this.cleanText(raw.location) ?? this.cleanText(raw.city);
    return haystack ? KEKA_REMOTE_REGEX.test(haystack) : false;
  }

  /** Detect remote roles from `jobLocationType`, the title, or the location text. */
  private detectRemote(
    posting: KekaJobPosting | null,
    title: string | null,
    address: KekaPostalAddress | null,
  ): boolean {
    const locType = this.cleanText(posting?.jobLocationType);
    if (locType && /telecommute|remote/i.test(locType)) return true;
    const haystacks: Array<string | null | undefined> = [
      title,
      this.cleanText(address?.addressLocality),
      this.cleanText(address?.addressRegion),
      this.cleanText(posting?.employmentType as string),
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (KEKA_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Return the first `PostalAddress` from a `jobLocation` (object or array). */
  private firstAddress(
    jobLocation: KekaJobLocation | KekaJobLocation[] | null | undefined,
  ): KekaPostalAddress | null {
    if (!jobLocation) return null;
    const first = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
    const address = first?.address;
    return address && typeof address === 'object' ? address : null;
  }

  /** Resolve the hiring-organisation display name (object `name` or bare string). */
  private organizationName(
    org: KekaJobPosting['hiringOrganization'],
  ): string | null {
    if (!org) return null;
    if (typeof org === 'string') return this.cleanText(org);
    return this.cleanText(org.name);
  }

  /** Resolve the country display value (a bare code/name, or an object with `name`). */
  private countryName(country: KekaPostalAddress['addressCountry']): string | null {
    if (!country) return null;
    if (typeof country === 'string') return this.cleanText(country);
    return this.cleanText(country.name);
  }

  /**
   * Normalise a schema.org / feed `employmentType` (e.g. `FULL_TIME`, `PART_TIME`,
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

  /** Return the leading "{title}" segment of an "{title} - {company}" string. */
  private leadingTitle(value: string | null): string | null {
    if (!value) return null;
    const cleaned = value.trim();
    if (!cleaned) return null;
    // og:title / <title> use " - " / " | " between the role and the company.
    const idx = cleaned.search(/\s[-|]\s/);
    const head = idx > 0 ? cleaned.slice(0, idx) : cleaned;
    return head.trim() || null;
  }

  /** Return the first non-empty id from a list of candidates, as a string. */
  private firstId(...candidates: Array<string | number | null | undefined>): string | null {
    for (const c of candidates) {
      if (typeof c === 'number' && Number.isFinite(c)) return String(c);
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
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

  /** Decode the handful of HTML/XML entities that appear in meta tags / JSON-LD. */
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
