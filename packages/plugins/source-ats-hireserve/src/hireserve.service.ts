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
  HIRESERVE_BASE,
  HIRESERVE_ROOT_DOMAINS,
  HIRESERVE_LIST_PATH,
  HIRESERVE_LIST_QUERY,
  HIRESERVE_SHOW_JOB_PATH,
  HIRESERVE_VACANCY_PATH,
  HIRESERVE_VACANCY_LINK_REGEX,
  HIRESERVE_REMOTE_REGEX,
  HIRESERVE_DEFAULT_RESULTS,
  HIRESERVE_MAX_PAGES,
  HIRESERVE_DEFAULT_TIMEOUT_SECONDS,
  HIRESERVE_HEADERS,
} from './hireserve.constants';
import { HireserveJob, HireserveJobDetail, HireserveListingJob } from './hireserve.types';

/** A resolved Hireserve portal target: an origin host plus its numeric web-site id. */
interface HireserveTarget {
  /** Portal origin, e.g. `https://university.hireserve-projects.com`. */
  origin: string;
  /** The numeric `p_web_site_id` keying this tenant's portal. */
  siteId: string;
  /** A readable tenant token (sub-domain label) for the display company name. */
  tenant: string;
}

/**
 * Hireserve ATS careers portal scraper — generic, multi-tenant.
 *
 * Hireserve (hireserve.com, UK) powers each customer's branded, public,
 * unauthenticated candidate careers portal via its Oracle PL/SQL "wd_portal" web
 * application. A tenant portal is addressed by a host plus a numeric
 * `p_web_site_id`; the candidate-facing hosts are `{tenant}.hireserve-projects.com`,
 * `{tenant}.hireserve-test.com`, and the shared `ats8.hireserve.com`.
 *
 * The adapter enumerates open roles from the public, server-rendered listing:
 *
 *   GET https://{host}/wd/plsql/wd_portal.list?p_web_site_id={siteId}&p_function=map&p_title=Current+Vacancies
 *
 * which lists each role as a canonical vacancy anchor `/vacancy/{title-slug}-{ID}.html`,
 * where `{ID}` is the stable Hireserve `p_web_page_id` and the pretty vacancy URL is
 * the canonical detail / apply URL (it 301-redirects to `wd_portal.show_job`). Each
 * role's detail page is then fetched (best-effort) for the body and metadata.
 *
 * The caller addresses a tenant by `companyUrl` (any portal URL carrying the
 * `p_web_site_id`, or a `/vacancy/{slug}-{ID}.html` URL) or by a `companySlug` of the
 * form `{host}:{siteId}` / `{tenant}:{siteId}` / a full portal URL. Because the
 * listing is keyed by the numeric site id, a bare slug without a site id cannot be
 * resolved and degrades to an empty result. An unknown tenant / site id renders an
 * "Unauthorised" or empty page, so it degrades naturally to empty. A fetch error, an
 * HTTP 4xx, a DNS failure, or a malformed body degrades to an empty / partial result
 * rather than throwing, so a single bad tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.HIRESERVE,
  name: 'Hireserve',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HireserveService implements IScraper {
  private readonly logger = new Logger(HireserveService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Hireserve scraper');
      return new JobResponseDto([]);
    }

    const target = this.resolveTarget(companySlug, input.companyUrl);
    if (!target) {
      this.logger.warn(
        'Could not resolve a Hireserve portal target (host + p_web_site_id) from input',
      );
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive legacy wd_portal host
    // degrades gracefully fast rather than hanging on the client's 60s default.
    // Bound BOTH keys: the no-proxy path keys off `timeout`, the proxy path off
    // `requestTimeout`. A caller may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? HIRESERVE_DEFAULT_TIMEOUT_SECONDS,
      HIRESERVE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(HIRESERVE_HEADERS);

    const resultsWanted = input.resultsWanted ?? HIRESERVE_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Hireserve jobs for ${target.origin} (site ${target.siteId})`);

      const items = await this.fetchJobList(client, target, resultsWanted, seen);
      if (items.length === 0) {
        this.logger.log(`Hireserve portal ${target.origin}/${target.siteId} has no open roles`);
        return new JobResponseDto([]);
      }

      // Fan out the per-role detail fetches; a single bad role must not nuke the run.
      const settled = await Promise.allSettled(
        items.map((item) => this.processItem(client, item, target, input.descriptionFormat)),
      );

      for (const result of settled) {
        if (result.status === 'fulfilled' && result.value) {
          jobPosts.push(result.value);
        } else if (result.status === 'rejected') {
          this.logger.warn(`Error processing Hireserve role: ${result.reason?.message ?? result.reason}`);
        }
      }

      this.logger.log(`Hireserve total: ${jobPosts.length} jobs for ${target.origin}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Hireserve scrape error for ${target.origin}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Fetch + parse the tenant's listing HTML, accumulating up to `resultsWanted`
   * deduped roles. The "map" listing renders the full board in one document; the
   * page loop is a guard against any future server-side pagination. An unknown
   * tenant renders an empty / unauthorised page; an HTTP 4xx degrades to empty.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    target: HireserveTarget,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<HireserveListingJob[]> {
    const items: HireserveListingJob[] = [];
    const base = `${target.origin}${HIRESERVE_LIST_PATH}?p_web_site_id=${encodeURIComponent(
      target.siteId,
    )}&${HIRESERVE_LIST_QUERY}`;

    for (let page = 1; page <= HIRESERVE_MAX_PAGES; page++) {
      const url = page === 1 ? base : `${base}&p_page=${page}`;
      const html = await this.fetchHtml(client, url, target);
      if (html == null) break;

      const parsed = this.parseListing(html, target);
      let added = 0;
      for (const role of parsed) {
        const id = this.cleanText(role.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push(role);
        added++;
        if (items.length >= resultsWanted) return items;
      }

      // The listing is single-document; stop once a page yields no new roles.
      if (added === 0) break;
    }

    return items;
  }

  /** GET a portal URL as text; an HTTP 4xx / DNS failure degrades to null (no throw). */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    target: HireserveTarget,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Hireserve portal not found (HTTP ${status}) for ${target.origin}`);
        return null;
      }
      // 5xx / network / DNS error — degrade gracefully rather than throwing.
      this.logger.warn(`Hireserve fetch failed for ${target.origin}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse the server-rendered listing HTML into role fragments. Rather than depend
   * on volatile CSS class names, we anchor on the canonical vacancy links
   * (`/vacancy/{title-slug}-{ID}.html`) and read the anchor text and the labelled
   * card text immediately around each link.
   */
  private parseListing(html: string, target: HireserveTarget): HireserveListingJob[] {
    const out: HireserveListingJob[] = [];
    const byId = new Map<string, HireserveListingJob>();

    HIRESERVE_VACANCY_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HIRESERVE_VACANCY_LINK_REGEX.exec(html)) !== null) {
      const [, titleSlug, id] = match;
      const jobId = this.cleanText(id);
      if (!jobId || byId.has(jobId)) continue;

      const url = `${target.origin}${HIRESERVE_VACANCY_PATH}${titleSlug}-${jobId}.html`;

      // Pull a window of plain text around the link to recover the title + card fields.
      const windowText = this.cardWindow(html, match.index, match[0].length);

      const role: HireserveListingJob = {
        id: jobId,
        slug: this.deslug(titleSlug),
        url,
        title: this.titleFromAnchor(html, match.index, match[0].length) ?? this.titleFromSlug(titleSlug),
        location: this.fieldFromWindow(windowText, 'Location'),
        workType: this.fieldFromWindow(windowText, '(?:Work\\s*Type|Contract\\s*Type|Hours)'),
      };

      byId.set(jobId, role);
      out.push(role);
    }

    return out;
  }

  /**
   * Recover the anchor's visible text (the role title) by reading the HTML between
   * the matched href and the closing `</a>`, then stripping tags.
   */
  private titleFromAnchor(html: string, index: number, length: number): string | null {
    // Look forward from the href for the end of the opening tag, then to </a>.
    const after = html.slice(index, index + length + 600);
    const m = />([^<]{2,200})<\/a>/i.exec(after);
    if (m) {
      const text = this.cleanText(htmlToPlainText(m[1]));
      if (text) return text;
    }
    return null;
  }

  /**
   * Extract a window of plain text around a vacancy link, used to recover the card's
   * labelled fields. The listing renders the card's fields close to its anchor, so a
   * bounded slice on either side captures them without bleeding into siblings.
   */
  private cardWindow(html: string, index: number, length: number): string {
    const start = Math.max(0, index - 200);
    const end = Math.min(html.length, index + length + 800);
    return htmlToPlainText(html.slice(start, end)) ?? '';
  }

  /**
   * Read a labelled card field (e.g. "Location London") out of the card window,
   * stopping at the next known label or a line break.
   */
  private fieldFromWindow(windowText: string, label: string): string | null {
    if (!windowText) return null;
    const re = new RegExp(
      `${label}\\s*:?\\s*(.+?)(?:\\s*(?:Location|Work\\s*Type|Contract\\s*Type|Hours|Salary|Closing|Apply|View|Reference|Ref)\\b|[\\r\\n]|$)`,
      'i',
    );
    const m = re.exec(windowText);
    return m ? this.cleanText(m[1]) : null;
  }

  /**
   * Map a parsed listing role → JobPostDto, fetching the role's detail page (best
   * effort) for the body and richer metadata.
   */
  private async processItem(
    client: ReturnType<typeof createHttpClient>,
    item: HireserveListingJob,
    target: HireserveTarget,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const detail = await this.fetchDetail(client, item, target);
    const job = this.normaliseJob(item, detail, target);
    return this.processJob(job, target, format);
  }

  /**
   * Fetch + parse a role's server-rendered detail page. The detail page carries no
   * schema.org JSON-LD, so fields are read from the heading, labelled lines, the
   * page `<title>`, and `og:` meta — all defensive. A fetch failure degrades to an
   * empty detail (the listing-level fields are still used).
   */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    item: HireserveListingJob,
    target: HireserveTarget,
  ): Promise<HireserveJobDetail> {
    const url = this.cleanText(item.url) ?? this.showJobUrl(target, item.id);
    const html = await this.fetchHtml(client, url, target);
    if (html == null) return {};
    return this.parseDetail(html);
  }

  /** Parse a role's detail HTML into the defensive detail fields. */
  private parseDetail(html: string): HireserveJobDetail {
    const text = htmlToPlainText(html) ?? '';
    return {
      title: this.metaContent(html, 'og:title') ?? this.titleTag(html),
      descriptionHtml: this.extractBody(html),
      location: this.fieldFromWindow(text, 'Location'),
      employmentType:
        this.fieldFromWindow(text, '(?:Employment\\s*Type|Contract\\s*Type|Work\\s*Type|Hours)'),
      salary: this.fieldFromWindow(text, 'Salary'),
      department: this.fieldFromWindow(text, '(?:Department|Category|Division|Function)'),
      closingDate: this.fieldFromWindow(text, '(?:Closing\\s*Date|Closing|Apply\\s*by)'),
    };
  }

  /**
   * Best-effort extraction of the job-ad body HTML. Hireserve renders the ad inside
   * a content container; lacking a stable class name, we fall back to the page's
   * largest meaningful HTML region by taking the body content as-is. The downstream
   * converter narrows it to the requested format.
   */
  private extractBody(html: string): string | null {
    const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    const region = bodyMatch ? bodyMatch[1] : html;
    const cleaned = this.cleanText(region);
    return cleaned && cleaned.length > 0 ? region : null;
  }

  /** Read a `<meta property|name="…" content="…">` value. */
  private metaContent(html: string, key: string): string | null {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
      'i',
    );
    const tag = re.exec(html);
    if (!tag) return null;
    const content = /content=["']([^"']*)["']/i.exec(tag[0]);
    return content ? this.cleanText(content[1]) : null;
  }

  /** Read the page `<title>` value. */
  private titleTag(html: string): string | null {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    return m ? this.cleanText(htmlToPlainText(m[1])) : null;
  }

  /** Build a normalised HireserveJob from a parsed listing role + detail fields. */
  private normaliseJob(
    item: HireserveListingJob,
    detail: HireserveJobDetail,
    target: HireserveTarget,
  ): HireserveJob {
    const jobId = this.cleanText(item.id) ?? '';
    const title = this.cleanText(item.title) ?? this.cleanText(detail.title);
    const locationText = this.cleanText(detail.location) ?? this.cleanText(item.location);
    const { city, state, country } = this.splitLocation(locationText);
    const workType = this.cleanText(detail.employmentType) ?? this.cleanText(item.workType);

    return {
      jobId,
      url: this.cleanText(item.url) ?? this.vacancyUrl(target, item),
      title,
      companyName: this.deriveCompanyName(target.tenant),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(detail.descriptionHtml),
      department: this.cleanText(detail.department),
      employmentType: this.normaliseEmploymentType(workType),
      datePosted: this.parseDate(detail.closingDate),
      isRemote: this.detectRemote(title, locationText, workType),
    };
  }

  /** Map a normalised HireserveJob → JobPostDto. */
  private processJob(
    job: HireserveJob,
    target: HireserveTarget,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(target.tenant);
    // Prefer the detail-page body; fall back to the location line as listing-level text.
    const source = job.descriptionHtml ?? job.locationText ?? null;
    const description = this.formatDescription(source, format);

    return new JobPostDto({
      id: `hireserve-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.HIRESERVE,
      atsId,
      atsType: 'hireserve',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the descriptive text per `descriptionFormat`. Detail bodies are HTML;
   * the location-line fallback is already plain. HTML / markdown / plain are
   * produced via the shared converters.
   */
  private formatDescription(text: string | null, format?: DescriptionFormat): string | null {
    if (!text) return null;
    if (format === DescriptionFormat.HTML) return text;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(text) ?? htmlToPlainText(text) ?? text;
    return htmlToPlainText(text) ?? text;
  }

  /**
   * Resolve the portal target (host + numeric `p_web_site_id`). The listing surface
   * is keyed by the site id, so a usable target always needs both a host and a site
   * id. Accepted forms:
   *   - `companyUrl` on a Hireserve host carrying `p_web_site_id` (or a
   *     `/vacancy/{slug}-{ID}.html` URL, whose site id is taken from the host's
   *     default portal when present in the query).
   *   - `companySlug` of the form `{host}:{siteId}` / `{tenant}:{siteId}` / a full
   *     portal URL.
   * Returns null when no host+siteId pair can be derived.
   */
  private resolveTarget(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): HireserveTarget | null {
    // Prefer an explicit companyUrl that carries both host and site id.
    if (companyUrl) {
      const fromUrl = this.targetFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }

    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();

      // A caller may pass a full portal / vacancy URL as the slug.
      if (/^https?:\/\//i.test(slug) || this.isHireserveHost(slug)) {
        const fromUrl = this.targetFromUrl(slug);
        if (fromUrl) return fromUrl;
      }

      // `{host}:{siteId}` or `{tenant}:{siteId}` form.
      const colon = slug.match(/^([^:\s]+):(\d+)$/);
      if (colon) {
        const hostPart = colon[1];
        const siteId = colon[2];
        const origin = this.originFromHostPart(hostPart);
        if (origin) {
          return { origin, siteId, tenant: this.tenantFromOrigin(origin) };
        }
      }
    }

    return null;
  }

  /** Derive a target from a Hireserve portal / vacancy URL carrying a `p_web_site_id`. */
  private targetFromUrl(value: string): HireserveTarget | null {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!this.isHireserveHostname(hostname)) return null;

      const origin = `${u.protocol}//${u.hostname}`;
      const siteId = u.searchParams.get('p_web_site_id');
      if (siteId && /^\d+$/.test(siteId)) {
        return { origin, siteId, tenant: this.tenantFromHostname(hostname) };
      }
      // A `/vacancy/{slug}-{ID}.html` URL without an explicit site id is not
      // self-describing enough to enumerate the board, so it cannot resolve a target.
      return null;
    } catch {
      return null;
    }
  }

  /** Expand a bare host part (`tenant` or `tenant.hireserve-projects.com`) into an origin. */
  private originFromHostPart(hostPart: string): string | null {
    const part = hostPart.trim().toLowerCase();
    if (!part) return null;
    if (this.isHireserveHostname(part)) {
      return `https://${part}`;
    }
    // A bare tenant label expands to the production hosted host.
    if (/^[a-z0-9][a-z0-9-]*$/.test(part)) {
      return `https://${part}.hireserve-projects.com`;
    }
    return null;
  }

  /** True when a string looks like a Hireserve hostname. */
  private isHireserveHost(value: string): boolean {
    const lower = value.toLowerCase();
    return HIRESERVE_ROOT_DOMAINS.some((d) => lower.includes(d));
  }

  /** True when a hostname ends with a known Hireserve root domain. */
  private isHireserveHostname(hostname: string): boolean {
    return HIRESERVE_ROOT_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  }

  /** The tenant sub-domain label from a Hireserve origin. */
  private tenantFromOrigin(origin: string): string {
    try {
      return this.tenantFromHostname(new URL(origin).hostname.toLowerCase());
    } catch {
      return '';
    }
  }

  /** The tenant sub-domain label from a Hireserve hostname (the leading label). */
  private tenantFromHostname(hostname: string): string {
    const labels = hostname.split('.');
    if (labels.length === 0) return '';
    const first = labels[0];
    // `ats8.hireserve.com` and bare root domains carry no tenant label.
    if (first === 'ats8' || HIRESERVE_ROOT_DOMAINS.includes(hostname as any)) return '';
    return first;
  }

  /** Build the canonical pretty vacancy URL for a role from its parts. */
  private vacancyUrl(target: HireserveTarget, item: HireserveListingJob): string {
    const slug = this.cleanText(item.slug) ?? this.cleanText(item.id) ?? '';
    const id = this.cleanText(item.id) ?? '';
    return `${target.origin}${HIRESERVE_VACANCY_PATH}${slug}-${id}.html`;
  }

  /** Build the backing `wd_portal.show_job` action URL for a role (detail fallback). */
  private showJobUrl(target: HireserveTarget, id: string): string {
    return `${target.origin}${HIRESERVE_SHOW_JOB_PATH}?p_web_site_id=${encodeURIComponent(
      target.siteId,
    )}&p_web_page_id=${encodeURIComponent(id)}&p_lang=DEFAULT`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    if (!base) return 'Hireserve';
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Turn a URL title slug (e.g. `business-analyst`) into a readable title. */
  private titleFromSlug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    if (!cleaned) return null;
    return cleaned.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Normalise a raw title slug for storage (lower-case, dash-separated). */
  private deslug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    return cleaned ? cleaned.toLowerCase() : null;
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present. Hireserve renders a single free-text location line;
   * we keep the trailing token as country and the leading text as city, best-effort.
   */
  private extractLocation(job: HireserveJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state /
   * country. Comma-separated tail is treated as the country; the head as the city.
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

  /** Detect remote roles from the title, location, or work-type text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    workType: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, workType];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (HIRESERVE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /**
   * Normalise a Hireserve work-type token (e.g. "Full Time fixed hours",
   * "Part Time", "Fixed Term") into a readable, trimmed, title-cased label.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const spaced = cleaned
      .replace(/[_]+/g, ' ')
      .replace(/\bfulltime\b/i, 'full time')
      .replace(/\bparttime\b/i, 'part time')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return spaced.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse a date-ish value into a YYYY-MM-DD string. A relative value ("in 3 days")
   * is not an absolute date and yields null; an absolute date string is parsed and
   * normalised.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    if (/\bago\b|\bin\s+\d/i.test(cleaned)) return null; // relative, not absolute
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
