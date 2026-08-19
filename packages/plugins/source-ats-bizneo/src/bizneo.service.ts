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
  BIZNEO_ROOT_DOMAIN,
  BIZNEO_HOST_TEMPLATE,
  BIZNEO_JOBS_PATH,
  BIZNEO_DEFAULT_RESULTS,
  BIZNEO_MAX_PAGES,
  BIZNEO_HEADERS,
  BIZNEO_JOB_LINK_REGEX,
  BIZNEO_JSONLD_REGEX,
  BIZNEO_REMOTE_REGEX,
} from './bizneo.constants';
import {
  BizneoBoardJob,
  BizneoJob,
  BizneoJobPosting,
  BizneoJobLocation,
  BizneoPostalAddress,
} from './bizneo.types';

/**
 * Bizneo HR ATS careers scraper — generic, multi-tenant.
 *
 * Bizneo HR (bizneo.com, Spain) powers each customer's branded Career Site on the
 * shared platform host `https://{tenant}.bizneo.com/jobs`. That board's open-roles
 * index is server-rendered enough to enumerate roles — each open vacancy renders as
 * a `/jobs/{slug}` anchor alongside labelled card text (title, a location line, an
 * optional brand label, and an "On-site" / "Remote" / "Hybrid" work-mode token) —
 * but each per-role detail body is hydrated client-side. So rather than depend on
 * the JS-rendered detail DOM, the adapter parses the server-rendered index and uses
 * the `{slug}` segment (the stable per-role token) as the ATS id, with the
 * canonical detail / apply URL `https://{tenant}.bizneo.com/jobs/{slug}`. When the
 * board happens to server-render a schema.org `JobPosting` JSON-LD block it is used
 * as a defensive enrichment over the card text.
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g.
 * `groundforce`) or by `companyUrl` (a board URL whose first sub-domain label is
 * the tenant, or a bare `bizneo.com` host used verbatim). An unknown tenant (or one
 * with no open roles) renders an empty board, so it degrades naturally to an empty
 * result. A fetch error, an HTTP 4xx, a DNS failure, or a malformed body degrades
 * to an empty / partial result rather than throwing, so a single bad tenant never
 * nukes a batch run.
 */
@SourcePlugin({
  site: Site.BIZNEO,
  name: 'Bizneo HR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class BizneoService implements IScraper {
  private readonly logger = new Logger(BizneoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Bizneo scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve a Bizneo careers host from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(BIZNEO_HEADERS);

    const resultsWanted = input.resultsWanted ?? BIZNEO_DEFAULT_RESULTS;
    const tenant = this.deriveTenant(companySlug, host);
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Bizneo jobs board from: ${host}`);

      // Walk the board surface (single page in practice) until we have enough roles.
      const items = await this.fetchJobList(client, host, resultsWanted, seen);
      if (items.length === 0) {
        this.logger.log(`Bizneo tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      for (const item of items) {
        try {
          const post = this.processItem(item, host, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Bizneo role ${item.slug}: ${err.message}`);
        }
      }

      this.logger.log(`Bizneo total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Bizneo scrape error for ${host}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch + parse the tenant's board HTML, accumulating up to `resultsWanted`
   * deduped roles. The board renders the full open-roles list in one document; the
   * page loop guards against any future server-side pagination. An unknown tenant
   * renders an empty board; an HTTP 4xx or a missing body degrades to an empty list.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<BizneoBoardJob[]> {
    const items: BizneoBoardJob[] = [];
    const base = `${host}${BIZNEO_JOBS_PATH}`;

    for (let page = 1; page <= BIZNEO_MAX_PAGES; page++) {
      const url = page === 1 ? base : `${base}?page=${page}`;
      const html = await this.fetchHtml(client, url, host);
      if (html == null) break;

      const parsed = this.parseBoard(html, host);
      let added = 0;
      for (const role of parsed) {
        const slug = this.cleanText(role.slug);
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        items.push(role);
        added++;
        if (items.length >= resultsWanted) return items;
      }

      // The board is single-document; stop once a page yields no new roles.
      if (added === 0) break;
    }

    return items;
  }

  /** GET a board URL as text; an HTTP 4xx / DNS failure degrades to null (no throw). */
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
        this.logger.warn(`Bizneo board not found (HTTP ${status}) for ${host}`);
        return null;
      }
      // 5xx / network / DNS error — degrade gracefully rather than throwing.
      this.logger.warn(`Bizneo board fetch failed for ${host}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse the server-rendered board HTML into role fragments. Rather than depend on
   * volatile CSS class names, we anchor on the canonical job links (`/jobs/{slug}`)
   * and read the labelled card text immediately around each link (title heading,
   * location line, optional brand label, "On-site" / "Remote" / "Hybrid" token).
   */
  private parseBoard(html: string, host: string): BizneoBoardJob[] {
    const out: BizneoBoardJob[] = [];
    const bySlug = new Map<string, BizneoBoardJob>();

    // Optional document-level schema.org enrichment, when the board emits one.
    const postingsByUrl = this.collectPostings(html);

    BIZNEO_JOB_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BIZNEO_JOB_LINK_REGEX.exec(html)) !== null) {
      const slug = this.cleanText(match[1]);
      // Skip facet / utility links that are not a real role slug.
      if (!slug || this.isReservedSlug(slug)) continue;
      if (bySlug.has(slug)) continue;

      const url = `${host}${BIZNEO_JOBS_PATH}/${slug}`;
      const windowText = this.cardWindow(html, match.index);
      const posting = postingsByUrl.get(slug) ?? null;
      const address = this.firstAddress(posting?.jobLocation);

      const role: BizneoBoardJob = {
        slug,
        url,
        title:
          this.cleanText(posting?.title) ??
          this.titleFromWindow(windowText) ??
          this.titleFromSlug(slug),
        location:
          this.fieldFromWindow(windowText, 'Location|Ubicaci[oó]n|Localizaci[oó]n') ??
          this.addressText(address),
        brand: this.fieldFromWindow(windowText, 'Brand|Marca'),
        workMode: this.workModeFromWindow(windowText),
      };

      bySlug.set(slug, role);
      out.push(role);
    }

    return out;
  }

  /**
   * Scan every server-rendered `application/ld+json` block for `JobPosting` nodes
   * and key them by the trailing `/jobs/{slug}` token of their `url`. Most Bizneo
   * boards hydrate detail data client-side and emit no per-role JSON-LD, so this map
   * is usually empty — it is a defensive enrichment, never a dependency.
   */
  private collectPostings(html: string): Map<string, BizneoJobPosting> {
    const bySlug = new Map<string, BizneoJobPosting>();
    const re = new RegExp(BIZNEO_JSONLD_REGEX.source, 'gi');
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
      for (const posting of this.extractPostings(parsed)) {
        const slug = this.slugFromUrl(posting.url);
        if (slug && !bySlug.has(slug)) bySlug.set(slug, posting);
      }
    }
    return bySlug;
  }

  /** Recursively collect every `JobPosting` node within a parsed JSON-LD value. */
  private extractPostings(value: unknown): BizneoJobPosting[] {
    const found: BizneoJobPosting[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (this.isJobPostingType(obj['@type'])) found.push(obj as BizneoJobPosting);
        if (Array.isArray(obj['@graph'])) visit(obj['@graph']);
        if (Array.isArray(obj['itemListElement'])) visit(obj['itemListElement']);
        if (obj['item']) visit(obj['item']);
      }
    };
    visit(value);
    return found;
  }

  /** Extract the trailing `/jobs/{slug}` token from a JSON-LD `url`, when present. */
  private slugFromUrl(url: string | undefined): string | null {
    const cleaned = this.cleanText(url);
    if (!cleaned) return null;
    const m = /\/jobs\/([a-z0-9][a-z0-9._~-]*)/i.exec(cleaned);
    return m ? this.cleanText(m[1]) : null;
  }

  /** Flatten a schema.org address into a single comma-joined location line. */
  private addressText(address: BizneoPostalAddress | null): string | null {
    if (!address) return null;
    const parts = [
      this.cleanText(address.addressLocality),
      this.cleanText(address.addressRegion),
      this.countryName(address.addressCountry),
    ].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /** Resolve the country display value (a bare code/name, or an object with `name`). */
  private countryName(country: BizneoPostalAddress['addressCountry']): string | null {
    if (!country) return null;
    if (typeof country === 'string') return this.cleanText(country);
    return this.cleanText(country.name);
  }

  /**
   * Extract a window of plain text around a job link, used to recover the card's
   * labelled fields. The board renders the card's fields close to its anchor, so a
   * bounded slice on either side captures them without bleeding into siblings.
   */
  private cardWindow(html: string, index: number): string {
    const start = Math.max(0, index - 600);
    const end = Math.min(html.length, index + 1200);
    return htmlToPlainText(html.slice(start, end)) ?? '';
  }

  /**
   * Recover the role title from the card window. The card heading text is the most
   * prominent non-label line near the anchor; we take the first reasonably-long
   * line that is not a known label or work-mode token.
   */
  private titleFromWindow(windowText: string): string | null {
    if (!windowText) return null;
    const lines = windowText
      .split(/[\r\n]+/)
      .map((l) => this.cleanText(l))
      .filter((l): l is string => !!l);
    for (const line of lines) {
      if (this.isWorkModeToken(line)) continue;
      if (/^(Location|Ubicaci[oó]n|Localizaci[oó]n|Brand|Marca|Apply|Aplicar|Inscribirse)\b/i.test(line)) {
        continue;
      }
      if (line.length >= 3 && line.length <= 160) return line;
    }
    return null;
  }

  /**
   * Read a labelled card field (e.g. "Location Madrid") out of the card window,
   * stopping at the next known label or a line break. The `label` is an alternation
   * of localised label spellings.
   */
  private fieldFromWindow(windowText: string, label: string): string | null {
    if (!windowText) return null;
    const re = new RegExp(
      `(?:${label})\\s*:?\\s*(.+?)(?:\\s*(?:Location|Ubicaci[oó]n|Localizaci[oó]n|Brand|Marca|On-?site|Remote|Remoto|Hybrid|H[ií]brido|Apply|Aplicar|Inscribirse)\\b|[\\r\\n]|$)`,
      'i',
    );
    const m = re.exec(windowText);
    return m ? this.cleanText(m[1]) : null;
  }

  /** Recover the "On-site" / "Remote" / "Hybrid" work-mode token from the card window. */
  private workModeFromWindow(windowText: string): string | null {
    if (!windowText) return null;
    const m = /\b(On-?site|Remote|Remoto|Hybrid|H[ií]brido|Presencial|Teletrabajo)\b/i.exec(windowText);
    return m ? this.cleanText(m[1]) : null;
  }

  /** True when a line is a bare work-mode token rather than a title / field. */
  private isWorkModeToken(value: string): boolean {
    return /^(On-?site|Remote|Remoto|Hybrid|H[ií]brido|Presencial|Teletrabajo)$/i.test(value.trim());
  }

  /**
   * Reserved `/jobs/...` path tokens that are board chrome / facets, not real role
   * slugs (defensive — keeps utility links out of the result set).
   */
  private isReservedSlug(slug: string): boolean {
    return /^(new|search|filter|all|index|page|preferences|settings)$/i.test(slug);
  }

  /** Map a parsed board role → JobPostDto. */
  private processItem(
    item: BizneoBoardJob,
    host: string,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const job = this.normaliseJob(item, host, tenant);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised BizneoJob from a parsed board role. */
  private normaliseJob(item: BizneoBoardJob, host: string, tenant: string): BizneoJob {
    const slug = this.cleanText(item.slug) ?? '';
    const title = this.cleanText(item.title);
    const locationText = this.cleanText(item.location);
    const { city, state, country } = this.splitLocation(locationText);

    return {
      slug,
      url: this.cleanText(item.url) ?? `${host}${BIZNEO_JOBS_PATH}/${slug}`,
      title,
      companyName: this.deriveCompanyName(item.brand, tenant),
      city,
      state,
      country,
      locationText,
      department: this.cleanText(item.brand),
      employmentType: null,
      datePosted: null,
      isRemote: this.detectRemote(title, locationText, item.workMode),
    };
  }

  /** Map a normalised BizneoJob → JobPostDto. */
  private processJob(
    job: BizneoJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.slug ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(null, tenant);
    // The board exposes no full job-ad body on the index (the detail body is
    // hydrated client-side); the location line is the best listing-level
    // descriptive text we can offer, formatted per the request.
    const description = this.formatDescription(
      job.descriptionHtml ?? null,
      job.locationText ?? null,
      format,
    );

    return new JobPostDto({
      id: `bizneo-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.BIZNEO,
      atsId,
      atsType: 'bizneo',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the descriptive text per `descriptionFormat`. Prefer a JSON-LD HTML
   * body when one was recovered; otherwise the plain location line is surfaced
   * as-is for every format.
   */
  private formatDescription(
    html: string | null,
    text: string | null,
    format?: DescriptionFormat,
  ): string | null {
    if (html) {
      if (format === DescriptionFormat.HTML) return html;
      if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
      return htmlToPlainText(html) ?? html;
    }
    if (!text) return null;
    if (format === DescriptionFormat.HTML) return text;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(text) ?? text;
    return htmlToPlainText(text) ?? text;
  }

  /**
   * Resolve the tenant board host. An explicit `companySlug` is expanded into the
   * canonical `{tenant}.bizneo.com` host (a bare host passed as the slug is used
   * verbatim); a `companyUrl` on a `bizneo.com` host has its origin used verbatim.
   * Returns an empty string when neither yields a host.
   */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      const fromUrl = this.hostFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim().toLowerCase();
      // A caller may also pass a full board URL or a bare host as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(BIZNEO_ROOT_DOMAIN)) {
        const fromUrl = this.hostFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return BIZNEO_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(slug));
    }
    return '';
  }

  /**
   * Derive a board origin from a Bizneo URL / bare host. The candidate-facing forms
   * are `https://{tenant}.bizneo.com/jobs` and `https://jobs.{tenant}.bizneo.com/jobs`.
   * Returns the origin (protocol + host) verbatim when the host is on `bizneo.com`.
   */
  private hostFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (hostname === BIZNEO_ROOT_DOMAIN || hostname.endsWith(`.${BIZNEO_ROOT_DOMAIN}`)) {
        // The platform marketing host carries no tenant board — reject it.
        if (hostname === BIZNEO_ROOT_DOMAIN || hostname === `www.${BIZNEO_ROOT_DOMAIN}`) {
          return '';
        }
        return `${u.protocol}//${u.host}`;
      }
    } catch {
      // Malformed URL — no host.
    }
    return '';
  }

  /** Derive the tenant token (sub-domain label) from the slug or resolved host. */
  private deriveTenant(companySlug: string | undefined, host: string): string {
    if (companySlug && companySlug.trim() && !companySlug.includes('.') && !/^https?:\/\//i.test(companySlug)) {
      return companySlug.trim().toLowerCase();
    }
    try {
      const labels = new URL(host).hostname.toLowerCase().split('.');
      // `{tenant}.bizneo.com` → labels[0]; `jobs.{tenant}.bizneo.com` → labels[1].
      if (labels.length >= 4 && labels[0] === 'jobs') return labels[1];
      return labels[0] || '';
    } catch {
      return companySlug?.trim().toLowerCase() || host;
    }
  }

  /** De-slugify + title-case a brand label / tenant token into a display company name. */
  private deriveCompanyName(brand: string | null | undefined, tenant: string): string {
    const base = (typeof brand === 'string' && brand.trim() ? brand.trim() : tenant) || tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Turn a job slug (e.g. `agentes-de-rampa-aeropuerto`) into a readable title. */
  private titleFromSlug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    if (!cleaned) return null;
    // Strip a trailing UUID (some slugs carry one) before de-slugifying.
    const withoutUuid = cleaned.replace(
      /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      '',
    );
    return withoutUuid.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present. Bizneo renders a single free-text location line
   * (e.g. "Madrid" or "Málaga, España"); we keep the trailing token as country and
   * the leading text as city, best-effort.
   */
  private extractLocation(job: BizneoJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state /
   * country. A comma-separated tail is treated as the country; the head as the city.
   */
  private splitLocation(
    text: string | null,
  ): { city: string | null; state: string | null; country: string | null } {
    if (!text || this.isRemoteToken(text)) {
      return { city: null, state: null, country: null };
    }
    const parts = text
      .split(',')
      .map((p) => this.cleanText(p))
      .filter((p): p is string => !!p);
    if (parts.length === 0) return { city: null, state: null, country: null };
    if (parts.length === 1) return { city: parts[0], state: null, country: null };
    const country = parts[parts.length - 1];
    const city = parts.slice(0, parts.length - 1).join(', ');
    return { city: city || null, state: null, country: country || null };
  }

  /** Detect remote roles from the title, location, or work-mode text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    workMode: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, workMode];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (BIZNEO_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" / "Remoto" marker, not a place. */
  private isRemoteToken(value: string): boolean {
    return /^(remote|remoto|teletrabajo)$/i.test(value.trim());
  }

  /** True when a JSON-LD `@type` value names a JobPosting. */
  private isJobPostingType(type: unknown): boolean {
    if (typeof type === 'string') return type.toLowerCase() === 'jobposting';
    if (Array.isArray(type)) {
      return type.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
    }
    return false;
  }

  /** Return the first `PostalAddress` from a `jobLocation` (object or array). */
  private firstAddress(
    jobLocation: BizneoJobLocation | BizneoJobLocation[] | null | undefined,
  ): BizneoPostalAddress | null {
    if (!jobLocation) return null;
    const first = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
    const address = first?.address;
    return address && typeof address === 'object' ? address : null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
