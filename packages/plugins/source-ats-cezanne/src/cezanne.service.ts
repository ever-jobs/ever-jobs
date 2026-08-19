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
  CEZANNE_ROOT_DOMAIN,
  CEZANNE_CAREER_HOST,
  CEZANNE_LANGS,
  CEZANNE_CAREER_PATH,
  CEZANNE_JOBVACANCY_PATH,
  CEZANNE_DEFAULT_RESULTS,
  CEZANNE_MAX_PAGES,
  CEZANNE_DEFAULT_TIMEOUT_SECONDS,
  CEZANNE_HEADERS,
  CEZANNE_JSONLD_REGEX,
  CEZANNE_JOB_ANCHOR_REGEX,
  CEZANNE_JOB_ID_REGEX,
  CEZANNE_REMOTE_REGEX,
  cezanneCareerOrigin,
} from './cezanne.constants';
import {
  CezanneJob,
  CezanneJobAnchor,
  CezanneJsonLd,
  CezannePostalAddress,
} from './cezanne.types';

/**
 * Cezanne HR ATS careers scraper — generic, multi-tenant.
 *
 * Cezanne HR (cezannehr.com — a UK / EU mid-market HR + recruitment suite) publishes each
 * customer tenant's branded, public, unauthenticated candidate-facing careers board on the
 * shared hosted careers host `https://cezanneondemand.intervieweb.it/{tenant}/{lang}/career`.
 * The board is a server-rendered page that lists each open role as an anchor to its
 * per-role detail page `…/jobvacancy/{slug}/{id}`; richer boards / detail pages additionally
 * embed schema.org `JobPosting` JSON-LD. The adapter fetches the board HTML, harvests the
 * per-role `jobvacancy` anchors (and any JSON-LD island), and maps each role — rather than
 * depending on a client-rendered DOM, a headless browser, or an authenticated REST API.
 * Each role's trailing numeric `id` builds the canonical detail / apply URL and is the
 * stable ATS id.
 *
 * The caller addresses a tenant by `companySlug` (the first path segment, e.g.
 * `bluecresthealth`) or by `companyUrl` (a careers-board URL on the hosted careers host
 * whose first path segment is the tenant). An unknown tenant, one with no open roles, an
 * empty board, or a session-gated board degrades naturally to an empty result. A fetch
 * error, an HTTP 4xx, a DNS failure, or a malformed body degrades to an empty / partial
 * result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.CEZANNE,
  name: 'Cezanne HR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class CezanneService implements IScraper {
  private readonly logger = new Logger(CezanneService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Cezanne scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Cezanne tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Cezanne careers host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH
    // keys: the no-proxy path keys off `timeout`, the proxy path off
    // `requestTimeout`. A caller may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? CEZANNE_DEFAULT_TIMEOUT_SECONDS,
      CEZANNE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(CEZANNE_HEADERS);

    const resultsWanted = input.resultsWanted ?? CEZANNE_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Cezanne jobs for tenant: ${tenant}`);

      const found = await this.fetchJobs(client, tenant);
      if (!found) {
        this.logger.log(`Cezanne tenant "${tenant}" has no reachable open-roles board`);
        return new JobResponseDto([]);
      }

      const { jobs, companyName } = found;
      if (jobs.length === 0) {
        this.logger.log(`Cezanne tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const item of jobs) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processItem(item, tenant, companyName, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Cezanne role ${item?.atsId}: ${err.message}`);
        }
      }

      this.logger.log(`Cezanne total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Cezanne scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Probe the tenant's careers board across the known locale variants until one yields a
   * harvestable open-roles set. Returns the parsed roles and the tenant's display brand
   * name (from any JSON-LD `hiringOrganization.name`), or null when none respond.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<{ jobs: CezanneJob[]; companyName: string } | null> {
    const origin = cezanneCareerOrigin();
    let attempts = 0;

    for (const lang of CEZANNE_LANGS) {
      if (attempts >= CEZANNE_MAX_PAGES) return null;
      attempts++;

      const url = `${origin}/${encodeURIComponent(tenant)}/${lang}/${CEZANNE_CAREER_PATH}`;
      const { data: html, hostReachable } = await this.fetchHtml(client, url, tenant);
      // A transport-level failure (DNS / refused / reset / timeout) means the host itself
      // is unreachable — no other locale can succeed, so abort the whole probe sweep
      // rather than burning a full timeout per combo.
      if (!hostReachable) return null;
      if (html == null) continue;

      const parsed = this.extractJobs(html, tenant);
      if (parsed == null || parsed.jobs.length === 0) continue; // no roles — try next locale

      // A locale exposing roles is the right surface; return its roles and brand name.
      return parsed;
    }

    return null;
  }

  /**
   * GET a careers-board URL as text. Returns `{ data, hostReachable }`:
   *  - `data` is the body, or null when the response carried no usable text / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the careers host itself is unreachable and the
   *    caller should stop probing further locale variations.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<{ data: string | null; hostReachable: boolean }> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return {
        data: typeof response.data === 'string' ? response.data : null,
        hostReachable: true,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx not-found / 5xx) — it is reachable, so the
        // caller may still try other locale variations.
        this.logger.warn(`Cezanne board returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // careers host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Cezanne board fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Extract the open-roles set from the server-rendered board HTML. Two complementary
   * sources are merged:
   *  - schema.org `JobPosting` JSON-LD island(s) (the richest structured source — title,
   *    datePosted, location, description, brand), keyed by their detail URL's vacancy id;
   *  - per-role `jobvacancy` anchors (the always-present board listing), keyed by the same
   *    trailing vacancy id, used to seed roles the JSON-LD omits and to supply a title /
   *    URL fallback.
   * Returns `{ jobs, companyName }` (jobs possibly empty — an empty / session-gated board
   * is a valid "no roles" result) or null when the HTML is unusable.
   */
  private extractJobs(html: string, tenant: string): { jobs: CezanneJob[]; companyName: string } | null {
    if (typeof html !== 'string' || html.length === 0) return null;

    const byId = new Map<string, CezanneJob>();
    let brandName = '';

    // 1) JSON-LD JobPosting islands — the richest structured source.
    for (const ld of this.extractJsonLd(html)) {
      if (!this.isJobPosting(ld)) continue;
      const job = this.normaliseJsonLd(ld, tenant);
      if (!job) continue;
      if (!brandName) {
        const name = this.cleanText(ld.hiringOrganization?.name);
        if (name) brandName = name;
      }
      if (!byId.has(job.atsId)) byId.set(job.atsId, job);
    }

    // 2) Per-role anchors — seed roles the JSON-LD did not cover and backfill title / URL.
    for (const anchor of this.extractAnchors(html)) {
      const job = this.normaliseAnchor(anchor, tenant);
      if (!job) continue;
      const existing = byId.get(job.atsId);
      if (!existing) {
        byId.set(job.atsId, job);
      } else if (!existing.title && job.title) {
        existing.title = job.title;
      }
    }

    return { jobs: Array.from(byId.values()), companyName: brandName };
  }

  /**
   * Parse every schema.org JSON-LD island in the HTML, flattening `@graph` containers and
   * top-level arrays. Each parse is isolated so one malformed island never drops the rest.
   */
  private extractJsonLd(html: string): CezanneJsonLd[] {
    const out: CezanneJsonLd[] = [];
    CEZANNE_JSONLD_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CEZANNE_JSONLD_REGEX.exec(html)) !== null) {
      const raw = match[1];
      if (!raw || !raw.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Island present but unparseable — skip it, keep harvesting the rest.
        continue;
      }
      for (const node of this.flattenJsonLd(parsed)) out.push(node);
    }
    return out;
  }

  /** Flatten an island into candidate nodes (arrays + `@graph` containers). */
  private flattenJsonLd(parsed: unknown): CezanneJsonLd[] {
    if (Array.isArray(parsed)) {
      return parsed.flatMap((n) => this.flattenJsonLd(n));
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as CezanneJsonLd & { '@graph'?: unknown };
      if (Array.isArray(obj['@graph'])) {
        return (obj['@graph'] as unknown[]).flatMap((n) => this.flattenJsonLd(n));
      }
      return [obj];
    }
    return [];
  }

  /** True when a JSON-LD node is a schema.org `JobPosting`. */
  private isJobPosting(ld: CezanneJsonLd): boolean {
    const type = ld?.['@type'];
    if (typeof type === 'string') return type.toLowerCase() === 'jobposting';
    if (Array.isArray(type)) return type.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
    return false;
  }

  /** Harvest every per-role `jobvacancy` anchor from the board HTML. */
  private extractAnchors(html: string): CezanneJobAnchor[] {
    const out: CezanneJobAnchor[] = [];
    CEZANNE_JOB_ANCHOR_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CEZANNE_JOB_ANCHOR_REGEX.exec(html)) !== null) {
      const href = match[1];
      if (!href) continue;
      out.push({ href, text: this.stripTags(match[2]) });
    }
    return out;
  }

  /** Build a normalised CezanneJob from a JSON-LD JobPosting node. */
  private normaliseJsonLd(ld: CezanneJsonLd, tenant: string): CezanneJob | null {
    const url = this.absoluteUrl(this.cleanText(ld.url));
    const atsId = url ? this.jobIdFromUrl(url) : null;
    if (!atsId || !url) return null;

    const location = this.locationFromJsonLd(ld);
    const title = this.cleanText(ld.title);

    return {
      atsId,
      url,
      // The Cezanne detail page hosts the apply flow inline; the canonical apply URL is
      // the detail URL itself.
      applyUrl: url,
      title,
      companyName: this.cleanText(ld.hiringOrganization?.name) || this.deriveSlugName(tenant),
      city: location.city,
      state: location.state,
      country: location.country,
      locationText: location.text,
      descriptionHtml: this.cleanText(ld.description),
      employmentType: this.firstString(ld.employmentType),
      datePosted: this.parseDate(ld.datePosted),
      isRemote: this.detectRemote(title, location.text),
    };
  }

  /** Build a normalised CezanneJob from a board anchor (the lightweight listing source). */
  private normaliseAnchor(anchor: CezanneJobAnchor, tenant: string): CezanneJob | null {
    const url = this.absoluteUrl(anchor.href);
    const atsId = url ? this.jobIdFromUrl(url) : null;
    if (!atsId || !url) return null;

    const title = this.cleanText(anchor.text);

    return {
      atsId,
      url,
      applyUrl: url,
      title,
      companyName: this.deriveSlugName(tenant),
      city: null,
      state: null,
      country: null,
      locationText: null,
      descriptionHtml: null,
      employmentType: null,
      datePosted: null,
      isRemote: this.detectRemote(title, null),
    };
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: CezanneJob,
    tenant: string,
    brandName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    if (!item) return null;
    if (seen.has(item.atsId)) return null;
    seen.add(item.atsId);
    return this.processJob(item, tenant, brandName, format);
  }

  /** Map a normalised CezanneJob → JobPostDto. */
  private processJob(
    job: CezanneJob,
    tenant: string,
    brandName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName || brandName || this.deriveSlugName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `cezanne-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.CEZANNE,
      atsId,
      atsType: 'cezanne',
      department: null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Cezanne boards expose the
   * body as HTML when present (via JSON-LD), so HTML returns it as-is, Markdown converts
   * it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare
   * careers-board URL passed as the slug is reduced to its tenant token); a `companyUrl`
   * on the hosted careers host has the tenant taken from its first path segment. Returns
   * an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full careers-board URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(CEZANNE_ROOT_DOMAIN)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant token from a Cezanne careers-board URL. The candidate-facing host is
   * the shared `cezanneondemand.intervieweb.it`; the tenant is the FIRST path segment of
   * `/{tenant}/{lang}/career`.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(CEZANNE_ROOT_DOMAIN)) {
        // Not a hosted careers host — no derivable tenant.
        return '';
      }
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      const label = segments[0];
      // Guard against an empty / non-tenant leading segment.
      if (!label || label === 'www' || label === 'access.php' || label === 'app.php') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Resolve a possibly host-relative href against the hosted careers origin. */
  private absoluteUrl(href: string | null | undefined): string | null {
    const cleaned = this.cleanText(href);
    if (!cleaned) return null;
    try {
      return new URL(cleaned, `${cezanneCareerOrigin()}/`).toString();
    } catch {
      return null;
    }
  }

  /** Extract the trailing numeric vacancy id from a `jobvacancy/{slug}/{id}` URL. */
  private jobIdFromUrl(url: string): string | null {
    CEZANNE_JOB_ID_REGEX.lastIndex = 0;
    const match = CEZANNE_JOB_ID_REGEX.exec(url);
    return match && match[1] ? match[1] : null;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: CezanneJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Derive structured + free-text location from a JSON-LD `jobLocation`. Accepts either a
   * single place or a list (the first usable wins).
   */
  private locationFromJsonLd(
    ld: CezanneJsonLd,
  ): { city: string | null; state: string | null; country: string | null; text: string | null } {
    const raw = ld?.jobLocation;
    const places = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const place of places) {
      const address: CezannePostalAddress | null | undefined = place?.address;
      if (!address) continue;
      const city = this.cleanText(address.addressLocality);
      const state = this.cleanText(address.addressRegion);
      const country = this.countryName(address.addressCountry);
      if (city || state || country) {
        return { city, state, country, text: this.joinLocation(city, state, country) };
      }
    }
    return { city: null, state: null, country: null, text: null };
  }

  /** Read a schema.org `addressCountry` (a string or a nested `{ name }`). */
  private countryName(value: string | { name?: string | null } | null | undefined): string | null {
    if (typeof value === 'string') return this.cleanText(value);
    if (value && typeof value === 'object') return this.cleanText(value.name);
    return null;
  }

  /** Join the structured location parts into a single free-text line (for remote tests). */
  private joinLocation(
    city: string | null,
    state: string | null,
    country: string | null,
  ): string | null {
    const parts = [city, state, country].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /** Detect remote roles from the title / location text. */
  private detectRemote(title: string | null, location: string | null): boolean {
    const haystacks: Array<string | null | undefined> = [title, location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (CEZANNE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse an ISO timestamp value into a YYYY-MM-DD string. Non-absolute / unparseable
   * values yield null.
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

  /** First usable string from a string / string[] field, or null. */
  private firstString(value: string | string[] | null | undefined): string | null {
    if (typeof value === 'string') return this.cleanText(value);
    if (Array.isArray(value)) {
      for (const v of value) {
        const c = this.cleanText(typeof v === 'string' ? v : null);
        if (c) return c;
      }
    }
    return null;
  }

  /** Strip HTML tags from anchor inner-HTML, collapsing whitespace, or null when empty. */
  private stripTags(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const text = value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
    return text.length > 0 ? text : null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
