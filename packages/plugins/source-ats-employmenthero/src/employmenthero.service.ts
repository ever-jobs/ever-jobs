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
  EMPLOYMENTHERO_ROOT_DOMAIN,
  EMPLOYMENTHERO_BOARD_HOST,
  EMPLOYMENTHERO_DEFAULT_RESULTS,
  EMPLOYMENTHERO_PAGE_SIZE,
  EMPLOYMENTHERO_MAX_PAGES,
  EMPLOYMENTHERO_DEFAULT_TIMEOUT_SECONDS,
  EMPLOYMENTHERO_HEADERS,
  EMPLOYMENTHERO_REMOTE_TYPE,
  EMPLOYMENTHERO_REMOTE_REGEX,
  employmentHeroJobsUrl,
  employmentHeroPositionUrl,
} from './employmenthero.constants';
import {
  EmploymentHeroJob,
  EmploymentHeroJobItem,
  EmploymentHeroJobsData,
  EmploymentHeroJobsResponse,
} from './employmenthero.types';

/**
 * Employment Hero ATS careers scraper — generic, multi-tenant.
 *
 * Employment Hero (employmenthero.com — an AU / NZ / SEA / UK all-in-one HR, payroll &
 * recruitment platform whose recruitment arm powers branded candidate-facing career pages and
 * embeddable job widgets for a large multi-tenant base) powers each customer's branded, public,
 * unauthenticated candidate-facing job board on the shared host
 * `https://jobs.employmenthero.com/organisations/{slug}` (which 307-redirects to the canonical
 * `https://employmenthero.com/jobs/organisations/{slug}/`). The board is server-rendered, and
 * its client reads a **single public, anonymous JSON API** baked into the page (no bearer token
 * — the board fetches it for anonymous visitors):
 *
 *   GET https://services.employmenthero.com/ats/api/v1/career_page/organisations/{slug}/jobs
 *       ?page_index={n}&item_per_page={size}
 *     → { data: { items: [ { id, title, friendly_id, description, country_code,
 *                            vendor_location_name, remote, workplace_type, team_name,
 *                            employment_type_name, created_at, … } ],
 *                  page_index, item_per_page, total_pages, total_items } }
 *
 * The adapter resolves the tenant slug, then drains the career-page jobs feed by `page_index`
 * (bounded by the feed's own `total_pages`, a page cap, and `resultsWanted`), and maps each
 * role — rather than depending on a client-rendered DOM, a headless browser, or any
 * authenticated Employment Hero API. Each role's string `id` is the stable ATS id, and its
 * `friendly_id` forms the canonical public `/jobs/position/{friendlyId}/` detail / apply page.
 *
 * The caller addresses a tenant by `companySlug` (the organisation friendly id, e.g.
 * `employmenthero`) or by `companyUrl` (a `jobs.employmenthero.com/organisations/{slug}` or
 * `employmenthero.com/jobs/organisations/{slug}` URL). An unknown slug (the feed answers HTTP
 * 404 `organisation_not_found`) or an empty board degrades naturally to an empty result. A
 * fetch error, an HTTP 4xx/5xx, a DNS failure, or a malformed body degrades to an empty /
 * partial result rather than throwing, so a single bad tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.EMPLOYMENTHERO,
  name: 'Employment Hero',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class EmploymentHeroService implements IScraper {
  private readonly logger = new Logger(EmploymentHeroService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Employment Hero scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve an Employment Hero tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Employment Hero host degrades gracefully
    // fast rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path
    // keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter
    // timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? EMPLOYMENTHERO_DEFAULT_TIMEOUT_SECONDS,
      EMPLOYMENTHERO_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(EMPLOYMENTHERO_HEADERS);

    const resultsWanted = input.resultsWanted ?? EMPLOYMENTHERO_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Employment Hero jobs for slug: ${slug}`);

      const seen = new Set<string>();
      let totalPages = EMPLOYMENTHERO_MAX_PAGES;

      // Drain the paginated public career-page jobs feed for the tenant. The envelope carries
      // first-class pagination meta (`total_pages`), so we stop once we pass the last page, when
      // a page returns an empty `items` array, when we hit the page cap, or once `resultsWanted`
      // roles are collected. A transport-level failure (host unreachable) aborts the sweep; an
      // HTTP error / malformed page degrades to an empty / partial result.
      for (let page = 1; page <= EMPLOYMENTHERO_MAX_PAGES && page <= totalPages; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, slug, page);
        if (!result.hostReachable) break;
        const data = result.data;
        if (!data) break; // HTTP error / unparseable body → stop draining

        // Trust the feed's reported `total_pages` to bound the sweep once we have it.
        const reported = this.toFiniteInt(data.total_pages);
        if (reported && reported > 0) totalPages = reported;

        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) break; // past the last page / empty board

        const companyName =
          this.cleanText(items[0]?.organisation_name) ?? this.deriveSlugName(slug);

        for (const item of items) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processItem(item, slug, companyName, input.descriptionFormat, seen);
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Employment Hero role ${item?.id}: ${err.message}`);
          }
        }
      }

      this.logger.log(`Employment Hero total: ${jobPosts.length} jobs for ${slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Employment Hero scrape error for ${slug}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * GET one page of the public career-page jobs feed as JSON. Returns `{ data, hostReachable }`:
   *  - `data` is the parsed `{ items, page_index, total_pages, … }` envelope, or null when the
   *    response carried no usable JSON / the host answered an HTTP error status (4xx / 5xx — a
   *    real, reachable host, e.g. 404 `organisation_not_found` for an unknown tenant).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the host itself is unreachable and the caller should stop
   *    draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    page: number,
  ): Promise<{ data: EmploymentHeroJobsData | null; hostReachable: boolean }> {
    const url = this.buildFeedUrl(slug, page);
    try {
      const response = await client.get<EmploymentHeroJobsResponse | string>(url);
      const parsed = this.coerceJobs(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, but there is nothing
        // more to drain (an unknown tenant returns 404 `organisation_not_found`).
        this.logger.warn(`Employment Hero feed returned HTTP ${status} for ${slug}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the host
      // is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Employment Hero feed fetch failed for ${slug}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce an axios response body into a parsed jobs envelope `data`. The client usually parses
   * the JSON for us (object body); a text/plain string body is parsed defensively. A non-object
   * / unparseable body yields null (degrade to no roles).
   */
  private coerceJobs(
    data: EmploymentHeroJobsResponse | string | unknown,
  ): EmploymentHeroJobsData | null {
    const env = this.coerceObject<EmploymentHeroJobsResponse>(data);
    if (env && env.data && typeof env.data === 'object') {
      return env.data as EmploymentHeroJobsData;
    }
    return null;
  }

  /** Narrow an object (or a JSON string body) into the given envelope type, else null. */
  private coerceObject<T>(data: T | string | unknown): T | null {
    if (data && typeof data === 'object') return data as T;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as T;
      } catch (err: any) {
        this.logger.warn(`Employment Hero JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: EmploymentHeroJobItem,
    slug: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, slug, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, slug, format);
  }

  /** Build a normalised EmploymentHeroJob from a parsed role. */
  private normaliseItem(
    item: EmploymentHeroJobItem,
    slug: string,
    companyName: string,
  ): EmploymentHeroJob | null {
    const atsId = this.cleanText(item.id);
    if (!atsId) return null;

    // The public detail URL is derived from the role's `friendly_id`; without it the role has no
    // canonical candidate-facing page, so it is dropped.
    const friendlyId = this.cleanText(item.friendly_id);
    if (!friendlyId) return null;
    const url = employmentHeroPositionUrl(friendlyId);

    const { city, state } = this.splitLocation(item.vendor_location_name);
    const country = this.cleanText(item.country_code);
    const locationText = this.cleanText(item.vendor_location_name);
    const department = this.cleanText(item.team_name);
    const title = this.cleanText(item.title);
    const employmentType = this.cleanText(item.employment_type_name);

    return {
      atsId,
      url,
      // The Employment Hero detail page hosts the apply flow inline; the canonical apply URL is
      // the detail URL itself.
      applyUrl: url,
      title,
      companyName: this.cleanText(item.organisation_name) ?? companyName ?? this.deriveSlugName(slug),
      companyLogo: this.cleanText(item.organisation_logo),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(item.description),
      department,
      employmentType,
      datePosted: this.parseDate(item.created_at),
      isRemote: this.detectRemote(item, title, locationText, department),
    };
  }

  /** Map a normalised EmploymentHeroJob → JobPostDto. */
  private processJob(
    job: EmploymentHeroJob,
    slug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveSlugName(slug);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `employmenthero-${atsId}`,
      title,
      companyName,
      companyLogo: job.companyLogo ?? null,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.EMPLOYMENTHERO,
      atsId,
      atsType: 'employmenthero',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Employment Hero exposes the body
   * as HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare board URL passed
   * as the slug is reduced to its `/organisations/{slug}` token); a `companyUrl` on an
   * Employment Hero host has the slug taken from its `/organisations/{slug}` path. Returns an
   * empty string when neither yields a slug.
   */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full board URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(EMPLOYMENTHERO_ROOT_DOMAIN + '/')) {
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
   * Derive the tenant slug from an Employment Hero board URL. The candidate-facing board is
   * `jobs.employmenthero.com/organisations/{slug}` (canonically
   * `employmenthero.com/jobs/organisations/{slug}/`); the slug is the first path segment after
   * `/organisations/`.
   */
  private slugFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      // Accept the board host or any *.employmenthero.com host bearing an /organisations/ path.
      if (!hostname.endsWith(EMPLOYMENTHERO_ROOT_DOMAIN) && hostname !== EMPLOYMENTHERO_BOARD_HOST) {
        return '';
      }
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      const idx = segments.findIndex((s) => s.toLowerCase() === 'organisations');
      if (idx >= 0 && segments[idx + 1]) {
        return decodeURIComponent(segments[idx + 1]).toLowerCase();
      }
      // A `/jobs/position/{id}/` URL carries no tenant slug.
      return '';
    } catch {
      // Malformed URL — no slug.
    }
    return '';
  }

  /** Assemble the public career-page jobs feed URL for a tenant slug and page. */
  private buildFeedUrl(slug: string, page: number): string {
    const params = new URLSearchParams({
      page_index: String(page),
      item_per_page: String(EMPLOYMENTHERO_PAGE_SIZE),
    });
    return `${employmentHeroJobsUrl(slug)}?${params.toString()}`;
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
   * Surface the role's location parts as a LocationDto, leaving location null when nothing usable
   * is present.
   */
  private extractLocation(job: EmploymentHeroJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Split the free-text `vendor_location_name` line (e.g. `Greater London, SouthEast E1`,
   * `Sydney, NSW 2000`) into a best-effort city / state pair. The first comma-delimited token is
   * treated as the city; the remainder (minus a trailing postcode) as the state / region. When
   * there is no comma the whole line is treated as the city.
   */
  private splitLocation(value: string | null | undefined): {
    city: string | null;
    state: string | null;
  } {
    const cleaned = this.cleanText(value);
    if (!cleaned) return { city: null, state: null };
    const parts = cleaned
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length === 0) return { city: null, state: null };
    const city = parts[0] || null;
    if (parts.length === 1) return { city, state: null };
    // Strip a trailing postcode-like token from the region remainder.
    const region = parts
      .slice(1)
      .join(', ')
      .replace(/\s+[A-Z0-9]{2,8}$/i, '')
      .trim();
    return { city, state: region.length > 0 ? region : parts.slice(1).join(', ').trim() || null };
  }

  /**
   * Detect remote roles from the structured `remote` flag and `workplace_type` token, then from
   * the title, location, or team text.
   */
  private detectRemote(
    item: EmploymentHeroJobItem,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    if (item.remote === true) return true;
    if (item.remote_setting && item.remote_setting.anywhere === true) return true;
    const workplace = this.cleanText(item.workplace_type);
    if (workplace && workplace.toLowerCase().includes(EMPLOYMENTHERO_REMOTE_TYPE)) {
      return true;
    }
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (EMPLOYMENTHERO_REMOTE_REGEX.test(field)) return true;
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

  /** Coerce a numeric-or-string value into a finite integer, else null. */
  private toFiniteInt(value: number | string | null | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string') {
      const n = Number(value.trim());
      if (Number.isFinite(n)) return Math.trunc(n);
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
