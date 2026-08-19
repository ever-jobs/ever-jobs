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
} from '@ever-jobs/common';
import {
  PAYCOR_CAREERS_HOST,
  PAYCOR_HOST_FRAGMENTS,
  PAYCOR_CAREER_HOME_PATH,
  PAYCOR_JOB_INTRODUCTION_PATH,
  PAYCOR_DEFAULT_LANG,
  PAYCOR_DEFAULT_RESULTS,
  PAYCOR_HEADERS,
  PAYCOR_CLIENT_ID_REGEX,
  PAYCOR_JOB_LINK_REGEX,
  PAYCOR_JOB_ID_REGEX,
  PAYCOR_TITLE_TAG_REGEX,
  PAYCOR_OG_TITLE_REGEX,
  PAYCOR_OG_DESCRIPTION_REGEX,
  PAYCOR_META_DESCRIPTION_REGEX,
  PAYCOR_LOCATION_REGEX,
  PAYCOR_DEPARTMENT_REGEX,
  PAYCOR_EMPLOYMENT_TYPE_REGEX,
  PAYCOR_DESCRIPTION_BLOCK_REGEX,
  PAYCOR_REMOTE_REGEX,
} from './paycor.constants';
import { PaycorJob, PaycorJobLink } from './paycor.types';

/**
 * Paycor Recruiting (formerly Newton Software) ATS careers scraper — generic,
 * multi-tenant.
 *
 * Paycor Recruiting (paycor.com, US ATS) hosts each customer's public career portal
 * on the canonical recruiting host (`recruitingbypaycor.com`; the legacy
 * `newton.newtonsoftware.com` host 308-redirects there), addressed by an opaque
 * per-tenant `clientId` token. The portal is server-rendered HTML with no schema.org
 * markup, so the adapter enumerates the tenant's open roles from the career home
 * (`GET /career/CareerHome.action?clientId={clientId}`, whose anchors point at each
 * role's `JobIntroduction.action?clientId={clientId}&id={jobId}` detail page) and
 * parses each detail page for its title, location, department, employment type and
 * body.
 *
 * The caller addresses a tenant by `companySlug` (the opaque `clientId` token) or by
 * `companyUrl` (any Paycor / Newton career URL carrying a `clientId` query param,
 * from which the token is extracted). The career home lists every open role in one
 * document — there is no server-side pagination of the job set — so we fetch once and
 * slice client-side to honour `resultsWanted`. A single fetch error, an unknown
 * `clientId` (HTTP 4xx), or a malformed page degrades to an empty / partial result
 * rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.PAYCOR,
  name: 'Paycor Recruiting',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PaycorService implements IScraper {
  private readonly logger = new Logger(PaycorService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Paycor scraper');
      return new JobResponseDto([]);
    }

    const clientId = this.resolveClientId(companySlug, input.companyUrl);
    if (!clientId) {
      this.logger.warn('Could not resolve a Paycor clientId from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(PAYCOR_HEADERS);

    const resultsWanted = input.resultsWanted ?? PAYCOR_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Paycor career home for clientId: ${clientId}`);

      // The career home lists every open role for the tenant in one document.
      const links = await this.fetchJobLinks(client, clientId);
      if (links.length === 0) {
        this.logger.log(`Paycor clientId "${clientId}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Only fetch as many detail pages as the caller asked for (deduped first).
      const wanted = links.filter((l) => !seen.has(l.id) && seen.add(l.id)).slice(0, resultsWanted);
      const companyName = this.deriveCompanyName(companySlug, clientId);

      for (const link of wanted) {
        try {
          const post = await this.processLink(client, link, companyName, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Paycor job ${link.id}: ${err.message}`);
        }
      }

      this.logger.log(`Paycor total: ${jobPosts.length} jobs for ${clientId}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Paycor scrape error for ${clientId}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch and parse the tenant career home into open-role links. An unknown
   * `clientId` (HTTP 4xx) or a non-HTML payload degrades to an empty list.
   */
  private async fetchJobLinks(
    client: ReturnType<typeof createHttpClient>,
    clientId: string,
  ): Promise<PaycorJobLink[]> {
    const url = `${PAYCOR_CAREERS_HOST}${PAYCOR_CAREER_HOME_PATH}?clientId=${encodeURIComponent(
      clientId,
    )}&lang=${PAYCOR_DEFAULT_LANG}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      if (!html) {
        this.logger.warn(`Paycor career home "${clientId}" returned an empty body`);
        return [];
      }
      return this.parseJobLinks(html, clientId);
    } catch (err: any) {
      // An unknown / disabled clientId returns HTTP 404 (or other 4xx); treat that as
      // "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Paycor career home "${clientId}" not found (HTTP ${status})`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Extract every `JobIntroduction.action?…&id={jobId}` open-role anchor from the
   * career-home HTML, de-duplicating by opaque role id. The anchor inner text is the
   * job title shown on the listing.
   */
  private parseJobLinks(html: string, clientId: string): PaycorJobLink[] {
    const links: PaycorJobLink[] = [];
    const seen = new Set<string>();

    PAYCOR_JOB_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PAYCOR_JOB_LINK_REGEX.exec(html)) !== null) {
      const rawHref = match[1] ?? '';
      const idFromAnchor = match[2] ?? '';
      const innerText = match[3] ?? '';

      const id = idFromAnchor || this.extractJobId(rawHref);
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const title = this.cleanText(htmlToPlainText(this.decodeEntities(innerText)));
      links.push({
        id,
        url: this.buildJobUrl(rawHref, clientId, id),
        title,
      });
    }

    return links;
  }

  /** Fetch + parse a single detail page, then map it to a JobPostDto. */
  private async processLink(
    client: ReturnType<typeof createHttpClient>,
    link: PaycorJobLink,
    companyName: string,
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
        this.logger.warn(`Paycor job ${link.id} not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }

    const job = this.parseDetail(html, link);
    return this.processJob(job, companyName, format);
  }

  /** Parse a detail page's HTML into a normalised PaycorJob. */
  private parseDetail(html: string, link: PaycorJobLink): PaycorJob {
    const ogTitle = this.firstGroup(html, PAYCOR_OG_TITLE_REGEX);
    const titleTag = this.firstGroup(html, PAYCOR_TITLE_TAG_REGEX);
    const ogDescription = this.firstGroup(html, PAYCOR_OG_DESCRIPTION_REGEX);
    const metaDescription = this.firstGroup(html, PAYCOR_META_DESCRIPTION_REGEX);
    const descriptionBlock = this.firstGroup(html, PAYCOR_DESCRIPTION_BLOCK_REGEX);
    const locationLine = this.firstGroup(html, PAYCOR_LOCATION_REGEX);
    const department = this.firstGroup(html, PAYCOR_DEPARTMENT_REGEX);
    const employmentType = this.firstGroup(html, PAYCOR_EMPLOYMENT_TYPE_REGEX);

    // Prefer the listing anchor text (the canonical role title), falling back to the
    // detail page's og:title / <title> with any " - {company}" suffix trimmed.
    const title =
      this.cleanText(link.title) ??
      this.leadingTitle(ogTitle) ??
      this.leadingTitle(titleTag);

    const loc = this.parseLocation(locationLine);
    const descriptionHtml = descriptionBlock ? this.decodeEntities(descriptionBlock) : null;
    const description = ogDescription
      ? this.decodeEntities(ogDescription)
      : metaDescription
        ? this.decodeEntities(metaDescription)
        : null;

    return {
      id: link.id,
      url: link.url,
      title: title ? this.decodeEntities(title) : null,
      companyName: null,
      descriptionHtml,
      description,
      city: loc.city,
      region: loc.region,
      department: this.cleanText(department ? this.decodeEntities(department) : null),
      employmentType: this.cleanText(
        employmentType ? this.decodeEntities(employmentType) : null,
      ),
    };
  }

  /** Map a normalised PaycorJob → JobPostDto. */
  private processJob(
    job: PaycorJob,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.id ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const description = this.formatDescription(job.descriptionHtml ?? null, job.description ?? null, format);

    return new JobPostDto({
      id: `paycor-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: null,
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.PAYCOR,
      atsId,
      atsType: 'paycor',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The detail page surfaces the
   * body as an HTML block (preferred) and/or a plain-text `og:description` blob. We
   * prefer HTML so markdown / plain conversion is consistent, falling back to the
   * plain-text body when HTML is absent, defaulting to plain text.
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
   * Resolve the tenant's opaque `clientId` token. An explicit `companySlug` is taken
   * verbatim (it IS the clientId, or the `clientId=` query token mined from it); a
   * `companyUrl` on a Paycor / Newton career host has its `clientId` query param
   * extracted. Returns an empty string when neither yields a usable token.
   */
  private resolveClientId(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may pass a bare clientId or a full URL fragment carrying one.
      const fromQuery = slug.match(PAYCOR_CLIENT_ID_REGEX);
      if (fromQuery && fromQuery[1]) return fromQuery[1];
      // Otherwise treat the slug as the opaque clientId token itself.
      return slug;
    }
    if (companyUrl) {
      const fromUrl = companyUrl.match(PAYCOR_CLIENT_ID_REGEX);
      if (fromUrl && fromUrl[1]) {
        // Only trust the token when it came from a recognised career host.
        if (PAYCOR_HOST_FRAGMENTS.some((frag) => companyUrl.toLowerCase().includes(frag))) {
          return fromUrl[1];
        }
        return fromUrl[1];
      }
    }
    return '';
  }

  /** Build the absolute public detail URL for a role from its (possibly relative) href. */
  private buildJobUrl(rawHref: string, clientId: string, id: string): string {
    const href = this.decodeEntities((rawHref ?? '').trim());
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('/')) return `${PAYCOR_CAREERS_HOST}${href}`;
    if (href) return `${PAYCOR_CAREERS_HOST}/career/${href.replace(/^\.?\//, '')}`;
    // Last-resort canonical reconstruction from the known token + id.
    return `${PAYCOR_CAREERS_HOST}${PAYCOR_JOB_INTRODUCTION_PATH}?clientId=${encodeURIComponent(
      clientId,
    )}&id=${encodeURIComponent(id)}&lang=${PAYCOR_DEFAULT_LANG}`;
  }

  /** Extract the opaque hex `id` token from a `JobIntroduction.action` href. */
  private extractJobId(href: string): string {
    const m = href.match(PAYCOR_JOB_ID_REGEX);
    return m && m[1] ? m[1] : '';
  }

  /**
   * Derive a human-friendly company name. Tenant portals rarely render the company
   * name in machine-readable markup and address the tenant by an opaque hex token,
   * so we title-case a non-opaque slug when one was supplied, else fall back to the
   * generic platform label.
   */
  private deriveCompanyName(companySlug: string | undefined, clientId: string): string {
    const base = companySlug && companySlug.trim() ? companySlug.trim() : '';
    // An opaque hex clientId (long, all hex) is not a usable display name.
    if (!base || /^[0-9a-f]{16,}$/i.test(base) || base.includes('clientId=')) {
      return 'Paycor Recruiting';
    }
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Paycor detail pages render location as a "{City}, {State|Country}" line. We split
   * it into city + region, surfacing the region as `state` (US tenants) — the DTO's
   * free-text fields tolerate either a state or a country token here.
   */
  private extractLocation(job: PaycorJob): LocationDto | null {
    const city = this.cleanText(job.city);
    const region = this.cleanText(job.region);
    if (!city && !region) return null;
    return new LocationDto({ city, state: region });
  }

  /** Split a "{City}, {Region}" location line into its city + region parts. */
  private parseLocation(line: string | null): { city: string | null; region: string | null } {
    const cleaned = this.cleanText(line ? this.decodeEntities(line) : null);
    if (!cleaned) return { city: null, region: null };
    const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return { city: null, region: null };
    return {
      city: parts[0] ?? null,
      region: parts.length > 1 ? parts.slice(1).join(', ') : null,
    };
  }

  /** Detect remote roles from the title, location, employment type, or body. */
  private detectRemote(job: PaycorJob): boolean {
    const haystacks: Array<string | null | undefined> = [
      job.title,
      job.city,
      job.region,
      job.employmentType,
      job.description,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (PAYCOR_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Return the leading "{title}" segment of a "{title} - {company}" string. */
  private leadingTitle(value: string | null): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    // The document title uses " - " / " | " between the role and the company.
    const idx = cleaned.search(/\s[-|–|]\s/);
    const head = idx > 0 ? cleaned.slice(0, idx) : cleaned;
    return this.cleanText(head);
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

  /** Decode the handful of HTML entities that appear in markup / meta-tag content. */
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
