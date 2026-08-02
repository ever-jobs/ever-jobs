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
  EXACTHIRE_HOST_TEMPLATE,
  EXACTHIRE_ROOT_DOMAIN,
  EXACTHIRE_SITEMAP_PATH,
  EXACTHIRE_JOB_URL_REGEX,
  EXACTHIRE_JOB_ID_REGEX,
  EXACTHIRE_SITEMAP_LOC_REGEX,
  EXACTHIRE_LASTMOD_REGEX,
  EXACTHIRE_JSON_LD_REGEX,
  EXACTHIRE_OG_TITLE_REGEX,
  EXACTHIRE_OG_URL_REGEX,
  EXACTHIRE_OG_DESCRIPTION_REGEX,
  EXACTHIRE_KEYWORDS_REGEX,
  EXACTHIRE_TITLE_TAG_REGEX,
  EXACTHIRE_REMOTE_REGEX,
  EXACTHIRE_DEFAULT_RESULTS,
  EXACTHIRE_HEADERS,
} from './exacthire.constants';
import { ExactHireJob, ExactHireJsonLd, ExactHirePostalAddress, ExactHireSitemapEntry } from './exacthire.types';

/**
 * ExactHire (HireCentric) ATS careers scraper — generic, multi-tenant.
 *
 * ExactHire (exacthire.com, US SMB ATS) hosts every customer's open roles under
 * its HireCentric product on a public board at
 * `https://{tenant}.hirecentric.com/jobsearch/`. The adapter enumerates the
 * tenant's roles from the public XML sitemap
 * (`https://{tenant}.hirecentric.com/sitemap.xml`, which lists every open
 * `/jobs/{jobId}.html`) and parses each server-rendered detail page for its
 * structured metadata: a schema.org JobPosting `application/ld+json` block when
 * present, otherwise the `og:title` / `og:description` / `keywords` meta tags
 * and the cross-tenant `<title>` pattern
 * "{title} - {city}, {state} - {company} Jobs".
 *
 * The caller addresses a tenant by `companySlug` (the board sub-domain label,
 * e.g. `aflcio`) or by `companyUrl` (a board URL whose first sub-domain label is
 * the tenant). The sitemap lists every open role in one document — there is no
 * server-side pagination of the job set — so we fetch once and slice
 * client-side to honour `resultsWanted`. A single fetch error, an unknown
 * tenant (HTTP 4xx), or a malformed page degrades to an empty / partial result
 * rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.EXACTHIRE,
  name: 'ExactHire',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ExactHireService implements IScraper {
  private readonly logger = new Logger(ExactHireService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for ExactHire scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve an ExactHire tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(EXACTHIRE_HEADERS);

    const resultsWanted = input.resultsWanted ?? EXACTHIRE_DEFAULT_RESULTS;
    const host = EXACTHIRE_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching ExactHire sitemap for tenant: ${tenant}`);

      // The sitemap enumerates every open role for the tenant in one document.
      const entries = await this.fetchSitemap(client, host);
      if (entries.length === 0) {
        this.logger.log(`ExactHire tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Only fetch as many detail pages as the caller asked for (deduped first).
      const wanted = entries.filter((e) => !seen.has(e.jobId) && seen.add(e.jobId)).slice(0, resultsWanted);

      for (const entry of wanted) {
        try {
          const post = await this.processEntry(client, entry, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing ExactHire job ${entry.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`ExactHire total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`ExactHire scrape error for ${tenant}: ${err.message}`);
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
  ): Promise<ExactHireSitemapEntry[]> {
    const url = `${host}${EXACTHIRE_SITEMAP_PATH}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const xml = typeof response.data === 'string' ? response.data : '';
      return this.parseSitemap(xml);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`ExactHire sitemap not found (HTTP ${status}) at ${url}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Extract `/jobs/{jobId}.html` entries (with their `<lastmod>`) from the
   * sitemap XML. The bare `/jobsearch/` listing and `/account/` links are not
   * roles and are skipped by the job-URL regex.
   */
  private parseSitemap(xml: string): ExactHireSitemapEntry[] {
    const entries: ExactHireSitemapEntry[] = [];
    const seen = new Set<string>();

    // Walk each <loc> so we can also grab the sibling <lastmod> from its block.
    const locRegex = new RegExp(EXACTHIRE_SITEMAP_LOC_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = locRegex.exec(xml)) !== null) {
      const loc = match[1];
      const jobMatch = EXACTHIRE_JOB_ID_REGEX.exec(loc);
      if (!jobMatch) continue;
      const jobId = jobMatch[1];
      if (seen.has(jobId)) continue;
      seen.add(jobId);

      // Look ahead a short window for the entry's <lastmod>.
      const window = xml.slice(match.index, match.index + 300);
      const lastmodMatch = EXACTHIRE_LASTMOD_REGEX.exec(window);
      entries.push({
        jobId,
        url: loc,
        lastmod: lastmodMatch ? lastmodMatch[1] : null,
      });
    }

    // Fallback: if no <loc> blocks parsed, scrape job URLs directly.
    if (entries.length === 0) {
      const jobRegex = new RegExp(EXACTHIRE_JOB_URL_REGEX.source, 'gi');
      let jm: RegExpExecArray | null;
      while ((jm = jobRegex.exec(xml)) !== null) {
        const jobId = jm[1];
        if (seen.has(jobId)) continue;
        seen.add(jobId);
        entries.push({ jobId, url: jm[0], lastmod: null });
      }
    }

    return entries;
  }

  /** Fetch + parse a single detail page, then map it to a JobPostDto. */
  private async processEntry(
    client: ReturnType<typeof createHttpClient>,
    entry: ExactHireSitemapEntry,
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
        this.logger.warn(`ExactHire job ${entry.jobId} not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }

    const job = this.parseDetail(html, entry);
    return this.processJob(job, tenant, format);
  }

  /**
   * Parse a detail page's HTML into a normalised ExactHireJob. Prefers the
   * schema.org JobPosting JSON-LD block when present, falling back to the
   * `og:` meta tags and the cross-tenant `<title>` pattern
   * "{title} - {city}, {state} - {company} Jobs".
   */
  private parseDetail(html: string, entry: ExactHireSitemapEntry): ExactHireJob {
    const jsonLd = this.parseJsonLd(html);

    const ogTitle = this.firstGroup(html, EXACTHIRE_OG_TITLE_REGEX);
    const titleTag = this.firstGroup(html, EXACTHIRE_TITLE_TAG_REGEX);
    const keywords = this.firstGroup(html, EXACTHIRE_KEYWORDS_REGEX);
    const ogDescription = this.firstGroup(html, EXACTHIRE_OG_DESCRIPTION_REGEX);
    const canonicalUrl = this.firstGroup(html, EXACTHIRE_OG_URL_REGEX);

    // The <title>/og:title use " - " between the role, location and company:
    // "{title} - {city}, {state} - {company} Jobs".
    const titleParts = this.splitTitle(ogTitle ?? titleTag);

    const jsonLdAddr = this.jsonLdAddress(jsonLd);
    const title = this.cleanText(jsonLd?.title ?? null) ?? titleParts.title;
    const company = this.jsonLdCompany(jsonLd) ?? titleParts.company;
    const description = this.cleanText(jsonLd?.description ?? null) ?? (ogDescription ? this.decodeEntities(ogDescription) : null);

    return {
      jobId: entry.jobId,
      url: entry.url,
      canonicalUrl: canonicalUrl ? this.decodeEntities(canonicalUrl) : null,
      title: title ? this.decodeEntities(title) : null,
      company: company ? this.decodeEntities(company) : null,
      companyName: company ? this.decodeEntities(company) : null,
      description: description ?? null,
      descriptionHtml: jsonLd && typeof jsonLd.description === 'string' && /<[a-z]/i.test(jsonLd.description) ? jsonLd.description : null,
      city: jsonLdAddr.city ?? titleParts.city,
      state: jsonLdAddr.state ?? titleParts.state,
      country: jsonLdAddr.country,
      department: this.deriveDepartment(keywords),
      employmentType: this.jsonLdEmploymentType(jsonLd),
      datePosted: this.parseDate(jsonLd?.datePosted) ?? this.parseDate(entry.lastmod),
    };
  }

  /**
   * Find and parse the schema.org JobPosting JSON-LD block, when present.
   * A page may carry several JSON-LD blocks (BreadcrumbList, Organization, …);
   * we return the first one whose `@type` is "JobPosting".
   */
  private parseJsonLd(html: string): ExactHireJsonLd | null {
    const regex = new RegExp(EXACTHIRE_JSON_LD_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      const raw = (match[1] ?? '').trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const candidate = this.findJobPosting(parsed);
        if (candidate) return candidate;
      } catch {
        // Malformed JSON-LD block — try the next one.
      }
    }
    return null;
  }

  /** Recursively locate a JobPosting node inside a parsed JSON-LD value. */
  private findJobPosting(value: any): ExactHireJsonLd | null {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findJobPosting(item);
        if (found) return found;
      }
      return null;
    }
    if (this.isJobPostingType(value['@type'])) return value as ExactHireJsonLd;
    // Some pages wrap nodes under `@graph`.
    if (Array.isArray(value['@graph'])) {
      return this.findJobPosting(value['@graph']);
    }
    return null;
  }

  private isJobPostingType(type: unknown): boolean {
    if (typeof type === 'string') return type.toLowerCase() === 'jobposting';
    if (Array.isArray(type)) return type.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
    return false;
  }

  /** Map a normalised ExactHireJob → JobPostDto. */
  private processJob(
    job: ExactHireJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url || job.canonicalUrl;
    if (!jobUrl) return null;

    const companyName = this.deriveCompanyName(job.company ?? job.companyName, tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, job.description ?? null, format);

    return new JobPostDto({
      id: `exacthire-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.EXACTHIRE,
      atsId,
      atsType: 'exacthire',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: job.canonicalUrl || jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. ExactHire detail pages
   * surface the body either as HTML inside the JSON-LD `description` or as a
   * plain-text `og:description` blob. We prefer HTML so markdown / plain
   * conversion is consistent, falling back to the plain-text body when HTML is
   * absent.
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
   * Resolve the ExactHire tenant token from an explicit `companySlug` or from a
   * `companyUrl` (the first meaningful sub-domain label of a `hirecentric.com`
   * host, else the leading host label).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim().toLowerCase();
      // A caller may also pass a bare host (e.g. "aflcio.hirecentric.com").
      if (slug.includes(EXACTHIRE_ROOT_DOMAIN)) {
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
        const host = u.host.split(':')[0];
        const labels = host.split('.').filter(Boolean);
        // A tenant board host is `{tenant}.hirecentric.com`: the first non-`www`
        // label is the tenant.
        const first = labels[0];
        if (first && first !== 'www') return first;
        if (labels[1]) return labels[1];
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : tenant) || tenant;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Build the structured location from the parsed JSON-LD address and/or the
   * `<title>` "…- {city}, {state} -…" segment, leaving it null when nothing
   * usable is present.
   */
  private extractLocation(job: ExactHireJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the location text, title, or employment type. */
  private detectRemote(job: ExactHireJob): boolean {
    const haystacks: Array<string | null | undefined> = [
      job.title,
      job.city,
      job.state,
      job.employmentType,
      job.description,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (EXACTHIRE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Split the `<title>` / `og:title` ("{title} - {city}, {state} - {company} Jobs")
   * into its parts. Tenants vary in how many segments they emit, so each part is
   * resolved positionally and defensively. The trailing " Jobs" suffix on the
   * company segment is stripped.
   */
  private splitTitle(value: string | null): {
    title: string | null;
    city: string | null;
    state: string | null;
    company: string | null;
  } {
    const empty = { title: null, city: null, state: null, company: null };
    if (!value) return empty;
    const cleaned = this.decodeEntities(value.trim());
    if (!cleaned) return empty;
    const parts = cleaned.split(' - ').map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length === 0) return empty;

    const title = parts[0] ?? null;
    // The company is the last segment, with a trailing " Jobs" label removed.
    let company: string | null = null;
    if (parts.length >= 2) {
      company = parts[parts.length - 1].replace(/\s+Jobs\s*$/i, '').trim() || null;
    }
    // The location, when present, is the middle "{city}, {state}" segment.
    let city: string | null = null;
    let state: string | null = null;
    if (parts.length >= 3) {
      const loc = parts[parts.length - 2];
      const locParts = loc.split(',').map((p) => p.trim()).filter(Boolean);
      city = locParts[0] ?? null;
      state = locParts[1] ?? null;
    }
    return { title, city, state, company };
  }

  /**
   * The `keywords` meta sometimes carries a trailing department / category
   * token. We surface the last non-location-looking keyword as the department
   * when more than the role + location tokens are present.
   */
  private deriveDepartment(keywords: string | null): string | null {
    if (!keywords) return null;
    const parts = keywords
      .split(',')
      .map((p) => this.decodeEntities(p.trim()))
      .filter((p) => p.length > 0);
    // "{title}, {city}, {state}, {country}, {department}" — a department, when
    // present, is the trailing segment beyond the location tuple.
    return parts.length > 4 ? parts[parts.length - 1] : null;
  }

  /** Resolve the company display name from the JSON-LD `hiringOrganization`. */
  private jsonLdCompany(jsonLd: ExactHireJsonLd | null): string | null {
    if (!jsonLd) return null;
    const org = jsonLd.hiringOrganization;
    if (typeof org === 'string') return this.cleanText(org);
    if (org && typeof org === 'object') return this.cleanText(org.name ?? null);
    return null;
  }

  /** Resolve a single employment-type label from the JSON-LD `employmentType`. */
  private jsonLdEmploymentType(jsonLd: ExactHireJsonLd | null): string | null {
    if (!jsonLd) return null;
    const value = jsonLd.employmentType;
    if (typeof value === 'string') return this.normaliseEmploymentType(value);
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
      return this.normaliseEmploymentType(value[0]);
    }
    return null;
  }

  /** Map a schema.org employment-type token (e.g. "FULL_TIME") to a label. */
  private normaliseEmploymentType(value: string): string | null {
    const v = this.cleanText(value);
    if (!v) return null;
    return v
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Resolve the structured location parts from the JSON-LD `jobLocation`. */
  private jsonLdAddress(jsonLd: ExactHireJsonLd | null): {
    city: string | null;
    state: string | null;
    country: string | null;
  } {
    const empty = { city: null, state: null, country: null };
    if (!jsonLd) return empty;
    const loc = jsonLd.jobLocation;
    const node = Array.isArray(loc) ? loc[0] : loc;
    const addr: ExactHirePostalAddress | null | undefined = node?.address;
    if (!addr || typeof addr !== 'object') return empty;
    let country: string | null = null;
    if (typeof addr.addressCountry === 'string') country = this.cleanText(addr.addressCountry);
    else if (addr.addressCountry && typeof addr.addressCountry === 'object') {
      country = this.cleanText(addr.addressCountry.name ?? null);
    }
    return {
      city: this.cleanText(addr.addressLocality ?? null),
      state: this.cleanText(addr.addressRegion ?? null),
      country,
    };
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

  /** Decode the handful of HTML entities that appear in meta-tag / title content. */
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
