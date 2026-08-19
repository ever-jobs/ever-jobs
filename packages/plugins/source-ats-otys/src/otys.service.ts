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
  OTYS_HOST_TEMPLATE,
  OTYS_ROOT_DOMAIN,
  OTYS_ALT_DOMAINS,
  OTYS_INDEX_PATHS,
  OTYS_DEFAULT_RESULTS,
  OTYS_MAX_PAGES,
  OTYS_HEADERS,
  OTYS_JOB_LINK_REGEX,
  OTYS_JSONLD_REGEX,
  OTYS_OG_TITLE_REGEX,
  OTYS_OG_URL_REGEX,
  OTYS_OG_DESCRIPTION_REGEX,
  OTYS_TITLE_TAG_REGEX,
  OTYS_REMOTE_REGEX,
} from './otys.constants';
import { OtysJob, OtysJobLink, OtysJobPostingLd, OtysJobLocationLd } from './otys.types';

/**
 * OTYS (otys.com, Netherlands) recruitment-site careers scraper — generic, multi-tenant.
 *
 * OTYS powers each customer's public, unauthenticated recruitment site, hosted either
 * under the customer's own (sub)domain (e.g. `https://www.{company}.nl/`,
 * `https://vacancy.{company}.com/`) or under the OTYS application host
 * `https://{clientprefix}.otysapp.com/`. The board is server-rendered HTML (it feeds
 * Indeed, talent.com, and Google for Jobs), so the adapter consumes the HTML directly:
 *
 *   GET https://{host}/vacatures.html
 *     → server-rendered HTML listing each published vacancy as a canonical anchor
 *       `/vacatures/vacature-{slug}-{id}-{websiteId}.html`; the numeric `{id}`
 *       (e.g. `1481738`) is the stable OTYS vacancy id (the ATS id).
 *
 *   GET https://{host}/vacatures/vacature-{slug}-{id}-{websiteId}.html
 *     → server-rendered detail page; parsed by preferring a schema.org `JobPosting`
 *       JSON-LD block, then `og:` meta, then the `<title>` / body HTML.
 *
 * The caller addresses a tenant by `companyUrl` (the recruitment-site / vacatures
 * URL, whose origin is used verbatim) or by `companySlug` (a client prefix expanded
 * to `https://{slug}.otysapp.com`). An unknown host (DNS / HTTP 4xx), a missing index,
 * or a malformed body degrades to an empty / partial result rather than throwing, so a
 * single tenant never nukes a batch run.
 *
 * NOTE: OTYS's REST Web API (`https://webapi.otys.app/api/vacancies`) requires a
 * per-tenant API key (401 without it), so it is not a public surface and is not used.
 */
@SourcePlugin({
  site: Site.OTYS,
  name: 'OTYS',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class OtysService implements IScraper {
  private readonly logger = new Logger(OtysService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for OTYS scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve an OTYS tenant host from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(OTYS_HEADERS);

    const resultsWanted = input.resultsWanted ?? OTYS_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching OTYS jobs for host: ${host}`);

      const links = await this.fetchJobLinks(client, host, resultsWanted);
      if (links.length === 0) {
        this.logger.log(`OTYS host "${host}" has no published roles`);
        return new JobResponseDto([]);
      }

      const limit = Math.min(links.length, resultsWanted, OTYS_MAX_PAGES);
      const slice = links.slice(0, limit);

      // Fan out the per-role detail fetches; a single failure must not nuke the batch.
      const settled = await Promise.allSettled(
        slice.map((link) => this.processLink(client, host, link, input.descriptionFormat)),
      );

      for (const result of settled) {
        if (result.status === 'fulfilled' && result.value) {
          jobPosts.push(result.value);
        } else if (result.status === 'rejected') {
          this.logger.warn(`Error processing OTYS role: ${result.reason?.message ?? result.reason}`);
        }
      }

      this.logger.log(`OTYS total: ${jobPosts.length} jobs for ${host}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`OTYS scrape error for ${host}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch the tenant board index and collect deduped canonical vacancy links. OTYS
   * recruitment sites expose the index under one of a few well-known paths; we probe
   * them in order and stop at the first that yields links. An unknown host / HTTP 4xx
   * degrades to an empty list (no throw).
   */
  private async fetchJobLinks(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    resultsWanted: number,
  ): Promise<OtysJobLink[]> {
    const byId = new Map<string, OtysJobLink>();

    for (const path of OTYS_INDEX_PATHS) {
      const html = await this.fetchHtml(client, `${host}${path}`, host);
      if (html == null) continue;

      const links = this.parseIndex(html, host);
      for (const link of links) {
        if (!byId.has(link.id)) byId.set(link.id, link);
        if (byId.size >= Math.min(resultsWanted, OTYS_MAX_PAGES)) {
          return Array.from(byId.values());
        }
      }

      // First index path that produced any links wins; no need to probe the rest.
      if (links.length > 0) break;
    }

    return Array.from(byId.values());
  }

  /**
   * Parse the index HTML into canonical vacancy links. We anchor on the OTYS
   * recruitment-site URL shape `/vacatures/vacature-{slug}-{id}-{websiteId}.html`
   * rather than depending on volatile CSS class names.
   */
  private parseIndex(html: string, host: string): OtysJobLink[] {
    const out: OtysJobLink[] = [];
    const seen = new Set<string>();

    OTYS_JOB_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OTYS_JOB_LINK_REGEX.exec(html)) !== null) {
      const [, path, slug, id, websiteId] = match;
      const jobId = this.cleanText(id);
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);

      out.push({
        id: jobId,
        slug: this.cleanText(slug)?.toLowerCase() ?? null,
        websiteId: this.cleanText(websiteId),
        url: this.absoluteUrl(host, path),
      });
    }

    return out;
  }

  /**
   * Fetch a vacancy detail page and map it to a JobPostDto. A removed-role 4xx (or a
   * malformed page) skips the role gracefully rather than failing the batch.
   */
  private async processLink(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    link: OtysJobLink,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const html = await this.fetchHtml(client, link.url, host);
    const job = this.parseDetail(html, host, link);
    return this.processJob(job, host, format);
  }

  /** GET a URL as text; an HTTP 4xx / DNS failure degrades to null (no throw). */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    host: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`OTYS page not found (HTTP ${status}) for ${host}`);
        return null;
      }
      // 5xx / network / DNS error — degrade gracefully rather than throwing.
      this.logger.warn(`OTYS page fetch failed for ${host}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse a vacancy detail page into a normalised OtysJob, preferring a schema.org
   * `JobPosting` JSON-LD block, then `og:` meta, then the page `<title>` / body. When
   * the detail page is missing/unparseable we still emit a role from the link alone
   * (title de-slugified from the URL), so a thin template never drops a vacancy.
   */
  private parseDetail(html: string | null, host: string, link: OtysJobLink): OtysJob {
    const base: OtysJob = {
      jobId: link.id,
      url: link.url,
      title: this.titleFromSlug(link.slug),
      companyName: this.deriveCompanyName(host),
    };

    if (!html) return base;

    const ld = this.findJobPosting(html);
    if (ld) {
      const address = this.firstAddress(ld.jobLocation);
      base.title = this.cleanText(ld.title) ?? base.title;
      base.description = this.cleanText(ld.description) ?? base.description;
      base.datePosted = this.parseDate(ld.datePosted);
      base.employmentType = this.normaliseEmploymentType(this.firstString(ld.employmentType));
      base.department = this.cleanText(ld.industry);
      base.companyName = this.cleanText(ld.hiringOrganization?.name) ?? base.companyName;
      base.city = this.cleanText(address?.addressLocality);
      base.state = this.cleanText(address?.addressRegion);
      base.country = this.cleanText(this.countryName(address?.addressCountry));
      base.url = this.cleanText(ld.url) ?? base.url;
      base.isRemote = this.detectRemote(base.title, base.city, ld.jobLocationType, base.description);
      return base;
    }

    // No JSON-LD — fall back to og: meta and the <title> / body text.
    const ogTitle = this.matchGroup(html, OTYS_OG_TITLE_REGEX);
    const titleTag = this.matchGroup(html, OTYS_TITLE_TAG_REGEX);
    const ogDescription = this.matchGroup(html, OTYS_OG_DESCRIPTION_REGEX);
    const ogUrl = this.matchGroup(html, OTYS_OG_URL_REGEX);

    base.title = this.cleanText(ogTitle) ?? this.cleanText(titleTag) ?? base.title;
    base.description = this.cleanText(ogDescription) ?? base.description;
    base.url = this.cleanText(ogUrl) ?? base.url;
    base.isRemote = this.detectRemote(base.title, null, null, base.description);
    return base;
  }

  /** Map a normalised OtysJob → JobPostDto. */
  private processJob(
    job: OtysJob,
    host: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = this.cleanText(job.title);
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = this.cleanText(job.url);
    if (!jobUrl) return null;

    const companyName = this.cleanText(job.companyName) ?? this.deriveCompanyName(host);
    const description = this.formatDescription(job.description ?? null, format);

    return new JobPostDto({
      id: `otys-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.OTYS,
      atsId,
      atsType: 'otys',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. JSON-LD descriptions are HTML;
   * HTML passes through, Markdown / Plain are converted.
   */
  private formatDescription(text: string | null, format?: DescriptionFormat): string | null {
    if (!text) return null;
    if (format === DescriptionFormat.HTML) return text;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(text) ?? text;
    return htmlToPlainText(text) ?? text;
  }

  /**
   * Scan every JSON-LD block for a `JobPosting` object (possibly nested in a
   * `@graph` array). Returns the first one found; malformed JSON is skipped.
   */
  private findJobPosting(html: string): OtysJobPostingLd | null {
    OTYS_JSONLD_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OTYS_JSONLD_REGEX.exec(html)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        continue; // non-JSON / malformed block — skip, never throw
      }
      const found = this.pickJobPosting(parsed);
      if (found) return found;
    }
    return null;
  }

  /** Recursively locate a `JobPosting` node within a parsed JSON-LD value. */
  private pickJobPosting(value: unknown): OtysJobPostingLd | null {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = this.pickJobPosting(entry);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (this.isJobPostingType(obj['@type'])) return obj as OtysJobPostingLd;
      if ('@graph' in obj) return this.pickJobPosting(obj['@graph']);
    }
    return null;
  }

  /** True when a JSON-LD `@type` (string or array) denotes a JobPosting. */
  private isJobPostingType(type: unknown): boolean {
    if (typeof type === 'string') return type.toLowerCase() === 'jobposting';
    if (Array.isArray(type)) return type.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
    return false;
  }

  /** First `jobLocation` entry (handles a single object or an array). */
  private firstAddress(
    location: OtysJobPostingLd['jobLocation'],
  ): OtysJobLocationLd['address'] | null {
    if (!location) return null;
    const entry = Array.isArray(location) ? location[0] : location;
    return entry?.address ?? null;
  }

  /** Resolve a schema.org `addressCountry` (string or `{ name }`) to a string. */
  private countryName(
    country: string | { name?: string | null } | null | undefined,
  ): string | null {
    if (typeof country === 'string') return country;
    if (country && typeof country === 'object') return country.name ?? null;
    return null;
  }

  /** First string from a `string | string[]` JSON-LD value. */
  private firstString(value: string | string[] | null | undefined): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const first = value.find((v) => typeof v === 'string');
      return typeof first === 'string' ? first : null;
    }
    return null;
  }

  /**
   * Resolve the tenant board host. A `companyUrl` (the recruitment-site / vacatures
   * URL) has its origin used verbatim. A `companySlug` that itself looks like a URL /
   * host is reduced to its origin; a bare client-prefix slug is expanded to the OTYS
   * application host `https://{slug}.otysapp.com`. Empty when neither yields a host.
   */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (/^https?:\/\//i.test(slug) || slug.includes('.')) {
        const origin = this.originFromUrl(slug);
        if (origin) return origin;
      }
      // Bare client prefix — expand to the OTYS application host.
      return OTYS_HOST_TEMPLATE.replace('{tenant}', slug.toLowerCase());
    }
    if (companyUrl) {
      const origin = this.originFromUrl(companyUrl);
      if (origin) return origin;
    }
    return '';
  }

  /**
   * Reduce a URL / host value to its `https://host` origin. Any host is accepted
   * (OTYS recruitment sites are customer-branded custom domains); the OTYS-controlled
   * domains are recognised but not required.
   */
  private originFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname || !hostname.includes('.')) return '';
      // OTYS-controlled hosts are recognised; custom customer domains pass through too.
      void OTYS_ROOT_DOMAIN;
      void OTYS_ALT_DOMAINS;
      return `https://${hostname}`;
    } catch {
      return '';
    }
  }

  /** Build an absolute URL from a tenant host + a parsed (possibly relative) path. */
  private absoluteUrl(host: string, path: string): string {
    try {
      return new URL(path, host.endsWith('/') ? host : `${host}/`).toString();
    } catch {
      return `${host}${path.startsWith('/') ? '' : '/'}${path}`;
    }
  }

  /** De-slugify + title-case a host's leading label into a display company name. */
  private deriveCompanyName(host: string): string {
    let label = host;
    try {
      label = new URL(host).hostname;
    } catch {
      // host already bare
    }
    label = label.replace(/^www\./i, '').split('.')[0] ?? label;
    return label.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Turn a URL title slug (e.g. `senior-accountmanager`) into a readable title. */
  private titleFromSlug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    if (!cleaned) return null;
    return cleaned.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: OtysJob): LocationDto | null {
    const city = this.cleanText(job.city);
    const state = this.cleanText(job.state);
    const country = this.cleanText(job.country);
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the title, location, job-location-type, or body text. */
  private detectRemote(
    title: string | null | undefined,
    location: string | null | undefined,
    jobLocationType: string | null | undefined,
    description: string | null | undefined,
  ): boolean {
    if (typeof jobLocationType === 'string' && /telecommute/i.test(jobLocationType)) return true;
    const haystacks: Array<string | null | undefined> = [title, location, description];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (OTYS_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Normalise a schema.org employment-type token (e.g. `FULL_TIME`, `PART_TIME`)
   * into a readable, title-cased label.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    return cleaned
      .replace(/[_]+/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Parse a date value into a YYYY-MM-DD string; relative / unparseable → null. */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    try {
      const parsed = new Date(cleaned);
      if (!isNaN(parsed.getTime())) return toDateOnly(cleaned);
    } catch {
      // ignore
    }
    return null;
  }

  /** Run a single-capture regex against HTML, returning the captured group or null. */
  private matchGroup(html: string, regex: RegExp): string | null {
    const m = regex.exec(html);
    return m ? this.cleanText(m[1]) : null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
