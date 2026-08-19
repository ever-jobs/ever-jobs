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
  INRECRUITING_ROOT_DOMAIN,
  INRECRUITING_BRAND_DOMAIN,
  INRECRUITING_DEFAULT_LANG,
  INRECRUITING_CAREER_PATH,
  INRECRUITING_DEFAULT_RESULTS,
  INRECRUITING_MAX_DETAILS,
  INRECRUITING_HEADERS,
  INRECRUITING_JOB_LINK_REGEX,
  INRECRUITING_CARD_FIELD_REGEX,
  INRECRUITING_JSONLD_REGEX,
  INRECRUITING_OG_META_REGEX,
  INRECRUITING_TITLE_REGEX,
  INRECRUITING_REMOTE_REGEX,
} from './inrecruiting.constants';
import {
  InRecruitingListItem,
  InRecruitingJsonLd,
  InRecruitingJsonLdPlace,
  InRecruitingJob,
} from './inrecruiting.types';

/**
 * In-recruiting (Intervieweb) ATS careers scraper — generic, multi-tenant.
 *
 * In-recruiting (in-recruiting.com, by Intervieweb Srl / Zucchetti, Italy) powers each
 * customer's public, unauthenticated career site on the shared host `*.intervieweb.it`,
 * in two addressing shapes: a sub-domain tenant
 * (`https://{tenant}.intervieweb.it/{lang}/career`) and a shared-host + path tenant
 * (`https://{host}.intervieweb.it/{tenant}/{lang}/career`). Both render the open-roles
 * index as server-rendered HTML, listing each role as a canonical job anchor
 * (`/jobs/{slug}-{id}/{lang}/`) inside a `vacancy__` card alongside labelled fields
 * ("Location …", "Functional Area …"). The trailing numeric `{id}` is the stable ATS id.
 *
 * The adapter enumerates the index anchors (deduped by id, sliced to `resultsWanted`),
 * then fetches each role's detail page, preferring a schema.org `JobPosting` JSON-LD
 * block (title, description HTML, datePosted, employmentType, hiringOrganization,
 * jobLocation.address) and falling back to `og:` meta, the `<title>`, and the listing-
 * card fields where the JSON-LD is absent (notably the "SMART" path-tenant variant).
 *
 * The caller addresses a tenant by `companySlug` (e.g. `rinascente`, or `orbyta`) or by
 * `companyUrl` (a career / job URL on an `intervieweb.it` host). An unknown tenant (or
 * one with no open roles) yields a board with zero `/jobs/` anchors, so it degrades
 * naturally to an empty result. A fetch error, an HTTP 4xx, a DNS failure, or a
 * malformed body degrades to an empty / partial result rather than throwing, so a
 * single bad tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.INRECRUITING,
  name: 'In-recruiting (Intervieweb)',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class InRecruitingService implements IScraper {
  private readonly logger = new Logger(InRecruitingService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for In-recruiting scraper');
      return new JobResponseDto([]);
    }

    const target = this.resolveTarget(companySlug, input.companyUrl);
    if (!target) {
      this.logger.warn('Could not resolve an In-recruiting tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(INRECRUITING_HEADERS);

    const resultsWanted = input.resultsWanted ?? INRECRUITING_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching In-recruiting jobs for tenant: ${target.tenant}`);

      const indexHtml = await this.fetchHtml(client, target.indexUrl, target.tenant);
      if (indexHtml == null) {
        this.logger.log(`In-recruiting tenant "${target.tenant}" index unavailable`);
        return new JobResponseDto([]);
      }

      const items = this.parseIndex(indexHtml).slice(
        0,
        Math.min(resultsWanted, INRECRUITING_MAX_DETAILS),
      );
      if (items.length === 0) {
        this.logger.log(`In-recruiting tenant "${target.tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Fan out across role detail pages; a single failure must not nuke the batch.
      const settled = await Promise.allSettled(
        items.map((item) => this.fetchAndProcess(client, item, target, input.descriptionFormat)),
      );

      for (const result of settled) {
        if (result.status === 'fulfilled' && result.value) {
          jobPosts.push(result.value);
        } else if (result.status === 'rejected') {
          this.logger.warn(`Error processing In-recruiting role: ${result.reason}`);
        }
      }

      this.logger.log(`In-recruiting total: ${jobPosts.length} jobs for ${target.tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`In-recruiting scrape error for ${target.tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /** Fetch a role's detail page and normalise it into a JobPostDto (null on failure). */
  private async fetchAndProcess(
    client: ReturnType<typeof createHttpClient>,
    item: InRecruitingListItem,
    target: ResolvedTarget,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const detailUrl = this.cleanText(item.url);
    let detailHtml: string | null = null;
    if (detailUrl) {
      detailHtml = await this.fetchHtml(client, detailUrl, target.tenant);
    }
    const job = this.normaliseJob(item, detailHtml, target);
    return this.processJob(job, target, format);
  }

  /** GET a URL as text; an HTTP 4xx / DNS / network failure degrades to null (no throw). */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`In-recruiting page not found (HTTP ${status}) for ${tenant}`);
        return null;
      }
      this.logger.warn(`In-recruiting fetch failed for ${tenant}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse the server-rendered index HTML into role fragments. Rather than depend on
   * volatile CSS class names, we anchor on the canonical job links
   * (`/jobs/{slug}-{id}/{lang}/`) and read the labelled card text immediately around
   * each link to recover its title, location, and functional area.
   */
  private parseIndex(html: string): InRecruitingListItem[] {
    const out: InRecruitingListItem[] = [];
    const byId = new Map<string, InRecruitingListItem>();

    INRECRUITING_JOB_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INRECRUITING_JOB_LINK_REGEX.exec(html)) !== null) {
      const [, href, token, id] = match;
      const jobId = this.cleanText(id);
      if (!jobId || byId.has(jobId)) continue;

      const windowText = html.slice(match.index, Math.min(html.length, match.index + 1400));
      const cardFields = this.parseCardFields(html, match.index);

      const item: InRecruitingListItem = {
        id: jobId,
        token: this.cleanText(token),
        url: this.cleanText(href),
        title: this.titleFromCard(windowText) ?? this.titleFromToken(token),
        location: cardFields.location,
        functionalArea: cardFields.functionalArea,
      };

      byId.set(jobId, item);
      out.push(item);
    }

    return out;
  }

  /**
   * Read the labelled subtitle spans (`title="Location"`, `title="Functional Area"`)
   * from the listing card window immediately following a job anchor.
   */
  private parseCardFields(
    html: string,
    index: number,
  ): { location: string | null; functionalArea: string | null } {
    const window = html.slice(index, Math.min(html.length, index + 1400));
    let location: string | null = null;
    let functionalArea: string | null = null;

    const re = new RegExp(INRECRUITING_CARD_FIELD_REGEX.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
      const label = (m[1] || '').toLowerCase();
      const value = this.cleanText(htmlToPlainText(m[2] ?? ''));
      if (!value) continue;
      if (label.includes('location') && !location) location = value;
      else if ((label.includes('functional') || label.includes('area')) && !functionalArea) {
        functionalArea = value;
      }
    }

    return { location, functionalArea };
  }

  /** Pull the `<h3>` heading title from the card window following a job anchor. */
  private titleFromCard(windowText: string): string | null {
    const m = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(windowText);
    if (!m) return null;
    return this.cleanText(htmlToPlainText(m[1] ?? ''));
  }

  /**
   * Build a normalised In-recruiting role from a list item plus its (optional) detail
   * HTML. Prefers schema.org `JobPosting` JSON-LD; falls back to `og:` meta, the
   * `<title>`, and the listing-card fields where JSON-LD is absent.
   */
  private normaliseJob(
    item: InRecruitingListItem,
    detailHtml: string | null,
    target: ResolvedTarget,
  ): InRecruitingJob {
    const jobId = this.cleanText(item.id) ?? '';
    const ld = detailHtml ? this.extractJobPostingLd(detailHtml) : null;
    const og = detailHtml ? this.extractOgMeta(detailHtml) : {};

    const title =
      this.cleanText(ld?.title) ??
      this.cleanText(og['og:title']) ??
      this.cleanText(item.title) ??
      (detailHtml ? this.titleFromDocTitle(detailHtml) : null);

    const descriptionHtml =
      this.cleanText(ld?.description) ?? this.cleanText(og['og:description']) ?? null;

    const address = this.firstAddress(ld);
    const locationText =
      this.locationFromAddress(address) ?? this.cleanText(item.location) ?? null;
    const { city, state, country } = this.splitLocation(address, item.location);

    const department =
      this.cleanText(ld?.industry) ?? this.cleanText(item.functionalArea) ?? null;

    return {
      jobId,
      url: this.cleanText(item.url) ?? target.indexUrl,
      title,
      companyName:
        this.cleanText(ld?.hiringOrganization?.name) ?? this.deriveCompanyName(target.tenant),
      city,
      state,
      country,
      locationText,
      description: descriptionHtml,
      department,
      employmentType: this.normaliseEmploymentType(ld?.employmentType),
      datePosted: this.parseDate(ld?.datePosted),
      isRemote: this.detectRemote(title, locationText, department, ld?.jobLocationType),
    };
  }

  /** Map a normalised In-recruiting role → JobPostDto. */
  private processJob(
    job: InRecruitingJob,
    target: ResolvedTarget,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(target.tenant);
    const description = this.formatDescription(job.description ?? null, format);

    return new JobPostDto({
      id: `inrecruiting-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.INRECRUITING,
      atsId,
      atsType: 'inrecruiting',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the role description per `descriptionFormat`. The source is an HTML
   * fragment, so HTML is returned as-is, Markdown via the converter, Plain stripped.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant + index URL. An explicit `companySlug` is treated as a sub-domain
   * tenant (`https://{slug}.intervieweb.it/{lang}/career`) unless it is itself a full
   * career / job URL on an `intervieweb.it` host. A `companyUrl` on an `intervieweb.it`
   * host has its tenant + index URL derived from its host and (optional) path tenant.
   */
  private resolveTarget(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): ResolvedTarget | null {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (/^https?:\/\//i.test(slug) || slug.includes(INRECRUITING_ROOT_DOMAIN)) {
        const fromUrl = this.targetFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // A bare slug ignores the marketing domain if a caller accidentally passes it.
      if (slug.includes(INRECRUITING_BRAND_DOMAIN)) return null;
      const tenant = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!tenant) return null;
      const host = `${tenant}.${INRECRUITING_ROOT_DOMAIN}`;
      return {
        tenant,
        indexUrl: `https://${host}/${INRECRUITING_DEFAULT_LANG}/${INRECRUITING_CAREER_PATH}`,
      };
    }
    if (companyUrl) {
      const fromUrl = this.targetFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return null;
  }

  /**
   * Derive a tenant + index URL from an In-recruiting URL. Recognises both shapes:
   *   https://{tenant}.intervieweb.it/{lang}/career
   *   https://{host}.intervieweb.it/{tenant}/{lang}/career   (path tenant)
   * and the job-URL forms `.../jobs/{slug}-{id}/{lang}/` for either shape. The tenant
   * token is the path tenant when present, else the host sub-domain label.
   */
  private targetFromUrl(value: string): ResolvedTarget | null {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(INRECRUITING_ROOT_DOMAIN)) return null;

      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      const subdomain = hostname.slice(0, -(INRECRUITING_ROOT_DOMAIN.length + 1)) || '';

      // Detect a leading path-tenant segment (anything before /career, /jobs, or a lang).
      let pathTenant: string | null = null;
      const first = segments[0]?.toLowerCase();
      if (
        first &&
        first !== INRECRUITING_CAREER_PATH &&
        first !== 'jobs' &&
        !/^[a-z]{2}$/.test(first)
      ) {
        pathTenant = decodeURIComponent(segments[0]).toLowerCase();
      }

      const tenant = (pathTenant || subdomain || '').replace(/[^a-z0-9_-]/g, '');
      if (!tenant) return null;

      const base = pathTenant
        ? `https://${hostname}/${pathTenant}`
        : `https://${hostname}`;
      return {
        tenant,
        indexUrl: `${base}/${INRECRUITING_DEFAULT_LANG}/${INRECRUITING_CAREER_PATH}`,
      };
    } catch {
      return null;
    }
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Turn a `{slug}-{id}` token into a readable title (drops the trailing numeric id). */
  private titleFromToken(token: string | null | undefined): string | null {
    const cleaned = this.cleanText(token);
    if (!cleaned) return null;
    const withoutId = cleaned.replace(/-\d+$/, '');
    if (!withoutId) return null;
    return withoutId.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Read the document `<title>` text as a last-resort title. */
  private titleFromDocTitle(html: string): string | null {
    const m = INRECRUITING_TITLE_REGEX.exec(html);
    if (!m) return null;
    const text = this.cleanText(htmlToPlainText(m[1] ?? ''));
    if (!text) return null;
    // Drop a trailing " | career"/" - Inrecruiting" style site suffix.
    return this.cleanText(text.split(/\s*[|–-]\s*/)[0]) ?? text;
  }

  /**
   * Extract the first schema.org `JobPosting` JSON-LD block from a detail page, parsed
   * defensively. Non-JSON or non-JobPosting blocks are skipped; a parse error yields null.
   */
  private extractJobPostingLd(html: string): InRecruitingJsonLd | null {
    const re = new RegExp(INRECRUITING_JSONLD_REGEX.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const raw = (m[1] ?? '').trim();
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        if (c && typeof c === 'object' && this.isJobPosting((c as InRecruitingJsonLd)['@type'])) {
          return c as InRecruitingJsonLd;
        }
      }
    }
    return null;
  }

  /** True when a JSON-LD `@type` value denotes a JobPosting. */
  private isJobPosting(type: string | string[] | undefined): boolean {
    if (!type) return false;
    const types = Array.isArray(type) ? type : [type];
    return types.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
  }

  /** Harvest the `og:`/`twitter:` meta tags from a detail page into a lookup map. */
  private extractOgMeta(html: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = new RegExp(INRECRUITING_OG_META_REGEX.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const key = (m[1] || '').toLowerCase();
      const value = this.cleanText(m[2]);
      if (key && value && !(key in out)) out[key] = value;
    }
    return out;
  }

  /** Return the first usable PostalAddress from a JSON-LD jobLocation (single or array). */
  private firstAddress(ld: InRecruitingJsonLd | null): InRecruitingJsonLdPlace['address'] | null {
    if (!ld?.jobLocation) return null;
    const places = Array.isArray(ld.jobLocation) ? ld.jobLocation : [ld.jobLocation];
    for (const place of places) {
      if (place && typeof place === 'object' && place.address) return place.address;
    }
    return null;
  }

  /** Build a single-line location string from a JSON-LD address, when present. */
  private locationFromAddress(
    address: InRecruitingJsonLdPlace['address'] | null,
  ): string | null {
    if (!address) return null;
    const parts = [
      this.cleanText(address.addressLocality),
      this.cleanText(address.addressRegion),
      this.cleanText(address.addressCountry),
    ].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: InRecruitingJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Resolve city / state / country. Prefers the JSON-LD PostalAddress (locality / region
   * / country); falls back to a best-effort split of the card's free-text location line.
   */
  private splitLocation(
    address: InRecruitingJsonLdPlace['address'] | null,
    cardLocation: string | null | undefined,
  ): { city: string | null; state: string | null; country: string | null } {
    if (address) {
      const city = this.cleanText(address.addressLocality);
      const state = this.cleanText(address.addressRegion);
      const country = this.cleanText(address.addressCountry);
      if (city || state || country) return { city, state, country };
    }
    const text = this.cleanText(cardLocation);
    if (!text || this.isRemoteToken(text)) {
      return { city: null, state: null, country: null };
    }
    const parts = text
      .split(/[,•|]/)
      .map((p) => this.cleanText(p))
      .filter((p): p is string => !!p);
    if (parts.length === 0) return { city: null, state: null, country: null };
    if (parts.length === 1) return { city: parts[0], state: null, country: null };
    const country = parts[parts.length - 1];
    const city = parts.slice(0, parts.length - 1).join(', ');
    return { city: city || null, state: null, country: country || null };
  }

  /** Detect remote roles from the title, location, department, or JSON-LD location type. */
  private detectRemote(
    title: string | null,
    location: string | null,
    department: string | null,
    locationType: string | null | undefined,
  ): boolean {
    if (typeof locationType === 'string' && /telecommute/i.test(locationType)) return true;
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (INRECRUITING_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^(remote|da\s*remoto)$/i.test(value.trim());
  }

  /**
   * Normalise a schema.org employment-type token (e.g. `FULL_TIME`, `PART_TIME`,
   * `CONTRACTOR`) into a readable, trimmed, title-cased label. Accepts a string or the
   * first element of an array.
   */
  private normaliseEmploymentType(value: string | string[] | null | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const cleaned = this.cleanText(raw);
    if (!cleaned) return null;
    const spaced = cleaned.replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return spaced.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse a `datePosted` value into a YYYY-MM-DD string. In-recruiting JSON-LD renders an
   * absolute ISO date (e.g. `2026-05-14`); a non-parseable value yields null.
   */
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

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}

/** A resolved In-recruiting tenant + its open-roles index URL. */
interface ResolvedTarget {
  /** The tenant token (path tenant when present, else the host sub-domain label). */
  tenant: string;
  /** The absolute career index URL for the tenant. */
  indexUrl: string;
}
