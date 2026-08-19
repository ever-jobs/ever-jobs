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
  VIDCRUITER_ROOT_DOMAIN,
  VIDCRUITER_DEFAULT_BOARD_SLUG,
  VIDCRUITER_DEFAULT_RESULTS,
  VIDCRUITER_MAX_PAGES,
  VIDCRUITER_DEFAULT_TIMEOUT_SECONDS,
  VIDCRUITER_HEADERS,
  VIDCRUITER_REMOTE_REGEX,
  vidcruiterFeedUrl,
} from './vidcruiter.constants';
import {
  VidCruiterProcessItem,
  VidCruiterFeedResponse,
  VidCruiterJob,
} from './vidcruiter.types';

/** A resolved VidCruiter board target: the tenant subdomain plus its board slug. */
interface VidCruiterTarget {
  /** Tenant subdomain on `hiringplatform.com` (e.g. `vidcruiter`). */
  tenant: string;
  /** Board slug under `/list/{slug}` (default `careers`). */
  slug: string;
}

/**
 * VidCruiter ATS careers scraper — generic, multi-tenant.
 *
 * VidCruiter (vidcruiter.com, Moncton NB — a global video-interviewing & applicant-tracking
 * platform serving public-sector agencies, education, and enterprise) powers each customer's
 * branded, public, unauthenticated candidate-facing job board on the shared hosted apply domain
 * `hiringplatform.com`, addressed by a per-tenant **subdomain** plus a board slug:
 * `https://{tenant}.hiringplatform.com/list/{slug}/`. The board is a client-rendered SPA backed
 * by a single **public, anonymous JSON feed** it consumes (no bearer token, no cookie):
 *
 *   GET https://{tenant}.hiringplatform.com/list/{slug}.json?page={n}
 *     → { business_processes: [ { id, name, url, country_code, state_code, city, postal_code } ] }
 *
 * The adapter resolves the tenant subdomain + board slug, then drains the board feed (the
 * envelope carries no pagination meta, so it walks `page` until a page returns an empty
 * `business_processes` array, bounded by a page cap), and maps each role — rather than depending
 * on a client-rendered DOM, a headless browser, or any authenticated VidCruiter API. Each role's
 * numeric `id` is the stable ATS id, and its `url` is the canonical public
 * `/processes/{uuid}?locale=en` detail / apply page.
 *
 * The caller addresses a tenant by `companySlug` (the tenant subdomain, optionally `tenant/slug`
 * to name a non-default board) or by `companyUrl` (a `{tenant}.hiringplatform.com/list/{slug}`
 * URL). An unknown tenant, a board with no roles, or an empty roster degrades naturally to an
 * empty result. A fetch error, an HTTP 4xx, a DNS failure, or a malformed body degrades to an
 * empty / partial result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.VIDCRUITER,
  name: 'VidCruiter',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class VidCruiterService implements IScraper {
  private readonly logger = new Logger(VidCruiterService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for VidCruiter scraper');
      return new JobResponseDto([]);
    }

    const target = this.resolveTarget(companySlug, input.companyUrl);
    if (!target) {
      this.logger.warn('Could not resolve a VidCruiter tenant from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive VidCruiter host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path keys
    // off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter timeout;
    // we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? VIDCRUITER_DEFAULT_TIMEOUT_SECONDS,
      VIDCRUITER_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(VIDCRUITER_HEADERS);

    const resultsWanted = input.resultsWanted ?? VIDCRUITER_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(
        `Fetching VidCruiter jobs for tenant: ${target.tenant} (board: ${target.slug})`,
      );

      const companyName = this.deriveTenantName(target.tenant);
      const seen = new Set<string>();

      // Drain the paginated public board feed. The envelope carries no pagination meta, so we
      // stop when a page returns an empty `business_processes` array, when we hit the page cap, or
      // once `resultsWanted` roles are collected. A transport-level failure (host unreachable)
      // aborts the sweep; an HTTP error / malformed page degrades to an empty / partial result.
      for (let page = 1; page <= VIDCRUITER_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, target, page);
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / unparseable body → stop draining

        const items = Array.isArray(body.business_processes) ? body.business_processes : [];
        if (items.length === 0) break; // past the last page

        for (const item of items) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processItem(
              item,
              target,
              companyName,
              input.descriptionFormat,
              seen,
            );
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing VidCruiter role ${item?.id}: ${err.message}`);
          }
        }
      }

      this.logger.log(`VidCruiter total: ${jobPosts.length} jobs for ${target.tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`VidCruiter scrape error for ${target.tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET one page of the public board feed as JSON. Returns `{ data, hostReachable }`:
   *  - `data` is the parsed `{ business_processes: [...] }` envelope, or null when the response
   *    carried no usable JSON / the host answered an HTTP error status (4xx / 5xx — a real,
   *    reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the host itself is unreachable and the caller should stop draining
   *    further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    target: VidCruiterTarget,
    page: number,
  ): Promise<{ data: VidCruiterFeedResponse | null; hostReachable: boolean }> {
    const url = vidcruiterFeedUrl(target.tenant, target.slug, page);
    try {
      const response = await client.get<VidCruiterFeedResponse | string>(url);
      const parsed = this.coerceFeed(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, but there is nothing
        // more to drain.
        this.logger.warn(`VidCruiter feed returned HTTP ${status} for ${target.tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the host is
      // unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(
        `VidCruiter feed fetch failed for ${target.tenant}: ${err?.message ?? err}`,
      );
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce an axios response body into a parsed board-feed envelope. The client usually parses
   * the JSON for us (object body); a text/plain string body is parsed defensively. A non-object /
   * unparseable body yields null (degrade to no roles).
   */
  private coerceFeed(data: VidCruiterFeedResponse | string | unknown): VidCruiterFeedResponse | null {
    return this.coerceObject<VidCruiterFeedResponse>(data);
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
        this.logger.warn(`VidCruiter JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: VidCruiterProcessItem,
    target: VidCruiterTarget,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, target, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, target, format);
  }

  /** Build a normalised VidCruiterJob from a parsed role. */
  private normaliseItem(
    item: VidCruiterProcessItem,
    target: VidCruiterTarget,
    companyName: string,
  ): VidCruiterJob | null {
    const atsId = this.cleanText(this.toStringId(item.id));
    if (!atsId) return null;

    // The feed always carries the canonical detail / apply URL in `url`.
    const url = this.cleanText(item.url);
    if (!url) return null;

    const city = this.cleanText(item.city);
    const state = this.cleanText(item.state_code);
    const country = this.cleanText(item.country_code);
    const locationText = this.joinLocation(city, state, country);
    const title = this.cleanText(item.name);

    return {
      atsId,
      url,
      // The VidCruiter detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName: companyName ?? this.deriveTenantName(target.tenant),
      city,
      state,
      country,
      locationText,
      // The board feed carries no description, employment type, department, or date.
      descriptionHtml: null,
      department: null,
      employmentType: null,
      datePosted: null,
      isRemote: this.detectRemote(title, locationText),
    };
  }

  /** Map a normalised VidCruiterJob → JobPostDto. */
  private processJob(
    job: VidCruiterJob,
    target: VidCruiterTarget,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveTenantName(target.tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `vidcruiter-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.VIDCRUITER,
      atsId,
      atsType: 'vidcruiter',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. The board feed exposes no
   * description body, so this returns null for feed-sourced roles; the branch is retained so a
   * future feed shape that inlines HTML formats correctly (HTML as-is, Markdown converted, Plain
   * stripped).
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the VidCruiter board target (tenant subdomain + board slug). An explicit
   * `companySlug` is used directly — a bare `tenant` targets the default `careers` board, a
   * `tenant/slug` token names a specific board, and a full board URL passed as the slug is
   * reduced to its host + `/list/{slug}` token. A `companyUrl` on a `hiringplatform.com` host has
   * the tenant taken from its subdomain and the slug from its `/list/{slug}` path. Returns null
   * when neither yields a tenant.
   */
  private resolveTarget(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): VidCruiterTarget | null {
    if (companySlug && companySlug.trim()) {
      const raw = companySlug.trim();
      // A caller may also pass a full board URL as the slug.
      if (/^https?:\/\//i.test(raw) || raw.includes(VIDCRUITER_ROOT_DOMAIN)) {
        const fromUrl = this.targetFromUrl(raw);
        if (fromUrl) return fromUrl;
      }
      // Otherwise interpret as `tenant` or `tenant/slug`.
      const segments = raw
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const tenant = this.sanitiseTenant(segments[0]);
      if (!tenant) return null;
      const slug = segments[1]
        ? this.sanitiseSlug(segments[1])
        : VIDCRUITER_DEFAULT_BOARD_SLUG;
      return { tenant, slug: slug || VIDCRUITER_DEFAULT_BOARD_SLUG };
    }
    if (companyUrl) {
      const fromUrl = this.targetFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return null;
  }

  /**
   * Derive the board target from a VidCruiter board URL. The candidate-facing board is
   * `{tenant}.hiringplatform.com/list/{slug}`; the tenant is the leftmost subdomain label and the
   * slug is the segment after `/list/` (default `careers`). A `/processes/{uuid}` URL carries the
   * tenant but no board slug, so it falls back to the default board.
   */
  private targetFromUrl(value: string): VidCruiterTarget | null {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith('.' + VIDCRUITER_ROOT_DOMAIN)) return null;
      const tenant = this.sanitiseTenant(hostname.slice(0, -('.' + VIDCRUITER_ROOT_DOMAIN).length));
      if (!tenant) return null;
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      const listIdx = segments.findIndex((s) => s.toLowerCase() === 'list');
      if (listIdx >= 0 && segments[listIdx + 1]) {
        // The board page may carry a `.json` extension on the slug segment; strip it.
        const slug = this.sanitiseSlug(
          decodeURIComponent(segments[listIdx + 1]).replace(/\.json$/i, ''),
        );
        return { tenant, slug: slug || VIDCRUITER_DEFAULT_BOARD_SLUG };
      }
      return { tenant, slug: VIDCRUITER_DEFAULT_BOARD_SLUG };
    } catch {
      // Malformed URL — no target.
    }
    return null;
  }

  /** Sanitise a tenant subdomain label (lowercase, only DNS-safe characters). */
  private sanitiseTenant(value: string | undefined): string {
    if (!value) return '';
    const cleaned = value.trim().toLowerCase();
    // A multi-label subdomain (e.g. `careers.acme`) keeps only its leftmost label as the tenant.
    const firstLabel = cleaned.split('.').filter((s) => s.length > 0)[0] ?? '';
    return /^[a-z0-9][a-z0-9-]*$/.test(firstLabel) ? firstLabel : '';
  }

  /** Sanitise a board slug (lowercase, trimmed of empties). */
  private sanitiseSlug(value: string | undefined): string {
    if (!value) return '';
    return value.trim().toLowerCase();
  }

  /** De-slugify + title-case the tenant subdomain into a display company name. */
  private deriveTenantName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base
      .replace(/[-_.]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing usable
   * is present.
   */
  private extractLocation(job: VidCruiterJob): LocationDto | null {
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

  /** Detect remote roles from the title and location text. */
  private detectRemote(title: string | null, location: string | null): boolean {
    const haystacks: Array<string | null | undefined> = [title, location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (VIDCRUITER_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Coerce a numeric-or-string id into a string, else null. */
  private toStringId(value: string | number | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string') return value;
    return null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
