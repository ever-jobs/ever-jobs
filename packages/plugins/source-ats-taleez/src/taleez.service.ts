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
  TALEEZ_BASE,
  TALEEZ_ROOT_DOMAIN,
  TALEEZ_CAREERS_PATH,
  TALEEZ_APPLY_PATH,
  TALEEZ_DEFAULT_RESULTS,
  TALEEZ_MAX_PAGES,
  TALEEZ_HEADERS,
  TALEEZ_APPLY_LINK_REGEX,
  TALEEZ_JSONLD_REGEX,
  TALEEZ_OG_TITLE_REGEX,
  TALEEZ_OG_DESCRIPTION_REGEX,
  TALEEZ_OG_URL_REGEX,
  TALEEZ_TITLE_TAG_REGEX,
  TALEEZ_REMOTE_REGEX,
} from './taleez.constants';
import {
  TaleezJob,
  TaleezJobLink,
  TaleezJobPostingLd,
  TaleezPlace,
  TaleezPostalAddress,
} from './taleez.types';

/**
 * Taleez (taleez.com, France) ATS careers scraper — generic, multi-tenant.
 *
 * Taleez powers each customer's branded, public, unauthenticated candidate-facing
 * careers board on the shared host, addressed by the tenant token as a sub-domain
 * (`https://{tenant}.taleez.com/`) or a path (`https://taleez.com/careers/{tenant}`).
 * The board shell is server-rendered but its role *list* is client-rendered (an
 * Angular SPA), so the adapter harvests the canonical detail / apply anchors
 * (`https://taleez.com/apply/{slug}`) from the board HTML, dedupes by `{slug}`, and
 * fetches each role's **fully server-rendered** detail page, parsing its schema.org
 * `JobPosting` JSON-LD (with `og:` / `<title>` / body fallbacks). The JSON-LD
 * `identifier.value` is the role `{slug}` — Taleez's stable ATS id.
 *
 * The caller addresses a tenant by `companySlug` (the tenant token, e.g. `tehtris`)
 * or by `companyUrl` (a board URL whose host / path encodes the tenant, or a direct
 * `…/apply/{slug}` role URL). A board with no harvestable anchors (the common SPA
 * case) degrades naturally to an empty result. A fetch error, an HTTP 4xx, a DNS
 * failure, or a malformed body degrades to an empty / partial result rather than
 * throwing, so a single bad tenant never nukes a batch run.
 *
 * Surface verified live 2026-06-03 (no authentication): tenant `tehtris` (TEHTRIS)
 * on `https://tehtris.taleez.com/`, and the server-rendered detail surface
 * `https://taleez.com/apply/{slug}` with its `JobPosting` JSON-LD.
 */
@SourcePlugin({
  site: Site.TALEEZ,
  name: 'Taleez',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TaleezService implements IScraper {
  private readonly logger = new Logger(TaleezService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Taleez scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Taleez tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TALEEZ_HEADERS);

    const resultsWanted = input.resultsWanted ?? TALEEZ_DEFAULT_RESULTS;

    try {
      this.logger.log(`Fetching Taleez jobs for tenant: ${tenant}`);

      // 1) Collect role links: either a single direct /apply/{slug} URL, or the
      //    anchors harvested from the tenant board HTML.
      const links = await this.collectJobLinks(client, tenant, companySlug, input.companyUrl, resultsWanted);
      if (links.length === 0) {
        this.logger.log(`Taleez tenant "${tenant}" yielded no role links`);
        return new JobResponseDto([]);
      }

      // 2) Fetch + parse each role's detail page (JSON-LD). Fan-out with allSettled
      //    so one bad role never fails the batch.
      const settled = await Promise.allSettled(
        links.map((link) => this.fetchAndProcess(client, link, tenant, input.descriptionFormat)),
      );

      const jobPosts: JobPostDto[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) jobPosts.push(r.value);
        else if (r.status === 'rejected') {
          this.logger.warn(`Error processing Taleez role: ${r.reason?.message ?? r.reason}`);
        }
      }

      this.logger.log(`Taleez total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Taleez scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Build the set of role links to fetch. When the input addresses a single role
   * directly (a `…/apply/{slug}` URL), that one link is used. Otherwise the tenant
   * board HTML is walked for canonical `…/apply/{slug}` anchors, deduped by `{slug}`,
   * and sliced to `resultsWanted`.
   */
  private async collectJobLinks(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    companySlug: string | undefined,
    companyUrl: string | undefined,
    resultsWanted: number,
  ): Promise<TaleezJobLink[]> {
    // Direct single-role addressing: a /apply/{slug} URL passed as slug or url.
    const directSlug =
      this.applySlugFromUrl(companyUrl) ?? this.applySlugFromUrl(companySlug);
    if (directSlug) {
      return [{ slug: directSlug, url: this.buildApplyUrl(directSlug) }];
    }

    return this.fetchBoardLinks(client, tenant, resultsWanted);
  }

  /**
   * Fetch + parse the tenant board HTML, accumulating up to `resultsWanted` deduped
   * role links. The board renders its list client-side, so in the common case it
   * yields no anchors and we return an empty list (degrades to an empty result); the
   * page loop guards any future server-side pagination.
   */
  private async fetchBoardLinks(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    resultsWanted: number,
  ): Promise<TaleezJobLink[]> {
    const links: TaleezJobLink[] = [];
    const seen = new Set<string>();

    for (const base of this.boardUrls(tenant)) {
      for (let page = 1; page <= TALEEZ_MAX_PAGES; page++) {
        const url = page === 1 ? base : `${base}${base.includes('?') ? '&' : '?'}page=${page}`;
        const html = await this.fetchHtml(client, url, tenant);
        if (html == null) break;

        let added = 0;
        for (const link of this.parseBoardLinks(html)) {
          if (seen.has(link.slug)) continue;
          seen.add(link.slug);
          links.push(link);
          added++;
          if (links.length >= resultsWanted) return links;
        }

        // Single-document board — stop once a page yields no new roles.
        if (added === 0) break;
      }
      if (links.length > 0) break; // first board form that yields links wins
    }

    return links;
  }

  /** Candidate board URLs for a tenant: the sub-domain form, then the path form. */
  private boardUrls(tenant: string): string[] {
    const t = encodeURIComponent(tenant);
    return [`https://${t}.${TALEEZ_ROOT_DOMAIN}/`, `${TALEEZ_BASE}${TALEEZ_CAREERS_PATH}${t}`];
  }

  /** GET a URL as text; an HTTP 4xx / DNS failure degrades to null (no throw). */
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
        this.logger.warn(`Taleez page not found (HTTP ${status}) for ${tenant}: ${url}`);
        return null;
      }
      this.logger.warn(`Taleez page fetch failed for ${tenant} (${url}): ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Harvest canonical `https://taleez.com/apply/{slug}` anchors from board HTML,
   * deduping by `{slug}`. Anchored on the URL shape rather than volatile CSS classes.
   */
  private parseBoardLinks(html: string): TaleezJobLink[] {
    const out: TaleezJobLink[] = [];
    const seen = new Set<string>();

    TALEEZ_APPLY_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TALEEZ_APPLY_LINK_REGEX.exec(html)) !== null) {
      const slug = this.cleanText(match[1]);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      out.push({ slug, url: this.buildApplyUrl(slug) });
    }

    return out;
  }

  /** Fetch a role's detail page and map it to a JobPostDto (null on any miss). */
  private async fetchAndProcess(
    client: ReturnType<typeof createHttpClient>,
    link: TaleezJobLink,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const html = await this.fetchHtml(client, link.url, tenant);
    if (html == null) return null;

    const ld = this.extractJobPostingLd(html);
    const job = this.normaliseJob(link, ld, html, tenant);
    return this.processJob(job, tenant, format);
  }

  /**
   * Extract the schema.org `JobPosting` JSON-LD object from a detail page. Tolerates
   * multiple JSON-LD blocks and `@graph` envelopes; returns null when none parse.
   */
  private extractJobPostingLd(html: string): TaleezJobPostingLd | null {
    TALEEZ_JSONLD_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TALEEZ_JSONLD_REGEX.exec(html)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      const parsed = this.safeJsonParse(raw);
      const posting = this.findJobPosting(parsed);
      if (posting) return posting;
    }
    return null;
  }

  /** Recursively locate a `JobPosting` node within a parsed JSON-LD value. */
  private findJobPosting(value: unknown): TaleezJobPostingLd | null {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = this.findJobPosting(entry);
        if (found) return found;
      }
      return null;
    }
    const obj = value as Record<string, unknown>;
    const type = obj['@type'];
    const isPosting = Array.isArray(type)
      ? type.some((t) => typeof t === 'string' && /JobPosting/i.test(t))
      : typeof type === 'string' && /JobPosting/i.test(type);
    if (isPosting) return obj as TaleezJobPostingLd;
    if (Array.isArray(obj['@graph'])) {
      return this.findJobPosting(obj['@graph']);
    }
    return null;
  }

  /** Parse a JSON-LD string defensively; returns null on any error. */
  private safeJsonParse(raw: string): unknown {
    try {
      return JSON.parse(raw.trim());
    } catch {
      return null;
    }
  }

  /** Build a normalised TaleezJob from a role link + its JSON-LD (with HTML fallbacks). */
  private normaliseJob(
    link: TaleezJobLink,
    ld: TaleezJobPostingLd | null,
    html: string,
    tenant: string,
  ): TaleezJob {
    const title =
      this.cleanText(ld?.title) ??
      this.cleanText(this.matchGroup(html, TALEEZ_OG_TITLE_REGEX)) ??
      this.titleFromTag(html);

    const companyName =
      this.cleanText(ld?.hiringOrganization?.name) ??
      this.cleanText(this.identifierName(ld)) ??
      this.deriveCompanyName(tenant);

    const descriptionHtml = this.joinHtml(
      this.cleanText(ld?.description),
      this.cleanText(ld?.qualifications),
    ) ?? this.cleanText(this.matchGroup(html, TALEEZ_OG_DESCRIPTION_REGEX));

    const { city, state, country } = this.extractAddress(ld);

    return {
      slug: link.slug,
      url: this.cleanText(ld?.url) ?? this.cleanText(this.matchGroup(html, TALEEZ_OG_URL_REGEX)) ?? link.url,
      title,
      companyName,
      description: descriptionHtml,
      city,
      state,
      country,
      department: this.cleanText(ld?.industry),
      employmentType: this.normaliseEmploymentType(ld?.employmentType),
      datePosted: this.parseDate(ld?.datePosted),
      isRemote: this.detectRemote(title, `${city ?? ''} ${state ?? ''} ${country ?? ''}`, ld?.jobLocationType),
    };
  }

  /** Map a normalised TaleezJob → JobPostDto. */
  private processJob(
    job: TaleezJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = this.cleanText(job.slug);
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    const description = this.formatDescription(job.description ?? null, format);

    return new JobPostDto({
      id: `taleez-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.TALEEZ,
      atsId,
      atsType: 'taleez',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the description body per `descriptionFormat`. The body is HTML (the
   * JSON-LD `description` / `qualifications`), so HTML returns it as-is, Markdown
   * converts it, and Plain (default) strips it to text.
   */
  private formatDescription(htmlBody: string | null, format?: DescriptionFormat): string | null {
    if (!htmlBody) return null;
    if (format === DescriptionFormat.HTML) return htmlBody;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(htmlBody) ?? htmlBody;
    return htmlToPlainText(htmlBody) ?? htmlBody;
  }

  /**
   * Resolve the tenant token. An explicit `companySlug` is used directly (a board /
   * apply URL passed as the slug is reduced to its tenant token); a `companyUrl` on a
   * `taleez.com` host has the tenant taken from its host / path. Returns an empty
   * string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (/^https?:\/\//i.test(slug) || slug.includes(TALEEZ_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Taleez URL. Candidate-facing forms:
   *   https://{tenant}.taleez.com/...        → sub-domain label
   *   https://taleez.com/careers/{tenant}    → path segment
   *   https://taleez.com/apply/{slug}        → tenant token derived from the slug tail
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(TALEEZ_ROOT_DOMAIN)) return '';

      const labels = hostname.split('.');
      // {tenant}.taleez.com → leading label (excluding bare apex / www / app / jobs / api).
      if (labels.length > 2) {
        const sub = labels[0];
        if (sub && !['www', 'app', 'api', 'jobs'].includes(sub)) {
          return decodeURIComponent(sub).toLowerCase();
        }
      }

      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      if (segments.length === 0) return '';
      const first = segments[0].toLowerCase();

      // /careers/{tenant}
      if (first === 'careers' && segments.length > 1) {
        return decodeURIComponent(segments[1]).toLowerCase();
      }
      // /apply/{slug} — no explicit tenant; use the slug's last hyphen token as a
      // best-effort tenant label so a board fetch can still be attempted.
      if (first === 'apply' && segments.length > 1) {
        const slug = decodeURIComponent(segments[1]).toLowerCase();
        const parts = slug.split('-').filter((p) => p.length > 0);
        return parts.length > 0 ? parts[parts.length - 1] : slug;
      }
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /**
   * Extract a `{slug}` from a `…/taleez.com/apply/{slug}` URL (ignoring an optional
   * `/applying` suffix and any query / fragment). Returns null when the value is not
   * such a URL.
   */
  private applySlugFromUrl(value: string | undefined): string | null {
    if (!value) return null;
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      if (!u.hostname.toLowerCase().endsWith(TALEEZ_ROOT_DOMAIN)) return null;
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      if (segments.length >= 2 && segments[0].toLowerCase() === 'apply') {
        return this.cleanText(decodeURIComponent(segments[1]).toLowerCase());
      }
    } catch {
      // not a URL
    }
    return null;
  }

  /** Build the canonical public detail / apply URL for a role slug. */
  private buildApplyUrl(slug: string): string {
    return `${TALEEZ_BASE}${TALEEZ_APPLY_PATH}${slug}`;
  }

  /** Read the JSON-LD `identifier.value` / name (the role slug / brand). */
  private identifierName(ld: TaleezJobPostingLd | null): string | null {
    const id = ld?.identifier;
    if (!id) return null;
    if (typeof id === 'string') return id;
    return this.cleanText(id.name);
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Read the `<title>` tag as a last-resort title, stripping a Taleez prefix. */
  private titleFromTag(html: string): string | null {
    const raw = this.cleanText(this.matchGroup(html, TALEEZ_TITLE_TAG_REGEX));
    if (!raw) return null;
    // Strip a leading "Offre d'emploi - " / "Job - " prefix when present.
    return this.cleanText(raw.replace(/^(?:offre d'emploi|job)\s*[-–]\s*/i, ''));
  }

  /** First capture group of a regex against the HTML, or null. */
  private matchGroup(html: string, re: RegExp): string | null {
    const m = re.exec(html);
    return m ? m[1] : null;
  }

  /** Join two HTML fragments (body + qualifications) into one block. */
  private joinHtml(a: string | null, b: string | null): string | null {
    if (a && b) return `${a}\n${b}`;
    return a ?? b ?? null;
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: TaleezJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Extract city / state / country from the JSON-LD `jobLocation.address`, tolerating
   * a single `Place` or an array (the first usable address wins) and a string or
   * object `addressCountry`.
   */
  private extractAddress(
    ld: TaleezJobPostingLd | null,
  ): { city: string | null; state: string | null; country: string | null } {
    const empty = { city: null, state: null, country: null };
    const loc = ld?.jobLocation;
    if (!loc) return empty;
    const places: TaleezPlace[] = Array.isArray(loc) ? loc : [loc];
    for (const place of places) {
      const addr: TaleezPostalAddress | null | undefined = place?.address;
      if (!addr) continue;
      const city = this.cleanText(addr.addressLocality);
      const state = this.cleanText(addr.addressRegion);
      const country = this.cleanText(this.countryName(addr.addressCountry));
      if (city || state || country) return { city, state, country };
    }
    return empty;
  }

  /** Normalise an `addressCountry` (string or `{ name }`) to a string. */
  private countryName(value: TaleezPostalAddress['addressCountry']): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value;
    return this.cleanText(value.name);
  }

  /** Detect remote roles from the title, location, or `jobLocationType`. */
  private detectRemote(
    title: string | null | undefined,
    location: string | null | undefined,
    jobLocationType: string | null | undefined,
  ): boolean {
    if (typeof jobLocationType === 'string' && /telecommute/i.test(jobLocationType)) return true;
    for (const field of [title, location, jobLocationType]) {
      if (typeof field !== 'string') continue;
      if (TALEEZ_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Normalise a schema.org employment-type token (e.g. `FULL_TIME`, `PART_TIME`,
   * `CONTRACTOR`) — or an array of them — into a readable, title-cased label.
   */
  private normaliseEmploymentType(value: string | string[] | null | undefined): string | null {
    const first = Array.isArray(value) ? value.find((v) => !!this.cleanText(v)) : value;
    const cleaned = this.cleanText(first);
    if (!cleaned) return null;
    return cleaned
      .replace(/[_]+/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Parse an ISO 8601 `datePosted` into a `YYYY-MM-DD` string. */
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
