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
  ARCORO_HOST_TEMPLATE,
  ARCORO_SHARED_HOST,
  ARCORO_ROOT_DOMAIN,
  ARCORO_CAREERPAGES_DOMAIN,
  ARCORO_LISTING_PATH,
  ARCORO_SITEMAP_PATH,
  ARCORO_JOB_PATH_TEMPLATE,
  ARCORO_JOB_URL_REGEX,
  ARCORO_SITEMAP_LOC_REGEX,
  ARCORO_JSONLD_REGEX,
  ARCORO_META_REGEX_TEMPLATE,
  ARCORO_TITLE_TAG_REGEX,
  ARCORO_H1_REGEX,
  ARCORO_LOCATION_LINE_REGEX,
  ARCORO_EMPLOYMENT_TYPE_REGEX,
  ARCORO_REMOTE_REGEX,
  ARCORO_DEFAULT_RESULTS,
  ARCORO_HEADERS,
} from './arcoro.constants';
import { ArcoroJob, ArcoroJobLink, ArcoroJsonLd, ArcoroJsonLdLocation } from './arcoro.types';

/**
 * Arcoro (formerly BirdDogHR) ATS careers scraper — generic, multi-tenant.
 *
 * Arcoro (arcoro.com) is a US construction / skilled-trades HR suite whose
 * ATS/job-board engine (historically "BirdDogHR") hosts every customer's open
 * roles on a public, server-side-rendered board at
 * `https://{tenant}.birddoghr.com/` (and on the shared
 * `https://jobs.ourcareerpages.com/` host). The board's listing/search page is
 * client-rendered, so the adapter enumerates a tenant's roles by harvesting
 * `/job/{jobId}` links from the listing HTML (and, as a fallback, the
 * `/sitemap.xml`), then parses each server-rendered detail page for its
 * structured metadata — preferring a schema.org `JobPosting` JSON-LD block when
 * present, then Open Graph meta tags, then the visible HTML title / location /
 * employment-type lines.
 *
 * The caller addresses a tenant by `companySlug` (the board sub-domain label,
 * e.g. `engineeringjobs`) or by `companyUrl` (a board URL on the
 * `birddoghr.com` / `ourcareerpages.com` domain, whose origin is used verbatim
 * — including a direct `/job/{id}` deep link). The listing enumerates every
 * open role in one document, so we slice client-side to honour `resultsWanted`.
 * A single fetch error, an unknown tenant (HTTP 4xx), or a malformed page
 * degrades to an empty / partial result rather than throwing, so a single
 * tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.ARCORO,
  name: 'Arcoro',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ArcoroService implements IScraper {
  private readonly logger = new Logger(ArcoroService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Arcoro scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve an Arcoro career host from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(ARCORO_HEADERS);

    const resultsWanted = input.resultsWanted ?? ARCORO_DEFAULT_RESULTS;
    const tenant = this.deriveTenant(companySlug, host);
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Arcoro jobs from: ${host}`);

      // A `companyUrl` may already be a direct `/job/{id}` deep link; honour it.
      let links = this.directLink(input.companyUrl, host);
      if (links.length === 0) {
        // Otherwise enumerate the tenant's open roles from the listing/sitemap.
        links = await this.fetchJobLinks(client, host);
      }
      if (links.length === 0) {
        this.logger.log(`Arcoro host "${host}" has no discoverable open roles`);
        return new JobResponseDto([]);
      }

      // Only fetch as many detail pages as the caller asked for (deduped first).
      const wanted = links.filter((l) => !seen.has(l.jobId) && seen.add(l.jobId)).slice(0, resultsWanted);

      for (const link of wanted) {
        try {
          const post = await this.processLink(client, link, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Arcoro job ${link.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`Arcoro total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Arcoro scrape error for ${host}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * If a `companyUrl` is itself a `/job/{id}` deep link on the resolved host,
   * return it as the single role to fetch (bypassing listing enumeration).
   */
  private directLink(companyUrl: string | undefined, host: string): ArcoroJobLink[] {
    if (!companyUrl) return [];
    const m = /\/job\/(\d+)\b/i.exec(companyUrl);
    if (!m) return [];
    const jobId = m[1];
    return [{ jobId, url: `${host}${ARCORO_JOB_PATH_TEMPLATE.replace('{jobId}', jobId)}` }];
  }

  /**
   * Enumerate the tenant's open-role `/job/{id}` links. The listing/search page
   * is the primary source; the XML sitemap is tried as a fallback. An unknown
   * sub-domain (HTTP 4xx) or a missing board degrades to an empty list.
   */
  private async fetchJobLinks(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<ArcoroJobLink[]> {
    const sources = [`${host}${ARCORO_LISTING_PATH}`, `${host}/`, `${host}${ARCORO_SITEMAP_PATH}`];
    const seen = new Set<string>();
    const links: ArcoroJobLink[] = [];

    for (const url of sources) {
      let body = '';
      try {
        const response = await client.get<string>(url, { responseType: 'text' });
        body = typeof response.data === 'string' ? response.data : '';
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && status >= 400 && status < 500) {
          this.logger.warn(`Arcoro source not found (HTTP ${status}) at ${url}`);
          continue;
        }
        throw err;
      }

      this.harvestLinks(body, host, seen, links);
      // The listing usually carries every role; stop once we have some.
      if (links.length > 0) break;
    }

    return links;
  }

  /**
   * Harvest `/job/{id}` links from a listing page or sitemap body. Both
   * `<loc>` sitemap entries and inline anchors are scanned; ids are
   * de-duplicated and resolved to absolute URLs on the tenant host.
   */
  private harvestLinks(body: string, host: string, seen: Set<string>, out: ArcoroJobLink[]): void {
    const push = (jobId: string) => {
      if (!jobId || seen.has(jobId)) return;
      seen.add(jobId);
      out.push({ jobId, url: `${host}${ARCORO_JOB_PATH_TEMPLATE.replace('{jobId}', jobId)}` });
    };

    // Sitemap `<loc>` entries first (when the body is XML).
    const locRegex = new RegExp(ARCORO_SITEMAP_LOC_REGEX.source, 'gi');
    let locMatch: RegExpExecArray | null;
    while ((locMatch = locRegex.exec(body)) !== null) {
      const jm = /\/job\/(\d+)\b/i.exec(locMatch[1]);
      if (jm) push(jm[1]);
    }

    // Inline `/job/{id}` links (listing anchors).
    const jobRegex = new RegExp(ARCORO_JOB_URL_REGEX.source, 'gi');
    let jm: RegExpExecArray | null;
    while ((jm = jobRegex.exec(body)) !== null) {
      push(jm[1]);
    }
  }

  /** Fetch + parse a single detail page, then map it to a JobPostDto. */
  private async processLink(
    client: ReturnType<typeof createHttpClient>,
    link: ArcoroJobLink,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    let html = '';
    try {
      const response = await client.get<string>(link.url, { responseType: 'text' });
      html = typeof response.data === 'string' ? response.data : '';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        // A closed / removed role 404s; skip it without failing the batch.
        this.logger.warn(`Arcoro job ${link.jobId} not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }

    const job = this.parseDetail(html, link);
    return this.processJob(job, tenant, format);
  }

  /**
   * Parse a detail page's HTML into a normalised ArcoroJob. A schema.org
   * `JobPosting` JSON-LD block is preferred; otherwise the role is assembled
   * from Open Graph meta tags and the visible HTML title / location lines.
   */
  private parseDetail(html: string, link: ArcoroJobLink): ArcoroJob {
    const jsonLd = this.parseJsonLd(html);

    const ogTitle = this.meta(html, 'og:title');
    const titleTag = this.firstGroup(html, ARCORO_TITLE_TAG_REGEX);
    const h1 = this.firstGroup(html, ARCORO_H1_REGEX);
    const ogDescription = this.meta(html, 'og:description') ?? this.meta(html, 'description');
    const canonicalUrl = this.meta(html, 'og:url') ?? (jsonLd?.url ?? null);

    // Title: JSON-LD → og:title → <h1> → leading segment of <title>.
    const title =
      this.cleanText(jsonLd?.title) ??
      this.leadingTitle(ogTitle) ??
      this.cleanText(this.stripTags(h1)) ??
      this.leadingTitle(titleTag);

    const company = this.jsonLdOrganization(jsonLd) ?? null;
    const loc = this.parseLocation(jsonLd, html);

    const descriptionHtml = this.cleanText(jsonLd?.description);
    const descriptionText = ogDescription ? this.decodeEntities(ogDescription) : null;

    const job: ArcoroJob = {
      jobId: link.jobId,
      url: link.url,
      canonicalUrl: canonicalUrl ? this.decodeEntities(canonicalUrl) : null,
      title: title ? this.decodeEntities(title) : null,
      companyName: company ? this.decodeEntities(company) : null,
      descriptionHtml: descriptionHtml ? this.decodeEntities(descriptionHtml) : null,
      description: descriptionText,
      city: loc.city,
      state: loc.state,
      country: loc.country,
      employmentType: this.normalizeEmploymentType(jsonLd, html),
      datePosted: this.parseDate(this.cleanText(jsonLd?.datePosted)),
      isRemote: false,
    };
    job.isRemote = this.detectRemote(job, jsonLd, html);
    return job;
  }

  /**
   * Parse the first schema.org `JobPosting` JSON-LD block on the page, when one
   * is present. Tenants vary in whether they emit it, so this is best-effort.
   */
  private parseJsonLd(html: string): ArcoroJsonLd | null {
    const regex = new RegExp(ARCORO_JSONLD_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const node = this.findJobPosting(parsed);
        if (node) return node;
      } catch {
        // Malformed JSON-LD — try the next block.
      }
    }
    return null;
  }

  /**
   * Locate a `JobPosting` node within a parsed JSON-LD value, which may be a
   * single object, an array, or a `@graph` container.
   */
  private findJobPosting(value: any): ArcoroJsonLd | null {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findJobPosting(item);
        if (found) return found;
      }
      return null;
    }
    const type = value['@type'];
    const isJobPosting = Array.isArray(type)
      ? type.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting')
      : typeof type === 'string' && type.toLowerCase() === 'jobposting';
    if (isJobPosting) return value as ArcoroJsonLd;
    if (Array.isArray(value['@graph'])) return this.findJobPosting(value['@graph']);
    return null;
  }

  /** Map a normalised ArcoroJob → JobPostDto. */
  private processJob(
    job: ArcoroJob,
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
      id: `arcoro-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description),
      site: Site.ARCORO,
      atsId,
      atsType: 'arcoro',
      employmentType: this.cleanText(job.employmentType),
      applyUrl: job.canonicalUrl || jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The JSON-LD `description`
   * is an HTML body, so we prefer it for consistent markdown / plain conversion,
   * falling back to the plain-text meta description when no HTML is available.
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
   * Resolve the tenant's career host. A `companyUrl` on the `birddoghr.com` /
   * `ourcareerpages.com` domain has its origin used verbatim (so the shared
   * career-pages host and any vanity sub-domain are both supported); else a
   * `companySlug` is expanded into the canonical `{tenant}.birddoghr.com` host
   * (or the shared host when the slug names it). Returns an empty string when
   * neither yields a usable host.
   */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.toLowerCase();
        if (hostname.endsWith(ARCORO_ROOT_DOMAIN) || hostname.endsWith(ARCORO_CAREERPAGES_DOMAIN)) {
          return `${u.protocol}//${u.host}`;
        }
      } catch {
        // Malformed URL — fall through to the slug.
      }
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim().toLowerCase();
      // A caller may also pass a bare host (e.g. "engineeringjobs.birddoghr.com").
      if (slug.includes(ARCORO_ROOT_DOMAIN) || slug.includes(ARCORO_CAREERPAGES_DOMAIN)) {
        const host = slug.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        return `https://${host}`;
      }
      // The shared career-pages host is addressed by its conventional labels.
      if (slug === 'ourcareerpages' || slug === 'jobs') {
        return ARCORO_SHARED_HOST;
      }
      return ARCORO_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(slug));
    }
    return '';
  }

  /** Derive a tenant token (sub-domain label) for logging / fallback company naming. */
  private deriveTenant(companySlug: string | undefined, host: string): string {
    if (companySlug && companySlug.trim() && !companySlug.includes('.')) return companySlug.trim();
    try {
      const label = new URL(host).hostname.split('.')[0] || '';
      return label || host;
    } catch {
      return companySlug?.trim() || host;
    }
  }

  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : tenant) || tenant;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Read the hiring-organisation name from a JSON-LD `JobPosting`, when present. */
  private jsonLdOrganization(jsonLd: ArcoroJsonLd | null): string | null {
    if (!jsonLd) return null;
    const org = jsonLd.hiringOrganization;
    if (typeof org === 'string') return this.cleanText(org);
    if (org && typeof org === 'object') return this.cleanText(org.name);
    return null;
  }

  /**
   * Resolve the role location. A JSON-LD `jobLocation.address` is preferred;
   * otherwise a US "{City}, {ST} {ZIP}" line is mined from the visible HTML.
   */
  private parseLocation(
    jsonLd: ArcoroJsonLd | null,
    html: string,
  ): { city: string | null; state: string | null; country: string | null } {
    const fromLd = this.locationFromJsonLd(jsonLd);
    if (fromLd.city || fromLd.state || fromLd.country) return fromLd;

    // Fall back to a "City, ST ZIP" line in the page body text.
    const text = this.stripTags(html);
    const m = ARCORO_LOCATION_LINE_REGEX.exec(text);
    if (m) {
      return {
        city: this.cleanText(m[1]),
        state: this.cleanText(m[2]),
        country: null,
      };
    }
    return { city: null, state: null, country: null };
  }

  /** Extract address parts from a JSON-LD `jobLocation` (object or array). */
  private locationFromJsonLd(
    jsonLd: ArcoroJsonLd | null,
  ): { city: string | null; state: string | null; country: string | null } {
    const empty = { city: null, state: null, country: null };
    if (!jsonLd) return empty;
    const raw = jsonLd.jobLocation;
    const node: ArcoroJsonLdLocation | undefined = Array.isArray(raw) ? raw[0] : raw ?? undefined;
    const address = node?.address;
    if (!address || typeof address !== 'object') return empty;
    const country =
      typeof address.addressCountry === 'string'
        ? address.addressCountry
        : address.addressCountry?.name ?? null;
    return {
      city: this.cleanText(address.addressLocality),
      state: this.cleanText(address.addressRegion),
      country: this.cleanText(country),
    };
  }

  private extractLocation(job: ArcoroJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Normalise the employment type. A schema.org `employmentType` ("FULL_TIME")
   * is preferred and humanised; otherwise a body label ("full-time", …) is
   * matched.
   */
  private normalizeEmploymentType(jsonLd: ArcoroJsonLd | null, html: string): string | null {
    const raw = jsonLd?.employmentType;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim()) {
      return value
        .trim()
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    const text = this.stripTags(html);
    const m = ARCORO_EMPLOYMENT_TYPE_REGEX.exec(text);
    return m ? m[1] : null;
  }

  /** Detect remote roles from JSON-LD location type, the title, or the body. */
  private detectRemote(job: ArcoroJob, jsonLd: ArcoroJsonLd | null, html: string): boolean {
    const locType = this.cleanText(jsonLd?.jobLocationType);
    if (locType && /telecommute|remote/i.test(locType)) return true;
    const haystacks: Array<string | null | undefined> = [
      job.title,
      job.city,
      job.state,
      job.employmentType,
      job.description,
    ];
    for (const field of haystacks) {
      if (typeof field === 'string' && ARCORO_REMOTE_REGEX.test(field)) return true;
    }
    // Only inspect the body when nothing structured flagged remote.
    return ARCORO_REMOTE_REGEX.test(this.stripTags(html).slice(0, 4000));
  }

  /** Read a `<meta>` content value by Open Graph property / name. */
  private meta(html: string, key: string): string | null {
    const re = new RegExp(ARCORO_META_REGEX_TEMPLATE.replace(/\{key\}/g, this.escapeRegex(key)), 'i');
    return this.firstGroup(html, re);
  }

  /** Return the leading "{title}" segment of a "{title} - {company}" string. */
  private leadingTitle(value: string | null): string | null {
    if (!value) return null;
    const cleaned = value.trim();
    if (!cleaned) return null;
    // <title> / og:title use " - " or " | " between the role and the company.
    const idx = cleaned.search(/\s[-|]\s/);
    const head = idx > 0 ? cleaned.slice(0, idx) : cleaned;
    return this.cleanText(head);
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

  /** Strip HTML tags from a fragment, collapsing whitespace. */
  private stripTags(value: string | null | undefined): string {
    if (typeof value !== 'string') return '';
    return value
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Escape regex metacharacters in a literal substring (e.g. a meta key). */
  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Decode the handful of HTML entities that appear in meta-tag / JSON-LD content. */
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
