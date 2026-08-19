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
import * as cheerio from 'cheerio';
import {
  HREASILY_ROOT_DOMAIN,
  HREASILY_CAREERS_HOST,
  HREASILY_CAREERS_ORIGIN,
  HREASILY_DEFAULT_RESULTS,
  HREASILY_MAX_PAGES,
  HREASILY_DEFAULT_TIMEOUT_SECONDS,
  HREASILY_HEADERS,
  HREASILY_JOBPOSTING_TYPE,
  HREASILY_REMOTE_REGEX,
  hreasilyCareerPageUrl,
  hreasilyJobDetailUrl,
} from './hreasily.constants';
import {
  HReasilyJob,
  HReasilyJsonLd,
  HReasilyJobPosting,
  HReasilyListItem,
  HReasilyDataIslandJob,
  HReasilyJobLocation,
  HReasilyPostalAddress,
  HReasilyHiringOrganization,
} from './hreasily.types';

/**
 * HReasily ATS careers scraper — generic, multi-tenant.
 *
 * HReasily (hreasily.com — a Singapore-origin, South-East-Asian cloud HR & payroll platform
 * with an Applicant-Tracking module in its higher tier) lets each hiring tenant publish a
 * branded, public, unauthenticated candidate-facing career page on the shared careers host
 * `https://careers.hreasily.com/{slug}`. The page is server-rendered and embeds its open
 * roles as schema.org `JobPosting` JSON-LD islands (the platform-neutral, crawler-facing
 * structured-data contract). The adapter resolves the tenant slug, GETs the career page, and
 * reads each role from the JSON-LD — falling back to a server-side-rendered data island, then
 * to a light HTML anchor extraction, when JSON-LD is absent — rather than depending on a
 * client-rendered DOM, a headless browser, the authenticated employer app, or any private
 * HReasily API.
 *
 * The caller addresses a tenant by `companySlug` (the career-page slug) or by `companyUrl`
 * (a `careers.hreasily.com/{slug}` URL). An unknown slug, a tenant with hiring disabled, or
 * an empty board degrades naturally to an empty result. A fetch error, an HTTP 4xx, a DNS
 * failure, or a malformed body degrades to an empty / partial result rather than throwing, so
 * a single tenant never nukes a batch run.
 *
 * Surface confidence: the host + slug-path shape and the JSON-LD-first parsing contract are a
 * defensive best-effort model (verified=false as of 2026-06-04 — see hreasily.constants.ts).
 * Because every failure degrades to an empty result and no role is ever fabricated, an
 * unconfirmed surface is safe: the adapter returns nothing rather than wrong data.
 */
@SourcePlugin({
  site: Site.HREASILY,
  name: 'HReasily',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HReasilyService implements IScraper {
  private readonly logger = new Logger(HReasilyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for HReasily scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve an HReasily tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive host degrades gracefully fast rather than
    // hanging on the client's 60s default. Bound BOTH keys: the no-proxy path keys off
    // `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter timeout;
    // we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? HREASILY_DEFAULT_TIMEOUT_SECONDS,
      HREASILY_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(HREASILY_HEADERS);

    const resultsWanted = input.resultsWanted ?? HREASILY_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching HReasily career page for slug: ${slug}`);

      // The career page renders the tenant's full role set in one document. We fetch it and
      // collect every embedded role; should a future shape paginate, the page-cap loop below
      // bounds the sweep. A transport-level failure (host unreachable) aborts; an HTTP error /
      // malformed page degrades to an empty / partial result.
      const seen = new Set<string>();

      for (let page = 1; page <= HREASILY_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, slug, page);
        if (!result.hostReachable) break; // transport-level failure → stop
        const html = result.html;
        if (!html) break; // HTTP error / empty body → nothing to drain

        const { roles, companyName } = this.extractRoles(html, slug);
        if (roles.length === 0) break; // no roles on this page → past the end

        for (const role of roles) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processRole(role, slug, companyName, input.descriptionFormat, seen);
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing HReasily role: ${err?.message ?? err}`);
          }
        }

        // The career page is single-document in the confirmed shape: one fetch yields the full
        // set. Stop after the first page unless a future paginated shape signals otherwise (a
        // role count at-or-above the wanted total means we already have enough).
        break;
      }

      this.logger.log(`HReasily total: ${jobPosts.length} jobs for ${slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`HReasily scrape error for ${slug}: ${err?.message ?? err}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET one page of the public career page as HTML. Returns `{ html, hostReachable }`:
   *  - `html` is the page body, or null when the response carried no usable body / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the host itself is unreachable and the caller should stop.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    page: number,
  ): Promise<{ html: string | null; hostReachable: boolean }> {
    const base = hreasilyCareerPageUrl(slug);
    const url = page > 1 ? `${base}?page=${page}` : base;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      return { html: html.length > 0 ? html : null, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, but there is nothing
        // to read. An unknown slug typically 404s here.
        this.logger.warn(`HReasily career page returned HTTP ${status} for ${slug}`);
        return { html: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout).
      this.logger.warn(`HReasily career page fetch failed for ${slug}: ${err?.message ?? err}`);
      return { html: null, hostReachable: false };
    }
  }

  /**
   * Extract the tenant's open roles from the career-page HTML. Tries, in order:
   *  1. schema.org `JobPosting` JSON-LD islands (the primary, drift-tolerant contract),
   *  2. a server-side-rendered data island (an embedded JSON array of roles),
   *  3. a light HTML anchor scrape (last-resort, role-detail links only).
   * Each strategy is independent and never throws; the first that yields roles wins. Also
   * resolves the employer display name from the JSON-LD `hiringOrganization` when present.
   */
  private extractRoles(
    html: string,
    slug: string,
  ): { roles: HReasilyJobPosting[]; companyName: string | null } {
    let companyName: string | null = null;
    let $: cheerio.CheerioAPI | null = null;
    try {
      $ = cheerio.load(html);
    } catch (err: any) {
      this.logger.warn(`HReasily HTML parse failed for ${slug}: ${err?.message ?? err}`);
      $ = null;
    }

    // Strategy 1 — JSON-LD JobPosting islands.
    const fromJsonLd = $ ? this.extractFromJsonLd($) : [];
    if (fromJsonLd.length > 0) {
      companyName = this.companyFromPostings(fromJsonLd);
      return { roles: fromJsonLd, companyName };
    }

    // Strategy 2 — server-side-rendered data island → coerce to JobPosting-shaped roles.
    const fromIsland = $ ? this.extractFromDataIsland($, slug) : [];
    if (fromIsland.length > 0) {
      return { roles: fromIsland, companyName };
    }

    // Strategy 3 — light HTML anchor scrape.
    const fromAnchors = $ ? this.extractFromAnchors($, slug) : [];
    return { roles: fromAnchors, companyName };
  }

  /**
   * Parse every `<script type="application/ld+json">` island and collect each `JobPosting`,
   * whether it appears bare, inside an `ItemList.itemListElement[]`, or inside a `@graph[]`.
   * A malformed island is skipped without aborting the others.
   */
  private extractFromJsonLd($: cheerio.CheerioAPI): HReasilyJobPosting[] {
    const postings: HReasilyJobPosting[] = [];
    const scripts = $('script[type="application/ld+json"]');
    scripts.each((_i, el) => {
      const raw = $(el).contents().text();
      const cleaned = this.cleanText(raw);
      if (!cleaned) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        // Some pages emit multiple concatenated JSON objects in one island; try a lenient
        // split on `}{` boundaries before giving up.
        const recovered = this.tryParseConcatenated(cleaned);
        if (recovered.length === 0) return;
        for (const node of recovered) this.collectPostings(node, postings);
        return;
      }
      this.collectPostings(parsed, postings);
    });
    return postings;
  }

  /** Recursively collect `JobPosting` nodes from an arbitrary parsed JSON-LD value. */
  private collectPostings(node: unknown, out: HReasilyJobPosting[]): void {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) this.collectPostings(child, out);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as HReasilyJsonLd & HReasilyJobPosting & { item?: unknown };

    const type = this.typeToken(obj['@type']);
    if (type === HREASILY_JOBPOSTING_TYPE.toLowerCase()) {
      out.push(obj as HReasilyJobPosting);
      return;
    }

    // ItemList → walk its itemListElement[] (each may be a ListItem wrapping `item`).
    const list = (obj as HReasilyJsonLd).itemListElement;
    if (Array.isArray(list)) {
      for (const entry of list) {
        const li = entry as HReasilyListItem & HReasilyJobPosting;
        if (li && typeof li === 'object' && li.item) {
          this.collectPostings(li.item, out);
        } else {
          this.collectPostings(li, out);
        }
      }
    }

    // @graph → walk its mixed nodes.
    const graph = (obj as HReasilyJsonLd)['@graph'];
    if (Array.isArray(graph)) {
      for (const g of graph) this.collectPostings(g, out);
    }
  }

  /**
   * Extract a server-side-rendered data island — an embedded JSON array of the tenant's roles
   * (e.g. a `<script id="__DATA__" type="application/json">[…]</script>` mount). Coerces each
   * row to a JobPosting-shaped role so the common mapper can read it. Returns an empty list
   * when no usable island is present.
   */
  private extractFromDataIsland($: cheerio.CheerioAPI, slug: string): HReasilyJobPosting[] {
    const out: HReasilyJobPosting[] = [];
    const scripts = $('script[type="application/json"]');
    scripts.each((_i, el) => {
      if (out.length > 0) return;
      const raw = $(el).contents().text();
      const cleaned = this.cleanText(raw);
      if (!cleaned) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return;
      }
      const rows = this.findJobArray(parsed);
      for (const row of rows) {
        const posting = this.dataIslandToPosting(row, slug);
        if (posting) out.push(posting);
      }
    });
    return out;
  }

  /**
   * Find the first array of role-like objects inside an arbitrary parsed data island. Looks at
   * the top level, then at a handful of common container keys, then one level deep. Defensive:
   * returns an empty array when nothing role-shaped is found.
   */
  private findJobArray(node: unknown, depth = 0): HReasilyDataIslandJob[] {
    if (!node || depth > 4) return [];
    if (Array.isArray(node)) {
      const rows = node.filter((r) => this.looksLikeJob(r));
      if (rows.length > 0) return rows as HReasilyDataIslandJob[];
      // The array may wrap deeper structures.
      for (const child of node) {
        const found = this.findJobArray(child, depth + 1);
        if (found.length > 0) return found;
      }
      return [];
    }
    if (typeof node !== 'object') return [];
    const obj = node as Record<string, unknown>;
    const preferredKeys = ['jobs', 'jobPostings', 'jobPosts', 'roles', 'vacancies', 'data', 'items', 'results'];
    for (const key of preferredKeys) {
      if (Array.isArray(obj[key])) {
        const found = this.findJobArray(obj[key], depth + 1);
        if (found.length > 0) return found;
      }
    }
    for (const value of Object.values(obj)) {
      const found = this.findJobArray(value, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  }

  /** Heuristic: an object is role-like when it carries a title/name and an id/url. */
  private looksLikeJob(row: unknown): boolean {
    if (!row || typeof row !== 'object') return false;
    const r = row as HReasilyDataIslandJob;
    const hasTitle = !!this.cleanText(r.title) || !!this.cleanText(r.name);
    const hasKey =
      r.id != null || r.jobId != null || !!this.cleanText(r.url) || !!this.cleanText(r.applyUrl);
    return hasTitle && hasKey;
  }

  /** Coerce a data-island row into a JobPosting-shaped role the common mapper can read. */
  private dataIslandToPosting(row: HReasilyDataIslandJob, slug: string): HReasilyJobPosting | null {
    const id = this.toStringId(row.id ?? row.jobId);
    const title = this.cleanText(row.title) ?? this.cleanText(row.name);
    if (!title) return null;
    const url =
      this.cleanText(row.url) ??
      this.cleanText(row.applyUrl) ??
      (id ? hreasilyJobDetailUrl(slug, id) : null);

    const addressParts: HReasilyPostalAddress = {
      addressLocality: this.cleanText(row.city) ?? this.cleanText(row.location),
      addressRegion: this.cleanText(row.state),
      addressCountry: this.cleanText(row.country),
    };

    return {
      '@type': HREASILY_JOBPOSTING_TYPE,
      identifier: id ?? undefined,
      title,
      description: this.cleanText(row.description),
      url: url ?? undefined,
      datePosted: this.cleanText(row.datePosted) ?? this.cleanText(row.createdAt),
      employmentType: this.cleanText(row.employmentType) ?? this.cleanText(row.jobType),
      occupationalCategory: this.cleanText(row.department),
      jobLocation: { '@type': 'Place', address: addressParts },
      jobLocationType: row.remote === true ? 'TELECOMMUTE' : null,
    };
  }

  /**
   * Last-resort HTML extraction: collect role-detail anchors (`/{slug}/{jobId}`) and their
   * link text as the title. Yields minimal `JobPosting`s so a JSON-LD-less page still returns
   * something usable.
   */
  private extractFromAnchors($: cheerio.CheerioAPI, slug: string): HReasilyJobPosting[] {
    const out: HReasilyJobPosting[] = [];
    const seen = new Set<string>();
    const prefix = `/${slug}/`;
    $('a[href]').each((_i, el) => {
      const href = this.cleanText($(el).attr('href'));
      if (!href) return;
      let path: string;
      try {
        path = href.startsWith('http') ? new URL(href).pathname : href;
      } catch {
        return;
      }
      if (!path.startsWith(prefix)) return;
      const rest = path.slice(prefix.length).split(/[?#]/)[0];
      const jobId = rest.split('/')[0];
      if (!jobId || seen.has(jobId)) return;
      const title = this.cleanText($(el).text());
      if (!title) return;
      seen.add(jobId);
      out.push({
        '@type': HREASILY_JOBPOSTING_TYPE,
        identifier: jobId,
        title,
        url: hreasilyJobDetailUrl(slug, jobId),
      });
    });
    return out;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processRole(
    posting: HReasilyJobPosting,
    slug: string,
    companyName: string | null,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normalisePosting(posting, slug, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, slug, format);
  }

  /** Build a normalised HReasilyJob from a parsed JobPosting. */
  private normalisePosting(
    posting: HReasilyJobPosting,
    slug: string,
    companyName: string | null,
  ): HReasilyJob | null {
    const title = this.cleanText(posting.title);
    if (!title) return null;

    const atsId = this.resolveAtsId(posting, slug);
    if (!atsId) return null;

    const url = this.cleanText(posting.url) ?? hreasilyJobDetailUrl(slug, atsId);
    const loc = this.resolveLocation(posting.jobLocation);
    const locationText = this.joinLocation(loc.city, loc.state, loc.country);
    const department = this.cleanText(posting.occupationalCategory) ?? this.cleanText(posting.industry);

    return {
      atsId,
      url,
      applyUrl: url,
      title,
      companyName: this.resolveCompany(posting.hiringOrganization) ?? companyName ?? this.deriveSlugName(slug),
      city: loc.city,
      state: loc.state,
      country: loc.country,
      locationText,
      descriptionHtml: this.cleanText(posting.description),
      department,
      employmentType: this.resolveEmploymentType(posting.employmentType),
      datePosted: this.parseDate(posting.datePosted),
      isRemote: this.detectRemote(posting, title, locationText, department),
    };
  }

  /** Map a normalised HReasilyJob → JobPostDto. */
  private processJob(job: HReasilyJob, slug: string, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveSlugName(slug);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `hreasily-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.HREASILY,
      atsId,
      atsType: 'hreasily',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Resolve the role's stable ATS id from the schema.org `identifier` (string / number /
   * `{ value }`), falling back to the trailing `/{jobId}` segment of its `url`. Returns an
   * empty string when neither yields an id.
   */
  private resolveAtsId(posting: HReasilyJobPosting, slug: string): string {
    const identifier = posting.identifier;
    if (identifier != null) {
      if (typeof identifier === 'object') {
        const value = this.toStringId((identifier as { value?: string | number | null }).value);
        if (value) return value;
      } else {
        const value = this.toStringId(identifier);
        if (value) return value;
      }
    }
    const url = this.cleanText(posting.url);
    if (url) {
      const fromUrl = this.jobIdFromUrl(url, slug);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /** Pull the `/{slug}/{jobId}` trailing segment from a detail URL, when present. */
  private jobIdFromUrl(url: string, slug: string): string {
    try {
      const path = url.startsWith('http') ? new URL(url).pathname : url;
      const segments = path.split('/').filter(Boolean);
      const slugIdx = segments.findIndex((s) => s.toLowerCase() === slug.toLowerCase());
      if (slugIdx >= 0 && segments[slugIdx + 1]) return decodeURIComponent(segments[slugIdx + 1]);
      // Fall back to the last path segment.
      if (segments.length > 0) return decodeURIComponent(segments[segments.length - 1]);
    } catch {
      // ignore malformed URL
    }
    return '';
  }

  /** Resolve the employer display name from a `hiringOrganization` (object or string). */
  private resolveCompany(org: HReasilyHiringOrganization | string | null | undefined): string | null {
    if (!org) return null;
    if (typeof org === 'string') return this.cleanText(org);
    return this.cleanText(org.name);
  }

  /** Resolve a company name from the first posting that carries a hiringOrganization. */
  private companyFromPostings(postings: HReasilyJobPosting[]): string | null {
    for (const p of postings) {
      const name = this.resolveCompany(p.hiringOrganization);
      if (name) return name;
    }
    return null;
  }

  /**
   * Resolve structured location parts from a `jobLocation` (a single `Place`, an array of
   * them, or a free-text string). Reads the first location's postal address; defensive
   * against a string `addressCountry` or a `{ name }` `Country` object.
   */
  private resolveLocation(
    jobLocation: HReasilyJobLocation | HReasilyJobLocation[] | null | undefined,
  ): { city: string | null; state: string | null; country: string | null } {
    const empty = { city: null, state: null, country: null };
    if (!jobLocation) return empty;
    const place = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
    if (!place) return empty;

    const address = place.address;
    if (!address) return empty;
    if (typeof address === 'string') {
      const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
      return {
        city: parts[0] ?? null,
        state: parts.length > 2 ? parts[1] : null,
        country: parts.length > 1 ? parts[parts.length - 1] : null,
      };
    }
    return {
      city: this.cleanText(address.addressLocality),
      state: this.cleanText(address.addressRegion),
      country: this.resolveCountry(address.addressCountry),
    };
  }

  /** Resolve a country name from a string or a `{ name }` `Country` object. */
  private resolveCountry(
    country: string | { name?: string | null } | null | undefined,
  ): string | null {
    if (!country) return null;
    if (typeof country === 'string') return this.cleanText(country);
    return this.cleanText(country.name);
  }

  /** Resolve a single employment-type display label from a token or an array of tokens. */
  private resolveEmploymentType(value: string | string[] | null | undefined): string | null {
    if (Array.isArray(value)) {
      const first = value.map((v) => this.cleanText(v)).find((v) => !!v);
      return first ? this.humaniseEmploymentType(first) : null;
    }
    const cleaned = this.cleanText(value);
    return cleaned ? this.humaniseEmploymentType(cleaned) : null;
  }

  /** Title-case a schema.org employment-type token (`FULL_TIME` → `Full Time`). */
  private humaniseEmploymentType(value: string): string {
    if (!/^[A-Z_]+$/.test(value)) return value;
    return value
      .toLowerCase()
      .replace(/_+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Convert the role description body per `descriptionFormat`. The role exposes the body as
   * HTML (or plain), so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare career URL
   * passed as the slug is reduced to its `/{slug}` token); a `companyUrl` on the careers host
   * has the slug taken from its first path segment. Returns an empty string when neither
   * yields a slug.
   */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(HREASILY_ROOT_DOMAIN + '/')) {
        const fromUrl = this.slugFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.slugFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant slug from an HReasily career URL. The candidate-facing page is
   * `careers.hreasily.com/{slug}`; the slug is the first path segment.
   */
  private slugFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      // Accept the careers host or any *.hreasily.com host bearing a `/{slug}` path.
      if (!hostname.endsWith(HREASILY_ROOT_DOMAIN) && hostname !== HREASILY_CAREERS_HOST) return '';
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      if (segments[0]) return decodeURIComponent(segments[0]).toLowerCase();
      return '';
    } catch {
      // Malformed URL — no slug.
    }
    return '';
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(slug: string): string {
    const base = slug && slug.trim() ? slug.trim() : slug;
    // Drop a trailing TLD-like suffix before title-casing.
    const withoutTld = base.replace(/\.[a-z]{2,}$/i, '');
    return (withoutTld || base)
      .replace(/[-_.]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: HReasilyJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
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

  /**
   * Detect remote roles from the structured `jobLocationType` (`TELECOMMUTE`), then from the
   * title, location, or department text.
   */
  private detectRemote(
    posting: HReasilyJobPosting,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const typeToken = this.cleanText(posting.jobLocationType);
    if (typeToken && typeToken.toUpperCase().includes('TELECOMMUTE')) return true;
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (HREASILY_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse a date value into a YYYY-MM-DD string. Non-absolute / unparseable values yield null.
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

  /**
   * Recover from an island that concatenates multiple JSON objects (`}{`) without an
   * enclosing array. Returns the parsed nodes, or an empty array when nothing parses.
   */
  private tryParseConcatenated(raw: string): unknown[] {
    const out: unknown[] = [];
    const wrapped = `[${raw.replace(/}\s*{/g, '},{')}]`;
    try {
      const parsed = JSON.parse(wrapped);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // give up
    }
    return out;
  }

  /** Lower-cased `@type` token (which may itself be an array per JSON-LD). */
  private typeToken(type: string | string[] | null | undefined): string {
    if (Array.isArray(type)) {
      const first = type.find((t) => typeof t === 'string');
      return first ? first.toLowerCase() : '';
    }
    return typeof type === 'string' ? type.toLowerCase() : '';
  }

  /** Coerce a numeric-or-string id into a string, else null. */
  private toStringId(value: string | number | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string') {
      const v = value.trim();
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
}
