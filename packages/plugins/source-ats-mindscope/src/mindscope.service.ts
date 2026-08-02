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
  MINDSCOPE_PORTAL_ORIGIN,
  MINDSCOPE_ROOT_DOMAIN,
  MINDSCOPE_PORTAL_SUFFIX,
  MINDSCOPE_CANDIDATE_PATH,
  MINDSCOPE_JOBBOARD_PAGE,
  MINDSCOPE_DETAIL_LINK_REGEX,
  MINDSCOPE_PORTAL_SEGMENT_REGEX,
  MINDSCOPE_JSONLD_REGEX,
  MINDSCOPE_OG_TITLE_REGEX,
  MINDSCOPE_OG_URL_REGEX,
  MINDSCOPE_OG_DESCRIPTION_REGEX,
  MINDSCOPE_TITLE_TAG_REGEX,
  MINDSCOPE_REMOTE_REGEX,
  MINDSCOPE_DEFAULT_RESULTS,
  MINDSCOPE_MAX_PAGES,
  MINDSCOPE_HEADERS,
} from './mindscope.constants';
import {
  MindscopeJob,
  MindscopeJobLink,
  MindscopeJobPosting,
  MindscopeJobLocation,
  MindscopePostalAddress,
} from './mindscope.types';

/**
 * Mindscope (Univerus Workforce) ATS careers scraper — generic, multi-tenant.
 *
 * Mindscope (mindscope.com, US / CA) is a staffing & recruiting ATS/CRM. Each
 * customer tenant publishes a public, unauthenticated candidate portal / job board
 * on a path segment of a shared host:
 *
 *   https://portal{N}.mindscope.com/{TENANTCODE}_V2Portal/Modules/Candidate/…
 *
 * The portal is a server-rendered ASP.NET WebForms application, so the adapter
 * enumerates a tenant's open postings from the job-board page's
 * `JobDetails.aspx?JobId={id}` anchors and then fetches each posting's
 * server-rendered detail page, preferring a schema.org `JobPosting` JSON-LD block
 * (Mindscope markets "SEO-enhanced listings compatible with Google for Jobs"),
 * with `og:` meta tags and the `<title>` / body HTML as defensive fallbacks.
 *
 * The caller addresses a tenant by `companySlug` (the portal/tenant code, e.g.
 * `WHITEC04415`, optionally `host/{code}` to pin a non-default `portal{N}` host)
 * or by `companyUrl` (a portal URL whose path carries the `{code}_V2Portal`
 * segment). The job-board page lists every open posting in one document, so we
 * fetch it once and slice client-side to honour `resultsWanted`, bounded by a hard
 * page cap. A single fetch error, an unknown tenant (HTTP 4xx), or a malformed page
 * degrades to an empty / partial result rather than throwing, so a single tenant
 * never nukes a batch run.
 */
@SourcePlugin({
  site: Site.MINDSCOPE,
  name: 'Mindscope',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class MindscopeService implements IScraper {
  private readonly logger = new Logger(MindscopeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Mindscope scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Mindscope tenant portal from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(MINDSCOPE_HEADERS);

    const resultsWanted = input.resultsWanted ?? MINDSCOPE_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Mindscope job board for tenant: ${tenant.code}`);

      // The job-board page enumerates every open posting for the tenant in one document.
      const links = await this.fetchJobLinks(client, tenant);
      if (links.length === 0) {
        this.logger.log(`Mindscope tenant "${tenant.code}" has no open postings`);
        return new JobResponseDto([]);
      }

      // Only fetch as many detail pages as the caller asked for (deduped first),
      // bounded by a hard page cap.
      const wanted = links
        .filter((l) => !seen.has(l.jobId) && seen.add(l.jobId))
        .slice(0, Math.min(resultsWanted, MINDSCOPE_MAX_PAGES));

      for (const link of wanted) {
        try {
          const post = await this.processLink(client, link, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Mindscope posting ${link.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`Mindscope total: ${jobPosts.length} jobs for ${tenant.code}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Mindscope scrape error for ${tenant.code}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Fetch and parse the tenant job-board page into open-posting links. An unknown
   * tenant (HTTP 4xx) or a missing board degrades to an empty list.
   */
  private async fetchJobLinks(
    client: ReturnType<typeof createHttpClient>,
    tenant: MindscopeTenant,
  ): Promise<MindscopeJobLink[]> {
    const url = this.boardUrl(tenant);
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      return this.parseJobLinks(html, tenant);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Mindscope job board not found (HTTP ${status}) at ${url}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Extract `JobDetails.aspx?JobId={id}` links (absolute or relative) from the
   * job-board HTML, capturing the `{id}` as the ATS id and rebuilding an absolute
   * detail URL against the tenant portal. Duplicate ids are de-duped here (a
   * posting may be linked more than once on the board).
   */
  private parseJobLinks(html: string, tenant: MindscopeTenant): MindscopeJobLink[] {
    const links: MindscopeJobLink[] = [];
    const seen = new Set<string>();

    const re = new RegExp(MINDSCOPE_DETAIL_LINK_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const path = this.decodeEntities(match[1] ?? '');
      const jobId = this.cleanText(match[2]);
      if (!path || !jobId || seen.has(jobId)) continue;
      seen.add(jobId);
      links.push({ jobId, url: this.absoluteUrl(tenant, path) });
    }

    return links;
  }

  /** Fetch + parse a single detail page, then map it to a JobPostDto. */
  private async processLink(
    client: ReturnType<typeof createHttpClient>,
    link: MindscopeJobLink,
    tenant: MindscopeTenant,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    let html = '';
    try {
      const response = await client.get<string>(link.url, { responseType: 'text' });
      html = typeof response.data === 'string' ? response.data : '';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        // A closed / removed posting 404s; skip it without failing the batch.
        this.logger.warn(`Mindscope posting ${link.jobId} not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }

    const job = this.parseDetail(html, link);
    return this.processJob(job, tenant, format);
  }

  /** Parse a detail page's HTML (JSON-LD JobPosting + og: / title fallbacks) into a MindscopeJob. */
  private parseDetail(html: string, link: MindscopeJobLink): MindscopeJob {
    const posting = this.findJobPosting(html);

    const ogTitle = this.firstGroup(html, MINDSCOPE_OG_TITLE_REGEX);
    const titleTag = this.firstGroup(html, MINDSCOPE_TITLE_TAG_REGEX);
    const ogDescription = this.firstGroup(html, MINDSCOPE_OG_DESCRIPTION_REGEX);
    const ogUrl = this.firstGroup(html, MINDSCOPE_OG_URL_REGEX);

    const title =
      this.cleanText(posting?.title) ??
      this.leadingTitle(ogTitle) ??
      this.leadingTitle(titleTag);

    const address = this.firstAddress(posting?.jobLocation);
    const companyName = this.organizationName(posting?.hiringOrganization);

    const descriptionHtml = this.cleanText(posting?.description);
    const department =
      this.cleanText(posting?.occupationalCategory) ?? this.cleanText(posting?.industry);

    return {
      jobId: link.jobId,
      url: link.url,
      canonicalUrl: this.cleanText(posting?.url) ?? (ogUrl ? this.decodeEntities(ogUrl) : null),
      title: title ? this.decodeEntities(title) : null,
      companyName: companyName ? this.decodeEntities(companyName) : null,
      descriptionHtml: descriptionHtml ? this.decodeEntities(descriptionHtml) : null,
      description: ogDescription ? this.decodeEntities(ogDescription) : null,
      city: this.cleanText(address?.addressLocality),
      state: this.cleanText(address?.addressRegion),
      country: this.countryName(address?.addressCountry),
      department,
      employmentType: this.normaliseEmploymentType(posting?.employmentType),
      datePosted: this.parseDate(posting?.datePosted),
      isRemote: this.detectRemote(posting, title, address),
    };
  }

  /**
   * Scan every `application/ld+json` block for a `JobPosting` object. Each block
   * may be a single object, an array of objects, or a `@graph` envelope; we narrow
   * defensively and return the first `JobPosting` found.
   */
  private findJobPosting(html: string): MindscopeJobPosting | null {
    const re = new RegExp(MINDSCOPE_JSONLD_REGEX.source, 'gi');
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
  private extractPosting(value: unknown): MindscopeJobPosting | null {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.extractPosting(item);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (this.isJobPostingType(obj['@type'])) return obj as MindscopeJobPosting;
      // schema.org `@graph` envelope: search its members.
      if (Array.isArray(obj['@graph'])) return this.extractPosting(obj['@graph']);
    }
    return null;
  }

  /** True when a JSON-LD `@type` value names a JobPosting. */
  private isJobPostingType(type: unknown): boolean {
    if (typeof type === 'string') return type.toLowerCase() === 'jobposting';
    if (Array.isArray(type)) {
      return type.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
    }
    return false;
  }

  /** Map a normalised MindscopeJob → JobPostDto. */
  private processJob(
    job: MindscopeJob,
    tenant: MindscopeTenant,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url || job.canonicalUrl;
    if (!jobUrl) return null;

    const companyName = this.deriveCompanyName(job.companyName, tenant.code);
    const description = this.formatDescription(
      job.descriptionHtml ?? null,
      job.description ?? null,
      format,
    );

    return new JobPostDto({
      id: `mindscope-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.MINDSCOPE,
      atsId,
      atsType: 'mindscope',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: job.canonicalUrl || jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The JSON-LD `description` is
   * an HTML body; we prefer it so markdown / plain conversion is consistent,
   * falling back to the plain-text `og:description` blob when no HTML body exists.
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
   * Resolve the tenant portal. An explicit `companySlug` is the tenant/portal code
   * (e.g. `WHITEC04415`), optionally prefixed with a portal host to pin a
   * non-default `portal{N}` host (`portal3.mindscope.com/WHITEC04415` or a full
   * portal URL passed as the slug). A `companyUrl` on the `mindscope.com` domain
   * has its origin + `{code}_V2Portal` segment used verbatim. Returns null when
   * neither yields a tenant.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): MindscopeTenant | null {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full portal URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.toLowerCase().includes(MINDSCOPE_ROOT_DOMAIN)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // Bare portal code (optionally `{TENANTCODE}` with a stripped `_V2Portal`).
      const code = this.cleanCode(slug);
      if (code) return { origin: MINDSCOPE_PORTAL_ORIGIN, code };
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return null;
  }

  /**
   * Derive a tenant (portal origin + code) from a Mindscope portal URL. The portal
   * forms are `https://portal{N}.mindscope.com/{TENANTCODE}_V2Portal/…`; the
   * `{TENANTCODE}` is taken from the `…_V2Portal` path segment and the origin is
   * preserved so a non-default `portal{N}` host is honoured.
   */
  private tenantFromUrl(value: string): MindscopeTenant | null {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(MINDSCOPE_ROOT_DOMAIN)) return null;
      const origin = `${u.protocol}//${u.host}`;
      // Prefer the explicit `{code}_V2Portal` path segment.
      const seg = MINDSCOPE_PORTAL_SEGMENT_REGEX.exec(u.pathname);
      if (seg && seg[1]) {
        const code = this.cleanCode(decodeURIComponent(seg[1]));
        if (code) return { origin, code };
      }
      // Fall back to the first non-empty path segment, stripping a `_V2Portal` suffix.
      const first = u.pathname.split('/').filter((s) => s.length > 0)[0];
      if (first) {
        const code = this.cleanCode(decodeURIComponent(first));
        if (code) return { origin, code };
      }
    } catch {
      // Malformed URL — no tenant.
    }
    return null;
  }

  /** Strip a trailing `_V2Portal` suffix / whitespace from a tenant code token. */
  private cleanCode(value: string): string {
    const trimmed = value.trim().replace(new RegExp(`${MINDSCOPE_PORTAL_SUFFIX}$`, 'i'), '');
    return trimmed.replace(/\/+$/, '').trim();
  }

  /** Build the tenant's public job-board page URL. */
  private boardUrl(tenant: MindscopeTenant): string {
    return `${this.candidateBase(tenant)}/${MINDSCOPE_JOBBOARD_PAGE}`;
  }

  /** Base candidate-module URL for a tenant portal (no trailing page). */
  private candidateBase(tenant: MindscopeTenant): string {
    const origin = tenant.origin.replace(/\/+$/, '');
    return `${origin}/${encodeURIComponent(tenant.code)}${MINDSCOPE_PORTAL_SUFFIX}${MINDSCOPE_CANDIDATE_PATH}`;
  }

  /**
   * Build an absolute detail URL from a tenant + an absolute-or-relative href. A
   * relative href is resolved against the tenant's candidate-module base; an
   * id-only path is rebuilt against the canonical `JobDetails.aspx?JobId={id}` form.
   */
  private absoluteUrl(tenant: MindscopeTenant, path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const base = `${tenant.origin.replace(/\/+$/, '')}`;
    if (path.startsWith('/')) return `${base}${path}`;
    // A bare `JobDetails.aspx?…` is relative to the candidate module.
    if (/^JobDetails\.aspx/i.test(path)) return `${this.candidateBase(tenant)}/${path}`;
    return `${this.candidateBase(tenant)}/${path}`;
  }

  /** De-slugify + title-case a company name (from JSON-LD, else the tenant code). */
  private deriveCompanyName(company: string | null | undefined, code: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : code) || code;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the JSON-LD `jobLocation.address` parts (locality / region / country)
   * as a LocationDto, leaving location null when nothing usable is present.
   */
  private extractLocation(job: MindscopeJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from `jobLocationType`, the title, or the location text. */
  private detectRemote(
    posting: MindscopeJobPosting | null,
    title: string | null,
    address: MindscopePostalAddress | null,
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
      if (MINDSCOPE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Return the first `PostalAddress` from a `jobLocation` (object or array). */
  private firstAddress(
    jobLocation: MindscopeJobLocation | MindscopeJobLocation[] | null | undefined,
  ): MindscopePostalAddress | null {
    if (!jobLocation) return null;
    const first = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
    const address = first?.address;
    return address && typeof address === 'object' ? address : null;
  }

  /** Resolve the hiring-organisation display name (object `name` or bare string). */
  private organizationName(
    org: MindscopeJobPosting['hiringOrganization'],
  ): string | null {
    if (!org) return null;
    if (typeof org === 'string') return this.cleanText(org);
    return this.cleanText(org.name);
  }

  /** Resolve the country display value (a bare code/name, or an object with `name`). */
  private countryName(country: MindscopePostalAddress['addressCountry']): string | null {
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

  /** Decode the handful of HTML/XML entities that appear in meta tags / JSON-LD / hrefs. */
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

/** Resolved tenant portal: the `portal{N}` origin plus the `{TENANTCODE}` code. */
interface MindscopeTenant {
  /** Portal origin, e.g. `https://portal2.mindscope.com`. */
  origin: string;
  /** Tenant / portal code, e.g. `WHITEC04415`. */
  code: string;
}
