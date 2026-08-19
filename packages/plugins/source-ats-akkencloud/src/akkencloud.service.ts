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
  AKKENCLOUD_SHARED_HOST,
  AKKENCLOUD_HOST_TEMPLATE,
  AKKENCLOUD_ROOT_DOMAIN,
  AKKENCLOUD_SHARED_LABELS,
  AKKENCLOUD_LISTING_PATH,
  AKKENCLOUD_SITEMAP_PATH,
  AKKENCLOUD_JOB_PATH_TEMPLATE,
  AKKENCLOUD_APPLY_PATH,
  AKKENCLOUD_JOB_URL_REGEX,
  AKKENCLOUD_SITEMAP_LOC_REGEX,
  AKKENCLOUD_JSONLD_REGEX,
  AKKENCLOUD_META_REGEX_TEMPLATE,
  AKKENCLOUD_TITLE_TAG_REGEX,
  AKKENCLOUD_H1_REGEX,
  AKKENCLOUD_LOCATION_LINE_REGEX,
  AKKENCLOUD_EMPLOYMENT_TYPE_REGEX,
  AKKENCLOUD_REMOTE_REGEX,
  AKKENCLOUD_DEFAULT_RESULTS,
  AKKENCLOUD_MAX_PAGES,
  AKKENCLOUD_HEADERS,
} from './akkencloud.constants';
import {
  AkkenCloudJob,
  AkkenCloudJobLink,
  AkkenCloudJsonLd,
  AkkenCloudJsonLdLocation,
} from './akkencloud.types';

/**
 * AkkenCloud ATS / staffing careers scraper — generic, multi-tenant.
 *
 * AkkenCloud (akkencloud.com, US) is an enterprise staffing & recruiting suite
 * whose candidate-facing product is a hosted job board. Every customer agency
 * publishes a branded, public, unauthenticated board served by the same
 * server-side ("AKKEN") application — on the shared host
 * `https://jobs.akkencloud.com/`, on a per-agency `https://{tenant}.akkencloud.com/`
 * sub-domain, or on the agency's own custom careers domain rendering the same
 * app. Each role has a stable, server-rendered detail page addressed by its
 * numeric job id: `/jobdetails/{slug}/{location}/{jobId}` (and the short
 * `/jobdetails/{jobId}` form). The adapter enumerates a tenant's open roles by
 * harvesting `/jobdetails/.../{jobId}` links from the listing HTML (and, as a
 * fallback, the `/sitemap.xml`), then parses each detail page for its structured
 * metadata — preferring a schema.org `JobPosting` JSON-LD block when present,
 * then Open Graph meta tags, then the visible HTML title / location /
 * employment-type lines.
 *
 * The caller addresses a tenant by `companySlug` (the board sub-domain label,
 * e.g. `acme-staffing`, or `jobs` for the shared host) or by `companyUrl` (a
 * board URL on an `akkencloud.com` host, whose origin is used verbatim —
 * including a direct `/jobdetails/.../{id}` deep link). The listing enumerates
 * the open roles, so we slice client-side to honour `resultsWanted`. A single
 * fetch error, a DNS failure, an unknown tenant (HTTP 4xx), or a malformed page
 * degrades to an empty / partial result rather than throwing, so a single tenant
 * never nukes a batch run.
 *
 * Surface confidence: DEFENSIVE (verified=false). The platform, the canonical
 * board host, and the `/jobdetails/{...}/{id}` + `/submit_application` URL shapes
 * were observed via the public search index on 2026-06-03, but the live board
 * host did not resolve from the research network, so the exact HTML / JSON-LD
 * wire shapes could not be byte-confirmed. The parser is fully defensive.
 */
@SourcePlugin({
  site: Site.AKKENCLOUD,
  name: 'AkkenCloud',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class AkkenCloudService implements IScraper {
  private readonly logger = new Logger(AkkenCloudService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for AkkenCloud scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve an AkkenCloud career host from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(AKKENCLOUD_HEADERS);

    const resultsWanted = input.resultsWanted ?? AKKENCLOUD_DEFAULT_RESULTS;
    const tenant = this.deriveTenant(companySlug, host);
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching AkkenCloud jobs from: ${host}`);

      // A `companyUrl` may already be a direct `/jobdetails/.../{id}` deep link.
      let links = this.directLink(input.companyUrl, host);
      if (links.length === 0) {
        // Otherwise enumerate the tenant's open roles from the listing / sitemap.
        links = await this.fetchJobLinks(client, host);
      }
      if (links.length === 0) {
        this.logger.log(`AkkenCloud host "${host}" has no discoverable open roles`);
        return new JobResponseDto([]);
      }

      // Only fetch as many detail pages as the caller asked for (deduped first).
      const wanted = links
        .filter((l) => !seen.has(l.jobId) && seen.add(l.jobId))
        .slice(0, resultsWanted);

      for (const link of wanted) {
        try {
          const post = await this.processLink(client, link, host, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing AkkenCloud job ${link.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`AkkenCloud total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`AkkenCloud scrape error for ${host}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * If a `companyUrl` is itself a `/jobdetails/.../{id}` deep link on the resolved
   * host, return it as the single role to fetch (bypassing listing enumeration).
   */
  private directLink(companyUrl: string | undefined, host: string): AkkenCloudJobLink[] {
    if (!companyUrl) return [];
    const m = /\/jobdetails\/(?:[^"'\s<>]*?\/)?(\d+)\b/i.exec(companyUrl);
    if (!m) return [];
    const jobId = m[1];
    return [{ jobId, url: this.jobUrl(host, jobId) }];
  }

  /**
   * Enumerate the tenant's open-role `/jobdetails/.../{id}` links. The listing
   * landing page is the primary source; the XML sitemap is tried as a fallback.
   * An unknown host (DNS failure / HTTP 4xx) or a missing board degrades to an
   * empty list.
   */
  private async fetchJobLinks(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<AkkenCloudJobLink[]> {
    const sources = [`${host}${AKKENCLOUD_LISTING_PATH}`, `${host}${AKKENCLOUD_SITEMAP_PATH}`];
    const seen = new Set<string>();
    const links: AkkenCloudJobLink[] = [];
    let pages = 0;

    for (const url of sources) {
      if (pages >= AKKENCLOUD_MAX_PAGES) break;
      pages++;
      let body = '';
      try {
        const response = await client.get<string>(url, { responseType: 'text' });
        body = typeof response.data === 'string' ? response.data : '';
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && status >= 400 && status < 500) {
          this.logger.warn(`AkkenCloud source not found (HTTP ${status}) at ${url}`);
          continue;
        }
        // A DNS / connection failure on the listing → no roles (graceful), not a throw.
        if (this.isNetworkError(err)) {
          this.logger.warn(`AkkenCloud source unreachable (${err.code ?? err.message}) at ${url}`);
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
   * Harvest `/jobdetails/.../{id}` links from a listing page or sitemap body.
   * Both `<loc>` sitemap entries and inline anchors are scanned; ids are
   * de-duplicated and resolved to absolute URLs on the tenant host.
   */
  private harvestLinks(
    body: string,
    host: string,
    seen: Set<string>,
    out: AkkenCloudJobLink[],
  ): void {
    const push = (jobId: string) => {
      if (!jobId || seen.has(jobId)) return;
      seen.add(jobId);
      out.push({ jobId, url: this.jobUrl(host, jobId) });
    };

    // Sitemap `<loc>` entries first (when the body is XML).
    const locRegex = new RegExp(AKKENCLOUD_SITEMAP_LOC_REGEX.source, 'gi');
    let locMatch: RegExpExecArray | null;
    while ((locMatch = locRegex.exec(body)) !== null) {
      const jm = /\/jobdetails\/(?:[^"'\s<>]*?\/)?(\d+)\b/i.exec(locMatch[1]);
      if (jm) push(jm[1]);
    }

    // Inline `/jobdetails/.../{id}` links (listing anchors).
    const jobRegex = new RegExp(AKKENCLOUD_JOB_URL_REGEX.source, 'gi');
    let jm: RegExpExecArray | null;
    while ((jm = jobRegex.exec(body)) !== null) {
      push(jm[1]);
    }
  }

  /** Fetch + parse a single detail page, then map it to a JobPostDto. */
  private async processLink(
    client: ReturnType<typeof createHttpClient>,
    link: AkkenCloudJobLink,
    host: string,
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
        this.logger.warn(`AkkenCloud job ${link.jobId} not found (HTTP ${status})`);
        return null;
      }
      if (this.isNetworkError(err)) {
        this.logger.warn(`AkkenCloud job ${link.jobId} unreachable (${err.code ?? err.message})`);
        return null;
      }
      throw err;
    }

    const job = this.parseDetail(html, link, host);
    return this.processJob(job, tenant, format);
  }

  /**
   * Parse a detail page's HTML into a normalised AkkenCloudJob. A schema.org
   * `JobPosting` JSON-LD block is preferred; otherwise the role is assembled from
   * Open Graph meta tags and the visible HTML title / location lines.
   */
  private parseDetail(html: string, link: AkkenCloudJobLink, host: string): AkkenCloudJob {
    const jsonLd = this.parseJsonLd(html);

    const ogTitle = this.meta(html, 'og:title');
    const titleTag = this.firstGroup(html, AKKENCLOUD_TITLE_TAG_REGEX);
    const h1 = this.firstGroup(html, AKKENCLOUD_H1_REGEX);
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

    const job: AkkenCloudJob = {
      jobId: link.jobId,
      url: link.url,
      canonicalUrl: canonicalUrl ? this.decodeEntities(canonicalUrl) : null,
      applyUrl: `${host}${AKKENCLOUD_APPLY_PATH}`,
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
   * is present. Boards vary in whether they emit it, so this is best-effort.
   */
  private parseJsonLd(html: string): AkkenCloudJsonLd | null {
    const regex = new RegExp(AKKENCLOUD_JSONLD_REGEX.source, 'gi');
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
  private findJobPosting(value: any): AkkenCloudJsonLd | null {
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
    if (isJobPosting) return value as AkkenCloudJsonLd;
    if (Array.isArray(value['@graph'])) return this.findJobPosting(value['@graph']);
    return null;
  }

  /** Map a normalised AkkenCloudJob → JobPostDto. */
  private processJob(
    job: AkkenCloudJob,
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
    const description = this.formatDescription(
      job.descriptionHtml ?? null,
      job.description ?? null,
      format,
    );

    return new JobPostDto({
      id: `akkencloud-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.AKKENCLOUD,
      atsId,
      atsType: 'akkencloud',
      employmentType: this.cleanText(job.employmentType),
      applyUrl: job.applyUrl || job.canonicalUrl || jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The JSON-LD `description` is
   * an HTML body, so we prefer it for consistent markdown / plain conversion,
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
   * Resolve the tenant's career host. A `companyUrl` on an `akkencloud.com` host
   * has its origin used verbatim (so the shared board and any per-agency
   * sub-domain are both supported); else a `companySlug` is expanded into the
   * canonical `{tenant}.akkencloud.com` host (or the shared host when the slug
   * names a shared label such as `jobs`). Returns an empty string when neither
   * yields a usable host.
   */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.toLowerCase();
        if (hostname.endsWith(AKKENCLOUD_ROOT_DOMAIN)) {
          return `${u.protocol}//${u.host}`;
        }
      } catch {
        // Malformed URL — fall through to the slug.
      }
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim().toLowerCase();
      // A caller may also pass a bare host (e.g. "acme-staffing.akkencloud.com").
      if (slug.includes(AKKENCLOUD_ROOT_DOMAIN)) {
        const host = slug.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        return `https://${host}`;
      }
      // A conventional shared label names the shared board host.
      if (AKKENCLOUD_SHARED_LABELS.includes(slug)) {
        return AKKENCLOUD_SHARED_HOST;
      }
      return AKKENCLOUD_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(slug));
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

  /** Build a canonical short detail-page URL for a role on the tenant host. */
  private jobUrl(host: string, jobId: string): string {
    return `${host}${AKKENCLOUD_JOB_PATH_TEMPLATE.replace('{jobId}', encodeURIComponent(jobId))}`;
  }

  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : tenant) || tenant;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Read the hiring-organisation name from a JSON-LD `JobPosting`, when present. */
  private jsonLdOrganization(jsonLd: AkkenCloudJsonLd | null): string | null {
    if (!jsonLd) return null;
    const org = jsonLd.hiringOrganization;
    if (typeof org === 'string') return this.cleanText(org);
    if (org && typeof org === 'object') return this.cleanText(org.name);
    return null;
  }

  /**
   * Resolve the role location. A JSON-LD `jobLocation.address` is preferred;
   * otherwise a US "{City}, {ST}" line is mined from the visible HTML.
   */
  private parseLocation(
    jsonLd: AkkenCloudJsonLd | null,
    html: string,
  ): { city: string | null; state: string | null; country: string | null } {
    const fromLd = this.locationFromJsonLd(jsonLd);
    if (fromLd.city || fromLd.state || fromLd.country) return fromLd;

    // Fall back to a "City, ST" / "City, ST ZIP" line in the page body text.
    const text = this.stripTags(html);
    const m = AKKENCLOUD_LOCATION_LINE_REGEX.exec(text);
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
    jsonLd: AkkenCloudJsonLd | null,
  ): { city: string | null; state: string | null; country: string | null } {
    const empty = { city: null, state: null, country: null };
    if (!jsonLd) return empty;
    const raw = jsonLd.jobLocation;
    const node: AkkenCloudJsonLdLocation | undefined = Array.isArray(raw) ? raw[0] : raw ?? undefined;
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

  private extractLocation(job: AkkenCloudJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Normalise the employment type. A schema.org `employmentType` ("FULL_TIME",
   * "CONTRACTOR") is preferred and humanised; otherwise a body label
   * ("contract-to-hire", "temp-to-perm", …) is matched.
   */
  private normalizeEmploymentType(jsonLd: AkkenCloudJsonLd | null, html: string): string | null {
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
    const m = AKKENCLOUD_EMPLOYMENT_TYPE_REGEX.exec(text);
    return m ? m[1] : null;
  }

  /** Detect remote roles from JSON-LD location type, the title, or the body. */
  private detectRemote(job: AkkenCloudJob, jsonLd: AkkenCloudJsonLd | null, html: string): boolean {
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
      if (typeof field === 'string' && AKKENCLOUD_REMOTE_REGEX.test(field)) return true;
    }
    // Only inspect the body when nothing structured flagged remote.
    return AKKENCLOUD_REMOTE_REGEX.test(this.stripTags(html).slice(0, 4000));
  }

  /** True when an error is a DNS / connection failure (so we degrade, not throw). */
  private isNetworkError(err: any): boolean {
    const code = err?.code;
    if (typeof code !== 'string') return false;
    return [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNABORTED',
      'EHOSTUNREACH',
      'ENETUNREACH',
    ].includes(code);
  }

  /** Read a `<meta>` content value by Open Graph property / name. */
  private meta(html: string, key: string): string | null {
    const re = new RegExp(AKKENCLOUD_META_REGEX_TEMPLATE.replace(/\{key\}/g, this.escapeRegex(key)), 'i');
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
