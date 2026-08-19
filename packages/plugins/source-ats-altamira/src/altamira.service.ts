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
  ALTAMIRA_ROOT_DOMAIN,
  ALTAMIRA_HOST_TEMPLATE,
  ALTAMIRA_JOBS_PATH,
  ALTAMIRA_DEFAULT_RESULTS,
  ALTAMIRA_MAX_PAGES,
  ALTAMIRA_HEADERS,
  ALTAMIRA_SEO_LINK_REGEX,
  ALTAMIRA_QUERY_LINK_REGEX,
  ALTAMIRA_REMOTE_REGEX,
} from './altamira.constants';
import { AltamiraIndexJob, AltamiraJob } from './altamira.types';

/**
 * Altamira Recruiting careers scraper — generic, multi-tenant.
 *
 * Altamira (altamirahrm.com, Italy) powers each customer's branded career site on a
 * sub-domain of the shared host `altamiraweb.com`, e.g.
 * `https://{tenant}.altamiraweb.com/` (and a newer `https://{tenant}.sites.altamiraweb.com/`
 * variant). The board is server-rendered HTML, so the adapter consumes the public,
 * unauthenticated open-roles index at `/jobs`, which lists every open role as an
 * anchor in one of two interchangeable forms:
 *
 *   SEO form:   /jobs/{Title-Country-Region-City-slug}-{JobID}.htm
 *   query form: /jobs/job-details?JobID={JobID}
 *
 * The trailing numeric `{JobID}` is the stable ATS id; the SEO `.htm` slug also
 * encodes the role title and a `Country-Region-City` location tail. The `.htm` page
 * is the canonical detail / apply URL. No JSON-LD or `og:` meta is emitted, so the
 * title + location come from the anchor slug (always present) and the description is
 * enriched best-effort from the detail page body.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `etinars`) or by `companyUrl`
 * (a careers URL on an `altamiraweb.com` host whose sub-domain is the tenant). An
 * unknown tenant (or one with no open roles) renders an empty board, so it degrades
 * naturally to an empty result. A fetch error, an HTTP 4xx, a DNS failure, or a
 * malformed body degrades to an empty / partial result rather than throwing, so a
 * single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.ALTAMIRA,
  name: 'Altamira',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class AltamiraService implements IScraper {
  private readonly logger = new Logger(AltamiraService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Altamira scraper');
      return new JobResponseDto([]);
    }

    const origin = this.resolveOrigin(companySlug, input.companyUrl);
    if (!origin) {
      this.logger.warn('Could not resolve an Altamira tenant host from input');
      return new JobResponseDto([]);
    }
    const tenant = this.tenantLabel(origin);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(ALTAMIRA_HEADERS);

    const resultsWanted = input.resultsWanted ?? ALTAMIRA_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Altamira jobs for tenant: ${tenant}`);

      // Walk the index surface until we have enough roles.
      const items = await this.fetchJobList(client, origin, resultsWanted, seen);
      if (items.length === 0) {
        this.logger.log(`Altamira tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Enrich each role's description from its detail page — best-effort, in
      // parallel, tolerating per-role failures (Promise.allSettled, never .all).
      const settled = await Promise.allSettled(
        items.map((item) => this.enrichDescription(client, item)),
      );
      const descriptions = settled.map((r) =>
        r.status === 'fulfilled' ? r.value : null,
      );

      for (let i = 0; i < items.length; i++) {
        try {
          const post = this.processItem(
            items[i],
            origin,
            tenant,
            descriptions[i],
            input.descriptionFormat,
          );
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Altamira role ${items[i].id}: ${err.message}`);
        }
      }

      this.logger.log(`Altamira total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Altamira scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch + parse the tenant's index HTML, accumulating up to `resultsWanted`
   * deduped roles. The index can paginate (`?PagerAnnunci={n}`); we walk pages until
   * we have enough roles or a page yields no new ones. An unknown tenant renders an
   * empty board; an HTTP 4xx or a missing body degrades to an empty list.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    origin: string,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<AltamiraIndexJob[]> {
    const items: AltamiraIndexJob[] = [];
    const base = `${origin}${ALTAMIRA_JOBS_PATH}`;

    for (let page = 1; page <= ALTAMIRA_MAX_PAGES; page++) {
      const url = page === 1 ? base : `${base}?PagerAnnunci=${page}`;
      const html = await this.fetchHtml(client, url, origin);
      if (html == null) break;

      const parsed = this.parseIndex(html, origin);
      let added = 0;
      for (const role of parsed) {
        const id = this.cleanText(role.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push(role);
        added++;
        if (items.length >= resultsWanted) return items;
      }

      // Stop once a page yields no new roles (end of pagination, or single-document board).
      if (added === 0) break;
    }

    return items;
  }

  /** GET a board URL as text; an HTTP 4xx / DNS failure degrades to null (no throw). */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    origin: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Altamira board not found (HTTP ${status}) for ${origin}`);
        return null;
      }
      // 5xx / network / DNS error — degrade gracefully rather than throwing.
      this.logger.warn(`Altamira board fetch failed for ${origin}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse the server-rendered index HTML into role fragments. We anchor on the
   * canonical job links rather than volatile CSS class names: the SEO form
   * `/jobs/{slug}-{JobID}.htm` (carrying title + location in its slug) is preferred,
   * with the query form `/jobs/job-details?JobID={JobID}` as a fallback for any role
   * the SEO scan missed. De-dup is by numeric job id.
   */
  private parseIndex(html: string, origin: string): AltamiraIndexJob[] {
    const out: AltamiraIndexJob[] = [];
    const byId = new Map<string, AltamiraIndexJob>();

    // Preferred: SEO `.htm` anchors (title + location encoded in the slug).
    ALTAMIRA_SEO_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ALTAMIRA_SEO_LINK_REGEX.exec(html)) !== null) {
      const [, slug, id] = match;
      const jobId = this.cleanText(id);
      if (!jobId || byId.has(jobId)) continue;

      const rawSlug = this.cleanText(slug);
      const { title, location } = this.splitSlug(rawSlug);
      const role: AltamiraIndexJob = {
        id: jobId,
        slug: rawSlug,
        url: `${origin}${ALTAMIRA_JOBS_PATH}/${rawSlug}-${jobId}.htm`,
        title,
        location,
      };
      byId.set(jobId, role);
      out.push(role);
    }

    // Fallback: bare query-string anchors (no slug → title/location unknown here).
    ALTAMIRA_QUERY_LINK_REGEX.lastIndex = 0;
    while ((match = ALTAMIRA_QUERY_LINK_REGEX.exec(html)) !== null) {
      const jobId = this.cleanText(match[1]);
      if (!jobId || byId.has(jobId)) continue;
      const role: AltamiraIndexJob = {
        id: jobId,
        slug: null,
        url: `${origin}${ALTAMIRA_JOBS_PATH}/job-details?JobID=${jobId}`,
        title: null,
        location: null,
      };
      byId.set(jobId, role);
      out.push(role);
    }

    return out;
  }

  /**
   * Best-effort fetch + plain-text extraction of a role's detail page body, used to
   * enrich the description. Altamira emits no JSON-LD / og: meta, so the body is the
   * only ad text available. A fetch / parse failure degrades to null (the listing
   * still yields a complete JobPostDto from the slug).
   */
  private async enrichDescription(
    client: ReturnType<typeof createHttpClient>,
    item: AltamiraIndexJob,
  ): Promise<string | null> {
    const url = this.cleanText(item.url);
    if (!url) return null;
    const html = await this.fetchHtml(client, url, url);
    if (!html) return null;
    const body = this.extractBody(html);
    return this.cleanText(body);
  }

  /**
   * Recover the human-readable job-ad body from the detail HTML. We strip script /
   * style blocks then convert to plain text; the result is the best listing-level
   * description Altamira exposes (no structured body field is emitted).
   */
  private extractBody(html: string): string | null {
    const stripped = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');
    const text = htmlToPlainText(stripped);
    const cleaned = this.cleanText(text);
    if (!cleaned) return null;
    // Guard against an unexpectedly tiny shell; treat near-empty bodies as absent.
    return cleaned.length >= 20 ? cleaned : null;
  }

  /** Map a parsed index role (+ enriched body) → JobPostDto. */
  private processItem(
    item: AltamiraIndexJob,
    origin: string,
    tenant: string,
    descriptionHtml: string | null,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const job = this.normaliseJob(item, tenant, descriptionHtml);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised AltamiraJob from a parsed index role. */
  private normaliseJob(
    item: AltamiraIndexJob,
    tenant: string,
    descriptionHtml: string | null,
  ): AltamiraJob {
    const jobId = this.cleanText(item.id) ?? '';
    const title = this.cleanText(item.title);
    const locationText = this.cleanText(item.location);
    const { city, state, country } = this.splitLocation(locationText);

    return {
      jobId,
      url: this.cleanText(item.url) ?? '',
      title,
      companyName: this.deriveCompanyName(tenant),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(descriptionHtml),
      datePosted: null,
      isRemote: this.detectRemote(title, locationText, item.slug),
    };
  }

  /** Map a normalised AltamiraJob → JobPostDto. */
  private processJob(
    job: AltamiraJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    // Prefer the enriched detail body; fall back to the location line.
    const source = job.descriptionHtml ?? job.locationText ?? null;
    const description = this.formatDescription(source, format);

    return new JobPostDto({
      id: `altamira-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.ALTAMIRA,
      atsId,
      atsType: 'altamira',
      department: null,
      employmentType: null,
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the descriptive text per `descriptionFormat`. The enriched body is
   * already plain text; HTML / markdown / plain all return it appropriately.
   */
  private formatDescription(text: string | null, format?: DescriptionFormat): string | null {
    if (!text) return null;
    if (format === DescriptionFormat.HTML) return text;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(text) ?? text;
    return htmlToPlainText(text) ?? text;
  }

  /**
   * Resolve the tenant origin (scheme + host). An explicit `companySlug` is expanded
   * to `https://{slug}.altamiraweb.com` (a full URL / host passed as the slug is
   * used verbatim); a `companyUrl` on an `altamiraweb.com` host uses its origin
   * verbatim. Returns an empty string when neither yields a host.
   */
  private resolveOrigin(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full careers URL / host as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(ALTAMIRA_ROOT_DOMAIN)) {
        const fromUrl = this.originFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      const label = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '');
      if (!label) return '';
      return ALTAMIRA_HOST_TEMPLATE.replace('{tenant}', label);
    }
    if (companyUrl) {
      const fromUrl = this.originFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the origin from an Altamira URL/host. The candidate-facing forms are
   * `https://{tenant}.altamiraweb.com/...` and `https://{tenant}.sites.altamiraweb.com/...`.
   * Only `altamiraweb.com` hosts are accepted; the origin is used verbatim so the
   * `*.sites` variant is preserved.
   */
  private originFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (hostname !== ALTAMIRA_ROOT_DOMAIN && !hostname.endsWith(`.${ALTAMIRA_ROOT_DOMAIN}`)) {
        return '';
      }
      // A bare apex host (no tenant sub-domain) is not a tenant board.
      if (hostname === ALTAMIRA_ROOT_DOMAIN) return '';
      return `${u.protocol}//${hostname}`;
    } catch {
      // Malformed URL — no origin.
    }
    return '';
  }

  /** Extract the leading tenant label from an origin host (e.g. `etinars`). */
  private tenantLabel(origin: string): string {
    try {
      const u = new URL(origin);
      const first = u.hostname.toLowerCase().split('.')[0];
      return first || origin;
    } catch {
      return origin;
    }
  }

  /**
   * Split a SEO slug into a title head and a location tail. Altamira slugs end with a
   * `Country-Region-City` tail (e.g. `...-Italia-Veneto-Padova`); we treat the final
   * up-to-three capitalised tokens following an `Italia`/country marker as location
   * and the leading tokens as the title. Best-effort: when no country marker is
   * found, the whole slug is the title.
   */
  private splitSlug(slug: string | null): { title: string | null; location: string | null } {
    if (!slug) return { title: null, location: null };
    const decoded = this.safeDecode(slug);
    const tokens = decoded.split('-').filter((t) => t.length > 0);
    if (tokens.length === 0) return { title: null, location: null };

    // Find a country marker near the tail to split title vs location.
    const countryRe = /^(Italia|Italy|Svizzera|Switzerland|Francia|France|Germania|Germany|Spagna|Spain|UK|USA|Remoto|Remote)$/i;
    let splitAt = -1;
    for (let i = Math.max(1, tokens.length - 4); i < tokens.length; i++) {
      if (countryRe.test(tokens[i])) {
        splitAt = i;
        break;
      }
    }

    if (splitAt === -1) {
      return { title: this.titleCaseTokens(tokens), location: null };
    }

    const titleTokens = tokens.slice(0, splitAt);
    const locationTokens = tokens.slice(splitAt);
    return {
      title: this.titleCaseTokens(titleTokens) ?? this.titleCaseTokens(tokens),
      location: locationTokens.join(' ') || null,
    };
  }

  /** Join + lightly title-case slug tokens into a readable title. */
  private titleCaseTokens(tokens: string[]): string | null {
    const joined = tokens.join(' ').trim();
    if (!joined) return null;
    return joined.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Decode percent-encoding without throwing on malformed input. */
  private safeDecode(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  /** De-slugify + title-case the tenant label into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present. The slug tail is `Country-Region-City` order, so we
   * map the first token to country, a middle token to state, and the last to city.
   */
  private extractLocation(job: AltamiraJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of the slug location tail ("Italia Veneto Padova") into
   * country / state / city. The leading token is the country, the trailing token the
   * city, and a single middle token (when present) the region/state.
   */
  private splitLocation(
    text: string | null,
  ): { city: string | null; state: string | null; country: string | null } {
    if (!text || this.isRemoteToken(text)) {
      return { city: null, state: null, country: null };
    }
    const parts = text
      .split(/\s+/)
      .map((p) => this.cleanText(p))
      .filter((p): p is string => !!p);
    if (parts.length === 0) return { city: null, state: null, country: null };
    if (parts.length === 1) return { city: parts[0], state: null, country: null };
    if (parts.length === 2) return { city: parts[1], state: null, country: parts[0] };
    const country = parts[0];
    const city = parts[parts.length - 1];
    const state = parts.slice(1, parts.length - 1).join(' ') || null;
    return { city: city || null, state, country: country || null };
  }

  /** Detect remote roles from the title, location, or slug text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    slug: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, slug];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (ALTAMIRA_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote"/"Remoto" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^(remote|remoto)$/i.test(value.trim());
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
