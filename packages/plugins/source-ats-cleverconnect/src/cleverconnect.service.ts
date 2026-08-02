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
  CLEVERCONNECT_HOST_TEMPLATE,
  CLEVERCONNECT_ROOT_DOMAIN,
  CLEVERCONNECT_BOARD_PATH,
  CLEVERCONNECT_JOBADS_PATH,
  CLEVERCONNECT_DEFAULT_RESULTS,
  CLEVERCONNECT_MAX_PAGES,
  CLEVERCONNECT_HEADERS,
  CLEVERCONNECT_ENTITY_DECODE,
  CLEVERCONNECT_OFFER_MARKER,
  CLEVERCONNECT_OFFER_ID_REGEX,
  CLEVERCONNECT_REMOTE_REGEX,
} from './cleverconnect.constants';
import {
  CleverConnectJob,
  CleverConnectLabel,
  CleverConnectOffer,
} from './cleverconnect.types';

/**
 * CleverConnect career-site scraper — generic, multi-tenant.
 *
 * CleverConnect (cleverconnect.com, France) powers each customer's branded careers
 * board on the shared host `https://career.{tenant}.cleverconnect.com/jobs`. That
 * board is an Angular SPA, but the server pre-renders the full open-roles payload
 * into the initial HTML document as an Angular TransferState JSON island (with JSON
 * punctuation HTML-entity-encoded). The adapter decodes that island and parses the
 * embedded offer array — so it never depends on the SPA's runtime XHR API.
 *
 * Each embedded offer carries a numeric `id` (the stable ATS id), `title`,
 * `description` (HTML), `locality`, a hiring-company name (`recruiter`/`publisher`),
 * contract-type / job-family labels, and the canonical / short detail paths
 * (`url.jobOffer`, `url.jobOfferShort` = `/jobads/{id}`) plus an optional external
 * apply redirect (`url.redirect`).
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g. `demo`)
 * or by `companyUrl` (a career-site URL on a `cleverconnect.com` host whose host
 * encodes the tenant label). An unknown tenant resolves to a host with no record / an
 * empty board, so it degrades naturally to an empty result. A fetch error, an HTTP
 * 4xx, a DNS failure, or a malformed / un-decodable body degrades to an empty /
 * partial result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.CLEVERCONNECT,
  name: 'CleverConnect',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class CleverConnectService implements IScraper {
  private readonly logger = new Logger(CleverConnectService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for CleverConnect scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a CleverConnect tenant slug from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(CLEVERCONNECT_HEADERS);

    const resultsWanted = input.resultsWanted ?? CLEVERCONNECT_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching CleverConnect jobs for tenant: ${tenant}`);

      const offers = await this.fetchOffers(client, tenant, resultsWanted, seen);
      if (offers.length === 0) {
        this.logger.log(`CleverConnect tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      for (const offer of offers) {
        try {
          const post = this.processOffer(offer, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing CleverConnect offer ${offer?.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(`CleverConnect total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`CleverConnect scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Fetch + decode the tenant board document(s), accumulating up to `resultsWanted`
   * deduped PUBLISHED offers. The board pre-renders the full set in one document; the
   * page loop is a guard against any future server-side pagination. An unknown tenant
   * yields no document / no offers; an HTTP 4xx or a missing body degrades to empty.
   */
  private async fetchOffers(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<CleverConnectOffer[]> {
    const out: CleverConnectOffer[] = [];
    const base = `${this.tenantHost(tenant)}${CLEVERCONNECT_BOARD_PATH}`;

    for (let page = 1; page <= CLEVERCONNECT_MAX_PAGES; page++) {
      const url = page === 1 ? base : `${base}?page=${page}`;
      const html = await this.fetchHtml(client, url, tenant);
      if (html == null) break;

      const parsed = this.parseBoard(html);
      let added = 0;
      for (const offer of parsed) {
        if (!this.isPublished(offer)) continue;
        const id = this.offerId(offer);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(offer);
        added++;
        if (out.length >= resultsWanted) return out;
      }

      // The board is single-document; stop once a page yields no new offers.
      if (added === 0) break;
    }

    return out;
  }

  /** GET a board URL as text; an HTTP 4xx / DNS failure degrades to null (no throw). */
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
        this.logger.warn(`CleverConnect board not found (HTTP ${status}) for ${tenant}`);
        return null;
      }
      // 5xx / network / DNS error — degrade gracefully rather than throwing.
      this.logger.warn(
        `CleverConnect board fetch failed for ${tenant}: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Parse the board HTML into offer objects. The full offer array is embedded in the
   * document as an Angular TransferState JSON island whose JSON punctuation is
   * HTML-entity-encoded (`&q;` → `"`, etc.). We decode the document, then harvest
   * every self-contained offer object with a balanced-brace scan anchored on the
   * stable per-offer boundary token (`{"score":`, which opens each offer object),
   * parsing each independently so one malformed object never sinks the rest.
   */
  private parseBoard(html: string): CleverConnectOffer[] {
    if (typeof html !== 'string' || html.length === 0) return [];
    const decoded = this.decodeEntities(html);
    const offers: CleverConnectOffer[] = [];
    const byId = new Map<string, CleverConnectOffer>();

    // Each offer object opens with `{"score":…,"id":"{id}",…}`. Anchor on that
    // boundary token, find its matching close brace, and JSON.parse the balanced slice.
    const marker = CLEVERCONNECT_OFFER_MARKER;
    let from = 0;
    while (true) {
      const start = decoded.indexOf(marker, from);
      if (start < 0) break;
      from = start + marker.length;

      const end = this.objectEnd(decoded, start);
      if (end < 0) continue;
      from = end + 1;

      const slice = decoded.slice(start, end + 1);
      const offer = this.safeParseOffer(slice);
      if (!offer) continue;
      const id = this.offerId(offer);
      if (!id || byId.has(id)) continue;
      byId.set(id, offer);
      offers.push(offer);
    }

    return offers;
  }

  /**
   * From an opening-brace index, find the matching close brace, honouring nested
   * objects and skipping braces that appear inside JSON string literals (with escape
   * handling). Returns -1 when unbalanced.
   */
  private objectEnd(s: string, start: number): number {
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** Reverse the TransferState entity encoding so the island parses as JSON. */
  private decodeEntities(html: string): string {
    let out = html;
    for (const [token, replacement] of CLEVERCONNECT_ENTITY_DECODE) {
      if (out.indexOf(token) >= 0) {
        out = out.split(token).join(replacement);
      }
    }
    return out;
  }

  /** JSON.parse an offer slice, returning null on any malformation (never throws). */
  private safeParseOffer(slice: string): CleverConnectOffer | null {
    try {
      const obj = JSON.parse(slice);
      if (obj && typeof obj === 'object') return obj as CleverConnectOffer;
    } catch {
      // malformed object — skip
    }
    return null;
  }

  /** Map a parsed offer → JobPostDto. */
  private processOffer(
    offer: CleverConnectOffer,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const job = this.normaliseJob(offer, tenant);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised CleverConnectJob from a parsed offer. */
  private normaliseJob(offer: CleverConnectOffer, tenant: string): CleverConnectJob {
    const jobId = this.offerId(offer) ?? '';
    const title = this.cleanText(offer.title);
    const locationText = this.cleanText(offer.locality);
    const { city, state, country } = this.splitLocation(locationText);
    const descriptionHtml =
      this.cleanText(offer.description) ?? this.cleanText(offer.companyDescription);
    const employmentType = this.labelValues(offer.labels?.contractTypeList);
    const department =
      this.labelValues(offer.labels?.macroJobList) ??
      this.labelValues(offer.labels?.jobList);

    return {
      jobId,
      url: this.buildJobUrl(tenant, offer),
      applyUrl: this.cleanText(offer.url?.redirect),
      title,
      companyName: this.deriveCompanyName(offer, tenant),
      city,
      state,
      country,
      locationText,
      descriptionHtml,
      department,
      employmentType,
      datePosted: this.parseDate(offer.publicationDate ?? offer.lastModification),
      isRemote: this.detectRemote(title, locationText, employmentType, descriptionHtml),
    };
  }

  /** Map a normalised CleverConnectJob → JobPostDto. */
  private processJob(
    job: CleverConnectJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyNameFromSlug(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `cleverconnect-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.CLEVERCONNECT,
      atsId,
      atsType: 'cleverconnect',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: this.cleanText(job.applyUrl) ?? jobUrl,
    });
  }

  /**
   * Convert the HTML job body per `descriptionFormat`. The body is HTML, so HTML
   * returns it verbatim, Markdown converts it, and Plain (default) strips tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare career
   * URL passed as the slug is reduced to its tenant label); a `companyUrl` on a
   * `cleverconnect.com` host has the tenant taken from its `career.{tenant}` host.
   * Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (/^https?:\/\//i.test(slug) || slug.includes(CLEVERCONNECT_ROOT_DOMAIN)) {
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
   * Derive the tenant label from a CleverConnect career-site URL. The candidate-facing
   * host is `career.{tenant}.cleverconnect.com`; we take the label immediately before
   * the `cleverconnect.com` root, skipping a leading `career`/`www` host label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(CLEVERCONNECT_ROOT_DOMAIN)) return '';

      // Strip the root domain, leaving the sub-domain labels (e.g. "career.demo").
      const prefix = hostname.slice(0, hostname.length - CLEVERCONNECT_ROOT_DOMAIN.length);
      const labels = prefix.split('.').filter((l) => l.length > 0);
      if (labels.length === 0) return '';

      // Drop a leading host label ("career" / "www"); the tenant is the next label.
      const filtered = labels.filter((l) => l !== 'career' && l !== 'www');
      const tenant = filtered.length > 0 ? filtered[0] : labels[labels.length - 1];
      return decodeURIComponent(tenant).toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Build the tenant career-site origin from its slug. */
  private tenantHost(tenant: string): string {
    return CLEVERCONNECT_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
  }

  /**
   * Build the canonical public detail / apply URL for an offer. Prefers the short,
   * stable `/jobads/{id}` path; falls back to the canonical `url.jobOffer` path, then
   * to a synthesised `/jobads/{id}` from the offer id.
   */
  private buildJobUrl(tenant: string, offer: CleverConnectOffer): string {
    const host = this.tenantHost(tenant);
    const short = this.cleanText(offer.url?.jobOfferShort);
    if (short) return short.startsWith('http') ? short : `${host}${this.ensureLeadingSlash(short)}`;
    const canonical = this.cleanText(offer.url?.jobOffer);
    if (canonical) {
      return canonical.startsWith('http')
        ? canonical
        : `${host}${this.ensureLeadingSlash(canonical)}`;
    }
    const id = this.offerId(offer);
    return id ? `${host}${CLEVERCONNECT_JOBADS_PATH}${id}` : host;
  }

  /** Ensure a relative path begins with a single leading slash. */
  private ensureLeadingSlash(path: string): string {
    return path.startsWith('/') ? path : `/${path}`;
  }

  /** Extract the numeric offer id as a string, from `id` or the detail path tail. */
  private offerId(offer: CleverConnectOffer): string | null {
    if (offer == null) return null;
    if (typeof offer.id === 'number' && Number.isFinite(offer.id)) return String(offer.id);
    const idStr = this.cleanText(typeof offer.id === 'string' ? offer.id : null);
    if (idStr && /^\d+$/.test(idStr)) return idStr;

    // Fall back to the trailing numeric id of a detail path.
    for (const path of [offer.url?.jobOfferShort, offer.url?.jobOffer]) {
      const p = this.cleanText(path);
      if (!p) continue;
      const m = CLEVERCONNECT_OFFER_ID_REGEX.exec(p);
      if (m) return m[1];
    }
    return null;
  }

  /** True when an offer is publicly published (or carries no status at all). */
  private isPublished(offer: CleverConnectOffer): boolean {
    const status = this.cleanText(offer?.status);
    if (!status) return true; // no status field → assume listable
    return status.toUpperCase() === 'PUBLISHED';
  }

  /** Join a label list's values into a single readable label (comma-separated). */
  private labelValues(list: CleverConnectLabel[] | null | undefined): string | null {
    if (!Array.isArray(list) || list.length === 0) return null;
    const values = list
      .map((l) => this.cleanText(l?.value))
      .filter((v): v is string => !!v);
    return values.length > 0 ? values.join(', ') : null;
  }

  /** Derive the hiring-company display name from the offer, falling back to the slug. */
  private deriveCompanyName(offer: CleverConnectOffer, tenant: string): string {
    return (
      this.cleanText(offer.recruiter) ??
      this.cleanText(offer.publisher) ??
      this.cleanText(offer.company?.name) ??
      this.deriveCompanyNameFromSlug(tenant)
    );
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyNameFromSlug(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present. CleverConnect renders a single free-text location line
   * (e.g. "Guebwiller (68) - Grand Est"); we keep the trailing region as state and the
   * leading town as city, best-effort.
   */
  private extractLocation(job: CleverConnectJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state / country.
   * CleverConnect localities look like "Guebwiller (68) - Grand Est" or
   * "Issy-les-Moulineaux (92) - Île-de-France": the head (before the dash, minus the
   * parenthesised département code) is the city, the tail (after the dash) the region
   * (state). A trailing comma-separated country token, when present, is kept as country.
   */
  private splitLocation(
    text: string | null,
  ): { city: string | null; state: string | null; country: string | null } {
    if (!text || this.isRemoteToken(text)) {
      return { city: null, state: null, country: null };
    }

    let country: string | null = null;
    let body = text;
    // A trailing ", Country" token, when present.
    const commaParts = body.split(',').map((p) => this.cleanText(p)).filter((p): p is string => !!p);
    if (commaParts.length > 1) {
      country = commaParts[commaParts.length - 1];
      body = commaParts.slice(0, commaParts.length - 1).join(', ');
    }

    // Split city / state on the " - " separator.
    const dashParts = body.split(/\s[-–]\s/).map((p) => this.cleanText(p)).filter((p): p is string => !!p);
    let cityRaw = dashParts[0] ?? body;
    const state = dashParts.length > 1 ? dashParts[dashParts.length - 1] : null;

    // Strip a parenthesised département / postcode token from the city.
    const city = this.cleanText(cityRaw.replace(/\s*\([^)]*\)\s*/g, ' '));

    return { city: city || null, state: state || null, country: country || null };
  }

  /** Detect remote roles from the title, location, employment-type, or body text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    employmentType: string | null | undefined,
    body: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, employmentType, body];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (CLEVERCONNECT_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^(remote|t[ée]l[ée]travail)$/i.test(value.trim());
  }

  /**
   * Parse an ISO-8601 publication timestamp into a `YYYY-MM-DD` string. Non-parseable
   * values yield null rather than throwing.
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
