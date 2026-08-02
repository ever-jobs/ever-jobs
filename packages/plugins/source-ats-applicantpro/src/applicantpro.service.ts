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
  APPLICANTPRO_HOST_TEMPLATE,
  APPLICANTPRO_SITEMAP_PATH,
  APPLICANTPRO_JOB_URL_REGEX,
  APPLICANTPRO_SITEMAP_LOC_REGEX,
  APPLICANTPRO_LASTMOD_REGEX,
  APPLICANTPRO_JOB_INFO_REGEX,
  APPLICANTPRO_DOMAIN_TITLE_REGEX,
  APPLICANTPRO_OG_TITLE_REGEX,
  APPLICANTPRO_OG_URL_REGEX,
  APPLICANTPRO_OG_DESCRIPTION_REGEX,
  APPLICANTPRO_KEYWORDS_REGEX,
  APPLICANTPRO_TITLE_TAG_REGEX,
  APPLICANTPRO_POSTED_DATE_REGEX,
  APPLICANTPRO_DEFAULT_RESULTS,
  APPLICANTPRO_HEADERS,
} from './applicantpro.constants';
import { ApplicantProJob, ApplicantProJobInfo, ApplicantProSitemapEntry } from './applicantpro.types';

/**
 * ApplicantPro ATS careers scraper — generic, multi-tenant.
 *
 * ApplicantPro (applicantpro.com, US SMB ATS) hosts every customer's open roles
 * on a public job board at `https://{tenant}.applicantpro.com/jobs/`. That
 * listing page is client-rendered, so the adapter instead enumerates the
 * tenant's roles from the public XML sitemap
 * (`https://{tenant}.applicantpro.com/sitemap.xml`, which lists every open
 * `/jobs/{jobId}.html`) and parses each server-rendered detail page for its
 * structured metadata (`og:title`, `og:url`, `og:description`, `keywords`, and
 * the inline `JobDetail` mount object's company / posted-date / location /
 * employment-type fields).
 *
 * The caller addresses a tenant by `companySlug` (the board sub-domain label,
 * e.g. `pharrtx`) or by `companyUrl` (a board URL whose first sub-domain label
 * is the tenant). The sitemap lists every open role in one document — there is
 * no server-side pagination of the job set — so we fetch once and slice
 * client-side to honour `resultsWanted`. A single fetch error, an unknown
 * tenant (HTTP 4xx), or a malformed page degrades to an empty / partial result
 * rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.APPLICANTPRO,
  name: 'ApplicantPro',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ApplicantProService implements IScraper {
  private readonly logger = new Logger(ApplicantProService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for ApplicantPro scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve an ApplicantPro tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(APPLICANTPRO_HEADERS);

    const resultsWanted = input.resultsWanted ?? APPLICANTPRO_DEFAULT_RESULTS;
    const host = APPLICANTPRO_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching ApplicantPro sitemap for tenant: ${tenant}`);

      // The sitemap enumerates every open role for the tenant in one document.
      const entries = await this.fetchSitemap(client, host);
      if (entries.length === 0) {
        this.logger.log(`ApplicantPro tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Only fetch as many detail pages as the caller asked for (deduped first).
      const wanted = entries.filter((e) => !seen.has(e.jobId) && seen.add(e.jobId)).slice(0, resultsWanted);

      for (const entry of wanted) {
        try {
          const post = await this.processEntry(client, entry, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing ApplicantPro job ${entry.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`ApplicantPro total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`ApplicantPro scrape error for ${tenant}: ${err.message}`);
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
  ): Promise<ApplicantProSitemapEntry[]> {
    const url = `${host}${APPLICANTPRO_SITEMAP_PATH}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const xml = typeof response.data === 'string' ? response.data : '';
      return this.parseSitemap(xml);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`ApplicantPro sitemap not found (HTTP ${status}) at ${url}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Extract `/jobs/{jobId}.html` entries (with their `<lastmod>`) from the
   * sitemap XML. The bare `/jobs/` index and `/jobsandemployment/…` facet links
   * are not roles and are skipped by the job-URL regex.
   */
  private parseSitemap(xml: string): ApplicantProSitemapEntry[] {
    const entries: ApplicantProSitemapEntry[] = [];
    const seen = new Set<string>();

    // Walk each <loc> so we can also grab the sibling <lastmod> from its block.
    const locRegex = new RegExp(APPLICANTPRO_SITEMAP_LOC_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = locRegex.exec(xml)) !== null) {
      const loc = match[1];
      const jobMatch = /\/jobs\/(\d+)\.html/i.exec(loc);
      if (!jobMatch) continue;
      const jobId = jobMatch[1];
      if (seen.has(jobId)) continue;
      seen.add(jobId);

      // Look ahead a short window for the entry's <lastmod>.
      const window = xml.slice(match.index, match.index + 300);
      const lastmodMatch = APPLICANTPRO_LASTMOD_REGEX.exec(window);
      entries.push({
        jobId,
        url: loc,
        lastmod: lastmodMatch ? lastmodMatch[1] : null,
      });
    }

    // Fallback: if no <loc> blocks parsed, scrape job URLs directly.
    if (entries.length === 0) {
      const jobRegex = new RegExp(APPLICANTPRO_JOB_URL_REGEX.source, 'gi');
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
    entry: ApplicantProSitemapEntry,
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
        this.logger.warn(`ApplicantPro job ${entry.jobId} not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }

    const job = this.parseDetail(html, entry);
    return this.processJob(job, tenant, format);
  }

  /** Parse a detail page's HTML into a normalised ApplicantProJob. */
  private parseDetail(html: string, entry: ApplicantProSitemapEntry): ApplicantProJob {
    const ogTitle = this.firstGroup(html, APPLICANTPRO_OG_TITLE_REGEX);
    const titleTag = this.firstGroup(html, APPLICANTPRO_TITLE_TAG_REGEX);
    const keywords = this.firstGroup(html, APPLICANTPRO_KEYWORDS_REGEX);
    const ogDescription = this.firstGroup(html, APPLICANTPRO_OG_DESCRIPTION_REGEX);
    const canonicalUrl = this.firstGroup(html, APPLICANTPRO_OG_URL_REGEX);
    const company = this.firstGroup(html, APPLICANTPRO_DOMAIN_TITLE_REGEX);
    const jobInfo = this.parseJobInfo(html);

    // The og:title is "{title} - {city}, {state}"; prefer the leading title
    // segment, falling back to the keywords' first token, then the <title> tag.
    const keywordParts = this.splitKeywords(keywords);
    const title =
      this.leadingTitle(ogTitle) ?? keywordParts.title ?? this.leadingTitle(titleTag) ?? null;

    const loc = this.parseLocation(jobInfo, keywordParts);

    return {
      jobId: entry.jobId,
      url: entry.url,
      canonicalUrl: canonicalUrl ? this.decodeEntities(canonicalUrl) : null,
      title: title ? this.decodeEntities(title) : null,
      company: company ? this.decodeEntities(this.unescapeJs(company)) : null,
      companyName: company ? this.decodeEntities(this.unescapeJs(company)) : null,
      description: ogDescription ? this.decodeEntities(ogDescription) : null,
      descriptionHtml: null,
      city: loc.city,
      state: loc.state,
      country: loc.country,
      department: keywordParts.department,
      employmentType: this.cleanText(jobInfo?.mdiInbox),
      datePosted: this.parsePostedDate(jobInfo?.mdiCalendar) ?? this.parseDate(entry.lastmod),
      jobInfo,
    };
  }

  /** Parse the inline `jobInfo: { … }` JSON blob from the JobDetail mount. */
  private parseJobInfo(html: string): ApplicantProJobInfo | null {
    const raw = this.firstGroup(html, APPLICANTPRO_JOB_INFO_REGEX);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as ApplicantProJobInfo;
    } catch {
      // Malformed blob — fall through to null.
    }
    return null;
  }

  /** Map a normalised ApplicantProJob → JobPostDto. */
  private processJob(
    job: ApplicantProJob,
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
      id: `applicantpro-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.APPLICANTPRO,
      atsId,
      atsType: 'applicantpro',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: job.canonicalUrl || jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. ApplicantPro detail pages
   * surface the body as a plain-text `og:description` blob (and, when present,
   * an HTML body). We prefer HTML so markdown / plain conversion is consistent,
   * falling back to the plain-text body when HTML is absent.
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
   * Resolve the ApplicantPro tenant token from an explicit `companySlug` or from
   * a `companyUrl` (the first meaningful sub-domain label, else the trailing
   * path segment).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const host = u.host.split(':')[0];
        const labels = host.split('.').filter(Boolean);
        // A tenant board host is `{tenant}.applicantpro.com`: the first non-`www`
        // label is the tenant.
        const first = labels[0];
        if (first && first !== 'www') return first;
        if (labels[1]) return labels[1];
        // Fall back to a `/openings/{tenant}/…` path segment for canonical URLs.
        const segments = u.pathname.split('/').filter(Boolean);
        const openingsIdx = segments.indexOf('openings');
        if (openingsIdx >= 0 && segments[openingsIdx + 1]) return segments[openingsIdx + 1];
        if (segments.length > 0) return segments[segments.length - 1];
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
   * ApplicantPro encodes location both in the `keywords` meta
   * ("…, {city}, {state}, {country}, …") and in `jobInfo.mdiMapMarker`
   * ("{city}, {state}, {country}"). Prefer the structured keyword parts, then
   * the map-marker blob.
   */
  private extractLocation(job: ApplicantProJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the location text, title, or employment type. */
  private detectRemote(job: ApplicantProJob): boolean {
    const haystacks: Array<string | null | undefined> = [
      job.title,
      job.city,
      job.state,
      job.employmentType,
      job.jobInfo?.mdiMapMarker,
      job.description,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('work from home') ||
        v.includes('telecommute') ||
        v.includes('wfh')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Split the `keywords` meta ("{title}, {city}, {state}, {country}, {dept}")
   * into its parts. Tenants vary in how many segments they emit, so each part is
   * resolved positionally and defensively.
   */
  private splitKeywords(keywords: string | null): {
    title: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    department: string | null;
  } {
    const empty = { title: null, city: null, state: null, country: null, department: null };
    if (!keywords) return empty;
    const parts = keywords
      .split(',')
      .map((p) => this.decodeEntities(p.trim()))
      .filter((p) => p.length > 0);
    if (parts.length === 0) return empty;
    return {
      title: parts[0] ?? null,
      city: parts[1] ?? null,
      state: parts[2] ?? null,
      country: parts[3] ?? null,
      department: parts.length > 4 ? parts[parts.length - 1] : null,
    };
  }

  /**
   * Resolve location from the `jobInfo.mdiMapMarker` blob ("City, State,
   * Country") when present, else from the parsed keyword parts.
   */
  private parseLocation(
    jobInfo: ApplicantProJobInfo | null,
    keywordParts: { city: string | null; state: string | null; country: string | null },
  ): { city: string | null; state: string | null; country: string | null } {
    const marker = this.cleanText(jobInfo?.mdiMapMarker);
    if (marker) {
      const parts = marker.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 1) {
        return {
          city: parts[0] ?? keywordParts.city,
          state: parts[1] ?? keywordParts.state,
          country: parts[2] ?? keywordParts.country,
        };
      }
    }
    return { city: keywordParts.city, state: keywordParts.state, country: keywordParts.country };
  }

  /** Return the leading "{title}" segment of an "{title} - {city}, {state}" string. */
  private leadingTitle(value: string | null): string | null {
    if (!value) return null;
    const cleaned = value.trim();
    if (!cleaned) return null;
    // og:title / <title> use " - " between the role and the location/company.
    const idx = cleaned.indexOf(' - ');
    const head = idx > 0 ? cleaned.slice(0, idx) : cleaned;
    return head.trim() || null;
  }

  /** Parse a "Posted 06-Feb-2019 (EST)" string into a YYYY-MM-DD string. */
  private parsePostedDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const match = APPLICANTPRO_POSTED_DATE_REGEX.exec(value);
    if (!match) return null;
    return this.parseDate(match[1]);
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

  /** Unescape common JS string escapes (e.g. `\"`, `\/`) from a captured blob. */
  private unescapeJs(value: string): string {
    return value.replace(/\\(["'/\\])/g, '$1');
  }

  /** Decode the handful of HTML entities that appear in meta-tag content. */
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
