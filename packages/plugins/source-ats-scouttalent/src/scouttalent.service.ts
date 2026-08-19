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
  SCOUTTALENT_HOST_TEMPLATE,
  SCOUTTALENT_ROOT_DOMAIN,
  SCOUTTALENT_ALT_DOMAINS,
  SCOUTTALENT_INDEX_PATH,
  SCOUTTALENT_JOB_LINK_REGEX,
  SCOUTTALENT_JSONLD_REGEX,
  SCOUTTALENT_OG_TITLE_REGEX,
  SCOUTTALENT_OG_URL_REGEX,
  SCOUTTALENT_OG_DESCRIPTION_REGEX,
  SCOUTTALENT_TITLE_TAG_REGEX,
  SCOUTTALENT_REMOTE_REGEX,
  SCOUTTALENT_DEFAULT_RESULTS,
  SCOUTTALENT_MAX_PAGES,
  SCOUTTALENT_HEADERS,
} from './scouttalent.constants';
import {
  ScoutTalentJob,
  ScoutTalentJobLink,
  ScoutTalentJobPosting,
  ScoutTalentJobLocation,
  ScoutTalentPostalAddress,
} from './scouttalent.types';

/**
 * Scout Talent ATS careers scraper — generic, multi-tenant.
 *
 * Scout Talent (scouttalent.com.au / scouttalent.com, AU / NZ) powers each
 * customer's candidate board on the shared application portal at
 * `https://{tenant}.applynow.net.au/`. The board is server-rendered HTML, so the
 * adapter enumerates a tenant's open roles from the index page's
 * `/jobs/{code}-{slug}` anchors and then fetches each role's server-rendered
 * detail page, preferring a schema.org `JobPosting` JSON-LD block (with `og:` meta
 * tags and the `<title>` / body HTML as defensive fallbacks).
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g.
 * `krg`) or by `companyUrl` (a portal URL whose first sub-domain label is the
 * tenant, or a bare host used verbatim). The index lists every open role in one
 * document — there is no server-side pagination of the job set — so we fetch once
 * and slice client-side to honour `resultsWanted`, bounded by a hard page cap. A
 * single fetch error, an unknown tenant (HTTP 4xx), or a malformed page degrades
 * to an empty / partial result rather than throwing, so a single tenant never
 * nukes a batch run.
 */
@SourcePlugin({
  site: Site.SCOUTTALENT,
  name: 'Scout Talent',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ScoutTalentService implements IScraper {
  private readonly logger = new Logger(ScoutTalentService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Scout Talent scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve a Scout Talent careers host from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(SCOUTTALENT_HEADERS);

    const resultsWanted = input.resultsWanted ?? SCOUTTALENT_DEFAULT_RESULTS;
    const tenant = this.deriveTenant(companySlug, host);
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Scout Talent index from: ${host}`);

      // The index page enumerates every open role for the tenant in one document.
      const links = await this.fetchJobLinks(client, host);
      if (links.length === 0) {
        this.logger.log(`Scout Talent tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Only fetch as many detail pages as the caller asked for (deduped first),
      // bounded by a hard page cap.
      const wanted = links
        .filter((l) => !seen.has(l.code) && seen.add(l.code))
        .slice(0, Math.min(resultsWanted, SCOUTTALENT_MAX_PAGES));

      for (const link of wanted) {
        try {
          const post = await this.processLink(client, link, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Scout Talent role ${link.code}: ${err.message}`);
        }
      }

      this.logger.log(`Scout Talent total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Scout Talent scrape error for ${host}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch and parse the tenant index page into open-role links. An unknown
   * sub-domain (HTTP 4xx) or a missing index degrades to an empty list.
   */
  private async fetchJobLinks(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<ScoutTalentJobLink[]> {
    const url = `${host}${SCOUTTALENT_INDEX_PATH}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      return this.parseJobLinks(html, host);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Scout Talent index not found (HTTP ${status}) at ${url}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Extract `/jobs/{code}-{slug}` links (absolute or relative) from the index
   * HTML, capturing the leading `{code}` segment as the ATS id and rebuilding an
   * absolute detail URL against the tenant host. Duplicate codes are de-duped here
   * (a role may be linked more than once on the index).
   */
  private parseJobLinks(html: string, host: string): ScoutTalentJobLink[] {
    const links: ScoutTalentJobLink[] = [];
    const seen = new Set<string>();

    const re = new RegExp(SCOUTTALENT_JOB_LINK_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const path = match[1];
      const code = this.cleanText(match[2]);
      if (!path || !code || seen.has(code)) continue;
      seen.add(code);
      links.push({ code, url: this.absoluteUrl(host, path) });
    }

    return links;
  }

  /** Fetch + parse a single detail page, then map it to a JobPostDto. */
  private async processLink(
    client: ReturnType<typeof createHttpClient>,
    link: ScoutTalentJobLink,
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
        this.logger.warn(`Scout Talent role ${link.code} not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }

    const job = this.parseDetail(html, link);
    return this.processJob(job, tenant, format);
  }

  /** Parse a detail page's HTML (JSON-LD JobPosting + og: / title fallbacks) into a ScoutTalentJob. */
  private parseDetail(html: string, link: ScoutTalentJobLink): ScoutTalentJob {
    const posting = this.findJobPosting(html);

    const ogTitle = this.firstGroup(html, SCOUTTALENT_OG_TITLE_REGEX);
    const titleTag = this.firstGroup(html, SCOUTTALENT_TITLE_TAG_REGEX);
    const ogDescription = this.firstGroup(html, SCOUTTALENT_OG_DESCRIPTION_REGEX);
    const ogUrl = this.firstGroup(html, SCOUTTALENT_OG_URL_REGEX);

    const title =
      this.cleanText(posting?.title) ??
      this.leadingTitle(ogTitle) ??
      this.leadingTitle(titleTag);

    const address = this.firstAddress(posting?.jobLocation);
    const companyName = this.organizationName(posting?.hiringOrganization);

    const descriptionHtml = this.cleanText(posting?.description);

    return {
      code: link.code,
      url: link.url,
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
   * may be a single object, an array of objects, or a `@graph` envelope; we narrow
   * defensively and return the first `JobPosting` found.
   */
  private findJobPosting(html: string): ScoutTalentJobPosting | null {
    const re = new RegExp(SCOUTTALENT_JSONLD_REGEX.source, 'gi');
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
  private extractPosting(value: unknown): ScoutTalentJobPosting | null {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.extractPosting(item);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (this.isJobPostingType(obj['@type'])) return obj as ScoutTalentJobPosting;
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

  /** Map a normalised ScoutTalentJob → JobPostDto. */
  private processJob(
    job: ScoutTalentJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.code ?? '');
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
      id: `scouttalent-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.SCOUTTALENT,
      atsId,
      atsType: 'scouttalent',
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
   * the canonical `{tenant}.applynow.net.au` host; a `companyUrl` on the
   * `applynow.net.au` domain (or a known alternative portal host) has its origin
   * used verbatim. Returns an empty string when neither yields a host.
   */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.toLowerCase();
        if (
          hostname.endsWith(SCOUTTALENT_ROOT_DOMAIN) ||
          SCOUTTALENT_ALT_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))
        ) {
          return `${u.protocol}//${u.host}`;
        }
      } catch {
        // Malformed URL — fall through to the slug.
      }
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim().toLowerCase();
      // A caller may also pass a bare host (e.g. "krg.applynow.net.au").
      if (
        slug.includes(SCOUTTALENT_ROOT_DOMAIN) ||
        SCOUTTALENT_ALT_DOMAINS.some((d) => slug.includes(d))
      ) {
        const host = slug.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        return `https://${host}`;
      }
      return SCOUTTALENT_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(slug));
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

  /** De-slugify + title-case a company name (from JSON-LD, else the tenant slug). */
  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : tenant) || tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the JSON-LD `jobLocation.address` parts (locality / region / country)
   * as a LocationDto, leaving location null when nothing usable is present.
   */
  private extractLocation(job: ScoutTalentJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from `jobLocationType`, the title, or the location text. */
  private detectRemote(
    posting: ScoutTalentJobPosting | null,
    title: string | null,
    address: ScoutTalentPostalAddress | null,
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
      if (SCOUTTALENT_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Return the first `PostalAddress` from a `jobLocation` (object or array). */
  private firstAddress(
    jobLocation: ScoutTalentJobLocation | ScoutTalentJobLocation[] | null | undefined,
  ): ScoutTalentPostalAddress | null {
    if (!jobLocation) return null;
    const first = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
    const address = first?.address;
    return address && typeof address === 'object' ? address : null;
  }

  /** Resolve the hiring-organisation display name (object `name` or bare string). */
  private organizationName(
    org: ScoutTalentJobPosting['hiringOrganization'],
  ): string | null {
    if (!org) return null;
    if (typeof org === 'string') return this.cleanText(org);
    return this.cleanText(org.name);
  }

  /** Resolve the country display value (a bare code/name, or an object with `name`). */
  private countryName(country: ScoutTalentPostalAddress['addressCountry']): string | null {
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

  /** Build an absolute detail URL from a tenant host + an absolute-or-relative path. */
  private absoluteUrl(host: string, path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const base = host.replace(/\/+$/, '');
    const rel = path.startsWith('/') ? path : `/${path}`;
    return `${base}${rel}`;
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
