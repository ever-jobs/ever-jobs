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
  PAYCHEX_HOST_TEMPLATE,
  PAYCHEX_ROOT_DOMAIN,
  PAYCHEX_ALT_DOMAINS,
  PAYCHEX_SITEMAP_PATH,
  PAYCHEX_SITEMAP_LOC_REGEX,
  PAYCHEX_LASTMOD_REGEX,
  PAYCHEX_JOB_URL_REGEX,
  PAYCHEX_JSONLD_REGEX,
  PAYCHEX_OG_TITLE_REGEX,
  PAYCHEX_OG_URL_REGEX,
  PAYCHEX_OG_DESCRIPTION_REGEX,
  PAYCHEX_TITLE_TAG_REGEX,
  PAYCHEX_REMOTE_REGEX,
  PAYCHEX_DEFAULT_RESULTS,
  PAYCHEX_HEADERS,
} from './paychex.constants';
import {
  PaychexJob,
  PaychexJobPosting,
  PaychexJobLocation,
  PaychexPostalAddress,
  PaychexSitemapEntry,
} from './paychex.types';

/**
 * Paychex Flex Hiring ATS careers scraper — generic, multi-tenant.
 *
 * Paychex (paychex.com, US payroll / HR vendor) powers each customer's
 * candidate-facing careers site through its "Flex Hiring" recruiting product at
 * `https://{tenant}.applybypaychex.com/` (some tenants also front it under a
 * Paychex Apply host such as `careers.paychex.com`). The careers index is a
 * client-rendered app, so the adapter instead enumerates the tenant's roles from
 * the public XML sitemap (`/sitemap.xml`, which lists every open
 * `/job/{jobId}/{slug}` page) and parses each server-rendered detail page's
 * schema.org `JobPosting` JSON-LD block (with `og:` meta tags as defensive
 * fallbacks).
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain / board label,
 * e.g. `acme`) or by `companyUrl` (a careers URL whose first sub-domain label is
 * the tenant, or a Paychex Apply host used verbatim). The sitemap lists every
 * open role in one document — there is no server-side pagination of the job set —
 * so we fetch once and slice client-side to honour `resultsWanted`. A single
 * fetch error, an unknown tenant (HTTP 4xx), or a malformed page degrades to an
 * empty / partial result rather than throwing, so a single tenant never nukes a
 * batch run.
 */
@SourcePlugin({
  site: Site.PAYCHEX,
  name: 'Paychex',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PaychexService implements IScraper {
  private readonly logger = new Logger(PaychexService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Paychex scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve a Paychex careers host from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(PAYCHEX_HEADERS);

    const resultsWanted = input.resultsWanted ?? PAYCHEX_DEFAULT_RESULTS;
    const tenant = this.deriveTenant(companySlug, host);
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Paychex sitemap from: ${host}`);

      // The sitemap enumerates every open role for the tenant in one document.
      const entries = await this.fetchSitemap(client, host);
      if (entries.length === 0) {
        this.logger.log(`Paychex tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Only fetch as many detail pages as the caller asked for (deduped first).
      const wanted = entries
        .filter((e) => !seen.has(e.jobId) && seen.add(e.jobId))
        .slice(0, resultsWanted);

      for (const entry of wanted) {
        try {
          const post = await this.processEntry(client, entry, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Paychex job ${entry.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`Paychex total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Paychex scrape error for ${host}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Fetch and parse the tenant sitemap into open-role entries. An unknown
   * sub-domain (HTTP 4xx) or a missing sitemap degrades to an empty list.
   */
  private async fetchSitemap(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<PaychexSitemapEntry[]> {
    const url = `${host}${PAYCHEX_SITEMAP_PATH}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const xml = typeof response.data === 'string' ? response.data : '';
      return this.parseSitemap(xml);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Paychex sitemap not found (HTTP ${status}) at ${url}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Extract `/job/{jobId}[/{slug}]` entries (with their `<lastmod>`) from the
   * sitemap XML. The bare `/job/` index and other site pages (about, privacy,
   * departments) carry no id and are skipped by the job-URL regex.
   */
  private parseSitemap(xml: string): PaychexSitemapEntry[] {
    const entries: PaychexSitemapEntry[] = [];
    const seen = new Set<string>();

    // Walk each <loc> so we can also grab the sibling <lastmod> from its block.
    const locRegex = new RegExp(PAYCHEX_SITEMAP_LOC_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = locRegex.exec(xml)) !== null) {
      const loc = match[1];
      const jobMatch = PAYCHEX_JOB_URL_REGEX.exec(loc);
      if (!jobMatch) continue;
      const jobId = jobMatch[1];
      if (seen.has(jobId)) continue;
      seen.add(jobId);

      // Look ahead a short window for the entry's <lastmod>.
      const window = xml.slice(match.index, match.index + 300);
      const lastmodMatch = PAYCHEX_LASTMOD_REGEX.exec(window);
      entries.push({
        jobId,
        url: loc,
        lastmod: lastmodMatch ? lastmodMatch[1] : null,
      });
    }

    return entries;
  }

  /** Fetch + parse a single detail page, then map it to a JobPostDto. */
  private async processEntry(
    client: ReturnType<typeof createHttpClient>,
    entry: PaychexSitemapEntry,
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
        this.logger.warn(`Paychex job ${entry.jobId} not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }

    const job = this.parseDetail(html, entry);
    return this.processJob(job, tenant, format);
  }

  /** Parse a detail page's HTML (JSON-LD JobPosting + og: fallbacks) into a PaychexJob. */
  private parseDetail(html: string, entry: PaychexSitemapEntry): PaychexJob {
    const posting = this.findJobPosting(html);

    const ogTitle = this.firstGroup(html, PAYCHEX_OG_TITLE_REGEX);
    const titleTag = this.firstGroup(html, PAYCHEX_TITLE_TAG_REGEX);
    const ogDescription = this.firstGroup(html, PAYCHEX_OG_DESCRIPTION_REGEX);
    const ogUrl = this.firstGroup(html, PAYCHEX_OG_URL_REGEX);

    const title =
      this.cleanText(posting?.title) ??
      this.leadingTitle(ogTitle) ??
      this.leadingTitle(titleTag);

    const address = this.firstAddress(posting?.jobLocation);
    const companyName = this.organizationName(posting?.hiringOrganization);

    const descriptionHtml = this.cleanText(posting?.description);

    return {
      jobId: entry.jobId,
      url: entry.url,
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
      datePosted: this.parseDate(posting?.datePosted) ?? this.parseDate(entry.lastmod),
      isRemote: this.detectRemote(posting, title, address),
    };
  }

  /**
   * Scan every `application/ld+json` block for a `JobPosting` object. Each block
   * may be a single object, an array of objects, or a `@graph` envelope; we
   * narrow defensively and return the first `JobPosting` found.
   */
  private findJobPosting(html: string): PaychexJobPosting | null {
    const re = new RegExp(PAYCHEX_JSONLD_REGEX.source, 'gi');
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
  private extractPosting(value: unknown): PaychexJobPosting | null {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.extractPosting(item);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (this.isJobPostingType(obj['@type'])) return obj as PaychexJobPosting;
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

  /** Map a normalised PaychexJob → JobPostDto. */
  private processJob(
    job: PaychexJob,
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
      id: `paychex-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description),
      site: Site.PAYCHEX,
      atsId,
      atsType: 'paychex',
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
   * Resolve the tenant careers host. An explicit `companySlug` is expanded into
   * the canonical `{tenant}.applybypaychex.com` host; a `companyUrl` on the
   * `applybypaychex.com` domain (or on a known Paychex Apply host) has its origin
   * used verbatim. Returns an empty string when neither yields a host.
   */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.toLowerCase();
        if (
          hostname.endsWith(PAYCHEX_ROOT_DOMAIN) ||
          PAYCHEX_ALT_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))
        ) {
          return `${u.protocol}//${u.host}`;
        }
      } catch {
        // Malformed URL — fall through to the slug.
      }
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim().toLowerCase();
      // A caller may also pass a bare host (e.g. "acme.applybypaychex.com").
      if (slug.includes(PAYCHEX_ROOT_DOMAIN) || PAYCHEX_ALT_DOMAINS.some((d) => slug.includes(d))) {
        const host = slug.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        return `https://${host}`;
      }
      return PAYCHEX_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(slug));
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

  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : tenant) || tenant;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the JSON-LD `jobLocation.address` parts (locality / region / country)
   * as a LocationDto, leaving location null when nothing usable is present.
   */
  private extractLocation(job: PaychexJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from `jobLocationType`, the title, or the location text. */
  private detectRemote(
    posting: PaychexJobPosting | null,
    title: string | null,
    address: PaychexPostalAddress | null,
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
      if (PAYCHEX_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Return the first `PostalAddress` from a `jobLocation` (object or array). */
  private firstAddress(
    jobLocation: PaychexJobLocation | PaychexJobLocation[] | null | undefined,
  ): PaychexPostalAddress | null {
    if (!jobLocation) return null;
    const first = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
    const address = first?.address;
    return address && typeof address === 'object' ? address : null;
  }

  /** Resolve the hiring-organisation display name (object `name` or bare string). */
  private organizationName(
    org: PaychexJobPosting['hiringOrganization'],
  ): string | null {
    if (!org) return null;
    if (typeof org === 'string') return this.cleanText(org);
    return this.cleanText(org.name);
  }

  /** Resolve the country display value (a bare code/name, or an object with `name`). */
  private countryName(country: PaychexPostalAddress['addressCountry']): string | null {
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
