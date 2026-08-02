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
  PAGEUP_PLATFORM_HOST,
  PAGEUP_ROOT_DOMAIN,
  PAGEUP_CAW_SEGMENT,
  PAGEUP_LANG_SEGMENT,
  PAGEUP_LISTING_PATH,
  PAGEUP_PAGE_ITEMS,
  PAGEUP_MAX_PAGES,
  PAGEUP_JOB_HREF_REGEX,
  PAGEUP_JSONLD_REGEX,
  PAGEUP_OG_TITLE_REGEX,
  PAGEUP_OG_URL_REGEX,
  PAGEUP_OG_DESCRIPTION_REGEX,
  PAGEUP_TITLE_TAG_REGEX,
  PAGEUP_H1_REGEX,
  PAGEUP_JOBNO_REGEX,
  PAGEUP_WORKTYPE_REGEX,
  PAGEUP_LOCATION_REGEX,
  PAGEUP_CATEGORIES_REGEX,
  PAGEUP_ADVERTISED_REGEX,
  PAGEUP_REMOTE_REGEX,
  PAGEUP_DEFAULT_RESULTS,
  PAGEUP_HEADERS,
} from './pageup.constants';
import {
  PageUpJob,
  PageUpJobPosting,
  PageUpJobLocation,
  PageUpPostalAddress,
  PageUpListingEntry,
} from './pageup.types';

/**
 * PageUp ATS careers scraper — generic, multi-tenant.
 *
 * PageUp (pageuppeople.com, global/APAC enterprise recruitment) powers each
 * customer's candidate careers site on the shared platform host
 * `https://careers.pageuppeople.com/{instanceId}/caw/en/` (a few tenants also
 * front it under a custom `{tenant}.pageuppeople.com` host). Unlike SPA-style
 * portals, PageUp's listing index is server-rendered, so the adapter enumerates
 * the tenant's roles by parsing the real `<a href="…/job/{jobId}/{slug}">` anchors
 * from the listing index (`/{instanceId}/caw/en/listing/`, paginated via
 * `?page=&page-items=`) and parses each server-rendered detail page's
 * `<strong>`-labelled fields (with a schema.org `JobPosting` JSON-LD block and
 * `og:` meta tags as defensive fallbacks where a tenant exposes them).
 *
 * The caller addresses a tenant by `companySlug` (the numeric instance id, e.g.
 * `595`) or by `companyUrl` (a portal URL whose path carries the instance id, or a
 * custom careers host used verbatim). The listing index paginates, so we walk
 * pages bounded by `resultsWanted` and slice client-side. A single fetch error, an
 * unknown tenant (HTTP 4xx), or a malformed page degrades to an empty / partial
 * result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.PAGEUP,
  name: 'PageUp',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PageUpService implements IScraper {
  private readonly logger = new Logger(PageUpService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for PageUp scraper');
      return new JobResponseDto([]);
    }

    const base = this.resolveListingBase(companySlug, input.companyUrl);
    if (!base) {
      this.logger.warn('Could not resolve a PageUp listing base from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(PAGEUP_HEADERS);

    const resultsWanted = input.resultsWanted ?? PAGEUP_DEFAULT_RESULTS;
    const tenant = this.deriveTenant(companySlug, base);
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching PageUp listing from: ${base}`);

      // The server-rendered listing index enumerates the tenant's open roles.
      const entries = await this.fetchListing(client, base, resultsWanted, seen);
      if (entries.length === 0) {
        this.logger.log(`PageUp tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Only fetch as many detail pages as the caller asked for.
      const wanted = entries.slice(0, resultsWanted);

      for (const entry of wanted) {
        try {
          const post = await this.processEntry(client, entry, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing PageUp job ${entry.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`PageUp total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`PageUp scrape error for ${base}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Walk the server-rendered listing index, page by page, collecting deduped
   * job-detail entries until `resultsWanted` is satisfied, a page yields no new
   * roles, or the page ceiling is hit. An unknown instance id (HTTP 4xx) or a
   * missing listing degrades to an empty list.
   */
  private async fetchListing(
    client: ReturnType<typeof createHttpClient>,
    base: string,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<PageUpListingEntry[]> {
    const entries: PageUpListingEntry[] = [];

    for (let page = 1; page <= PAGEUP_MAX_PAGES; page++) {
      const url = `${base}${PAGEUP_LISTING_PATH}?page=${page}&page-items=${PAGEUP_PAGE_ITEMS}`;
      let html = '';
      try {
        const response = await client.get<string>(url, { responseType: 'text' });
        html = typeof response.data === 'string' ? response.data : '';
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && status >= 400 && status < 500) {
          this.logger.warn(`PageUp listing not found (HTTP ${status}) at ${url}`);
          break;
        }
        throw err;
      }

      const pageEntries = this.parseListing(html, base, seen);
      if (pageEntries.length === 0) break; // no new roles on this page → done
      entries.push(...pageEntries);
      if (entries.length >= resultsWanted) break;
    }

    return entries;
  }

  /**
   * Extract `…/job/{jobId}/{slug}` entries from the listing HTML. Hrefs may be
   * absolute or instance-relative; we resolve them against the platform origin.
   * The bare `/job/` index and other site pages (listing / subscribe / login)
   * carry no job id and are skipped by the job-href regex. De-dup by job id.
   */
  private parseListing(html: string, base: string, seen: Set<string>): PageUpListingEntry[] {
    const entries: PageUpListingEntry[] = [];
    const origin = this.originOf(base);

    const re = new RegExp(PAGEUP_JOB_HREF_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const rawHref = match[1];
      const jobId = match[3];
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);

      const url = /^https?:\/\//i.test(rawHref) ? rawHref : `${origin}${rawHref}`;
      entries.push({ jobId, url });
    }

    return entries;
  }

  /** Fetch + parse a single detail page, then map it to a JobPostDto. */
  private async processEntry(
    client: ReturnType<typeof createHttpClient>,
    entry: PageUpListingEntry,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    let html = '';
    try {
      const response = await client.get<string>(entry.url, { responseType: 'text' });
      html = typeof response.data === 'string' ? response.data : '';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        // A closed / removed role 404s; skip it without failing the batch.
        this.logger.warn(`PageUp job ${entry.jobId} not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }

    const job = this.parseDetail(html, entry);
    return this.processJob(job, tenant, format);
  }

  /**
   * Parse a detail page's HTML into a PageUpJob. The primary fields come from
   * PageUp's `<strong>`-labelled rows; a schema.org `JobPosting` JSON-LD block and
   * `og:` meta tags are layered in as defensive fallbacks (where a tenant exposes
   * them), so richer structured data is preferred when present.
   */
  private parseDetail(html: string, entry: PageUpListingEntry): PageUpJob {
    const posting = this.findJobPosting(html);

    const ogTitle = this.firstGroup(html, PAGEUP_OG_TITLE_REGEX);
    const h1 = this.stripTags(this.firstGroup(html, PAGEUP_H1_REGEX));
    const titleTag = this.firstGroup(html, PAGEUP_TITLE_TAG_REGEX);
    const ogDescription = this.firstGroup(html, PAGEUP_OG_DESCRIPTION_REGEX);
    const ogUrl = this.firstGroup(html, PAGEUP_OG_URL_REGEX);

    const labelWorkType = this.firstGroup(html, PAGEUP_WORKTYPE_REGEX);
    const labelLocation = this.firstGroup(html, PAGEUP_LOCATION_REGEX);
    const labelCategories = this.firstGroup(html, PAGEUP_CATEGORIES_REGEX);
    const labelAdvertised = this.firstGroup(html, PAGEUP_ADVERTISED_REGEX);
    const labelJobNo = this.firstGroup(html, PAGEUP_JOBNO_REGEX);

    const title =
      this.cleanText(posting?.title) ??
      this.cleanText(h1) ??
      this.leadingTitle(ogTitle) ??
      this.leadingTitle(titleTag);

    const address = this.firstAddress(posting?.jobLocation);
    const companyName = this.organizationName(posting?.hiringOrganization);

    const descriptionHtml = this.cleanText(posting?.description);

    // JSON-LD address parts take precedence; else fall back to the labelled
    // "Location:" row (a free-text place we surface as the city slot).
    const city = this.cleanText(address?.addressLocality) ?? this.decodeMaybe(labelLocation);
    const state = this.cleanText(address?.addressRegion);
    const country = this.countryName(address?.addressCountry);

    const employmentType =
      this.normaliseEmploymentType(posting?.employmentType) ?? this.decodeMaybe(labelWorkType);
    const department = this.cleanText(posting?.industry) ?? this.decodeMaybe(labelCategories);
    const datePosted =
      this.parseDate(posting?.datePosted) ?? this.parseDate(this.stripTimezone(labelAdvertised));

    // The job id from the detail URL is authoritative; the "Job no:" row corroborates.
    const jobId = entry.jobId || this.cleanText(labelJobNo) || '';

    return {
      jobId,
      url: entry.url,
      canonicalUrl: this.cleanText(posting?.url) ?? (ogUrl ? this.decodeEntities(ogUrl) : null),
      title: title ? this.decodeEntities(title) : null,
      companyName: companyName ? this.decodeEntities(companyName) : null,
      descriptionHtml: descriptionHtml ? this.decodeEntities(descriptionHtml) : null,
      description: ogDescription ? this.decodeEntities(ogDescription) : null,
      city,
      state,
      country,
      department,
      employmentType,
      datePosted,
      isRemote: this.detectRemote(posting, title, address, labelLocation),
    };
  }

  /**
   * Scan every `application/ld+json` block for a `JobPosting` object. Each block
   * may be a single object, an array of objects, or a `@graph` envelope; we narrow
   * defensively and return the first `JobPosting` found. Many PageUp tenants ship
   * no JSON-LD at all, in which case this returns null and the labelled-field
   * parser carries the role.
   */
  private findJobPosting(html: string): PageUpJobPosting | null {
    const re = new RegExp(PAGEUP_JSONLD_REGEX.source, 'gi');
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
  private extractPosting(value: unknown): PageUpJobPosting | null {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.extractPosting(item);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (this.isJobPostingType(obj['@type'])) return obj as PageUpJobPosting;
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

  /** Map a normalised PageUpJob → JobPostDto. */
  private processJob(
    job: PageUpJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url || job.canonicalUrl;
    if (!jobUrl) return null;

    const companyName = this.deriveCompanyName(job.companyName, tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, job.description ?? null, format);

    return new JobPostDto({
      id: `pageup-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description),
      site: Site.PAGEUP,
      atsId,
      atsType: 'pageup',
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
   * Resolve the tenant listing base URL (ending in `…/{caw}/{lang}/`). A
   * `companyUrl` on the `pageuppeople.com` domain has its instance path used
   * verbatim (trimmed back to the `…/{caw}/{lang}/` segment); a bare numeric
   * `companySlug` is expanded into `careers.pageuppeople.com/{id}/caw/en/`.
   * Returns an empty string when neither yields a base.
   */
  private resolveListingBase(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.toLowerCase();
        if (hostname === PAGEUP_ROOT_DOMAIN || hostname.endsWith(`.${PAGEUP_ROOT_DOMAIN}`)) {
          const origin = `${u.protocol}//${u.host}`;
          // Trim the path back to `…/{instanceId}/{caw}/{lang}/`, if present.
          const m = u.pathname.match(/^(\/\d+\/[a-z-]+\/[a-z-]+\/)/i);
          if (m) return `${origin}${m[1]}`;
          // A custom host without an instance path: use the origin's first
          // `…/{caw}/{lang}/` segment if present, else the origin root.
          const seg = u.pathname.match(/^(\/[a-z-]+\/[a-z-]+\/)/i);
          if (seg) return `${origin}${seg[1]}`;
          return `${origin}/`;
        }
      } catch {
        // Malformed URL — fall through to the slug.
      }
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A bare numeric instance id → canonical careers host base.
      if (/^\d+$/.test(slug)) {
        return `${PAGEUP_PLATFORM_HOST}/${slug}/${PAGEUP_CAW_SEGMENT}/${PAGEUP_LANG_SEGMENT}/`;
      }
      // A caller may also pass a full host/path (e.g. "careers.pageuppeople.com/595/caw/en").
      if (slug.toLowerCase().includes(PAGEUP_ROOT_DOMAIN)) {
        const cleaned = slug.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        return `https://${cleaned}/`;
      }
      // Otherwise treat it as a custom tenant sub-domain label.
      return `https://${encodeURIComponent(slug)}.${PAGEUP_ROOT_DOMAIN}/`;
    }
    return '';
  }

  /** Derive a human/tenant token (instance id or sub-domain label) for labelling. */
  private deriveTenant(companySlug: string | undefined, base: string): string {
    if (companySlug && companySlug.trim() && !companySlug.includes('/') && !companySlug.includes('.')) {
      return companySlug.trim();
    }
    try {
      const u = new URL(base);
      const idMatch = u.pathname.match(/^\/(\d+)\//);
      if (idMatch) return idMatch[1];
      const label = u.hostname.split('.')[0] || '';
      return label;
    } catch {
      return companySlug?.trim() || base;
    }
  }

  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : tenant) || tenant;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the location parts (locality / region / country) as a LocationDto,
   * leaving location null when nothing usable is present.
   */
  private extractLocation(job: PageUpJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from `jobLocationType`, the title, or the location text. */
  private detectRemote(
    posting: PageUpJobPosting | null,
    title: string | null,
    address: PageUpPostalAddress | null,
    labelLocation: string | null,
  ): boolean {
    const locType = this.cleanText(posting?.jobLocationType);
    if (locType && /telecommute|remote/i.test(locType)) return true;
    const haystacks: Array<string | null | undefined> = [
      title,
      labelLocation,
      this.cleanText(address?.addressLocality),
      this.cleanText(address?.addressRegion),
      this.cleanText(posting?.employmentType as string),
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (PAGEUP_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Return the first `PostalAddress` from a `jobLocation` (object or array). */
  private firstAddress(
    jobLocation: PageUpJobLocation | PageUpJobLocation[] | null | undefined,
  ): PageUpPostalAddress | null {
    if (!jobLocation) return null;
    const first = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
    const address = first?.address;
    return address && typeof address === 'object' ? address : null;
  }

  /** Resolve the hiring-organisation display name (object `name` or bare string). */
  private organizationName(
    org: PageUpJobPosting['hiringOrganization'],
  ): string | null {
    if (!org) return null;
    if (typeof org === 'string') return this.cleanText(org);
    return this.cleanText(org.name);
  }

  /** Resolve the country display value (a bare code/name, or an object with `name`). */
  private countryName(country: PageUpPostalAddress['addressCountry']): string | null {
    if (!country) return null;
    if (typeof country === 'string') return this.cleanText(country);
    return this.cleanText(country.name);
  }

  /**
   * Normalise a schema.org `employmentType` (e.g. `FULL_TIME`, `PART_TIME`,
   * `CONTRACTOR`, or an array thereof) into a readable label (`Full Time`,
   * `Part Time`, …). Free-text values (e.g. PageUp's "Permanent") are passed
   * through trimmed + title-cased.
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

  /**
   * Strip PageUp's trailing timezone words from an "Advertised:" value so the date
   * parses cleanly (e.g. "03 Jun 2026 GMT Daylight Time" → "03 Jun 2026").
   */
  private stripTimezone(value: string | null): string | null {
    if (!value) return null;
    const m = value.match(/^(\d{1,2}\s+\w{3,9}\s+\d{4})/);
    return m ? m[1] : value;
  }

  /** Decode a maybe-null labelled value's HTML entities, returning null for empty. */
  private decodeMaybe(value: string | null): string | null {
    const cleaned = this.cleanText(value);
    return cleaned ? this.decodeEntities(cleaned) : null;
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

  /** Strip any HTML tags from a captured fragment (e.g. an `<h1>` with inner spans). */
  private stripTags(value: string | null): string | null {
    if (typeof value !== 'string') return null;
    const v = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return v.length > 0 ? v : null;
  }

  /** Origin (`scheme://host`) of a base URL, falling back to the platform host. */
  private originOf(base: string): string {
    try {
      const u = new URL(base);
      return `${u.protocol}//${u.host}`;
    } catch {
      return PAGEUP_PLATFORM_HOST;
    }
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
