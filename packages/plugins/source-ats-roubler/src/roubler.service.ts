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
  ROUBLER_ROOT_DOMAIN,
  ROUBLER_BOARD_HOST,
  ROUBLER_CAREERS_PATH,
  ROUBLER_DEFAULT_RESULTS,
  ROUBLER_MAX_PAGES,
  ROUBLER_DEFAULT_TIMEOUT_SECONDS,
  ROUBLER_HEADERS,
  ROUBLER_REMOTE_TYPE,
  ROUBLER_REMOTE_REGEX,
  roublerFeedUrl,
  roublerAdvertUrl,
} from './roubler.constants';
import {
  RoublerAdvertItem,
  RoublerAdvertLocation,
  RoublerFeedResponse,
  RoublerJob,
} from './roubler.types';

/**
 * Roubler ATS careers scraper — generic, multi-tenant.
 *
 * Roubler (roubler.com, founded 2012 — an Australian-headquartered, globally deployed
 * workforce-management, recruitment & payroll platform spanning AU / NZ / SG / MY / HK / UK)
 * powers each customer's branded, public, candidate-facing careers board on the shared
 * single-page application host `https://app.roubler.com/careers/{companyId}`. The board is a
 * client-rendered application backed by a **region-sharded careers API** under
 * `https://graphql.{region}.roubler.com/` (the AU shard is the platform's primary region, baked
 * into the board's runtime `config.js`), which exposes a `/static/` REST namespace the board
 * uses for its non-GraphQL static endpoints:
 *
 *   GET https://graphql.au.roubler.com/static/careers/{companyId}/adverts?page={n}
 *     → { data: [ { id, title, location, employmentType, description,
 *                   publishedAt, applyUrl, … } ], meta: { … } }
 *
 * The adapter resolves the tenant's careers company id, then drains the public job-advert feed
 * (the envelope is narrowed defensively — roles may arrive under `data` / `adverts` / `results`
 * or as a bare array — and pagination walks `page` until a page returns an empty role array,
 * bounded by a page cap), and maps each role — rather than depending on a client-rendered DOM, a
 * headless browser, or any authenticated Roubler API. Each role's id is the stable ATS id, and
 * its apply URL (or a derived `/careers/{companyId}/{id}` board URL) is the canonical public
 * detail / apply page.
 *
 * The caller addresses a tenant by `companySlug` (the careers company id, e.g. `acme`) or by
 * `companyUrl` (an `app.roubler.com/careers/{companyId}` URL). An unknown company id or an empty
 * board degrades naturally to an empty result. A fetch error, an HTTP 4xx, a DNS failure, or a
 * malformed body degrades to an empty / partial result rather than throwing, so a single tenant
 * never nukes a batch run.
 *
 * Surface confidence: researched live 2026-06-04, no authentication — verified=FALSE. The
 * platform, the shared application host `app.roubler.com`, the region-aliased hosts that
 * redirect to it, and the region-sharded backend + `/static/` namespace advertised in the
 * board's `config.js` were all confirmed live; an anonymous careers-feed JSON response could NOT
 * be captured (the board is client-rendered, the GraphQL endpoint requires an access token, and
 * `/static/*` answers HTTP 403 anonymously), so the feed path / shape / pagination are a
 * defensive best-effort model of the documented public careers surface.
 */
@SourcePlugin({
  site: Site.ROUBLER,
  name: 'Roubler',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class RoublerService implements IScraper {
  private readonly logger = new Logger(RoublerService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Roubler scraper');
      return new JobResponseDto([]);
    }

    const companyId = this.resolveCompanyId(companySlug, input.companyUrl);
    if (!companyId) {
      this.logger.warn('Could not resolve a Roubler tenant company id from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Roubler host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path keys
    // off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter
    // timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? ROUBLER_DEFAULT_TIMEOUT_SECONDS,
      ROUBLER_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(ROUBLER_HEADERS);

    const resultsWanted = input.resultsWanted ?? ROUBLER_DEFAULT_RESULTS;
    const companyName = this.deriveSlugName(companyId);
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Roubler adverts for company: ${companyId}`);

      const seen = new Set<string>();

      // Drain the paginated public careers feed. The envelope carries no guaranteed pagination
      // meta, so we stop when a page returns an empty role array, when we hit the page cap, or
      // once `resultsWanted` roles are collected. A transport-level failure (host unreachable)
      // aborts the sweep; an HTTP error / malformed page degrades to an empty / partial result.
      for (let page = 1; page <= ROUBLER_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, companyId, page);
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / unparseable body → stop draining

        const items = this.extractItems(body);
        if (items.length === 0) break; // past the last page

        for (const item of items) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processItem(
              item,
              companyId,
              companyName,
              input.descriptionFormat,
              seen,
            );
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Roubler role ${this.itemId(item)}: ${err.message}`);
          }
        }
      }

      this.logger.log(`Roubler total: ${jobPosts.length} jobs for ${companyId}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Roubler scrape error for ${companyId}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * GET one page of the public careers feed as JSON. Returns `{ data, hostReachable }`:
   *  - `data` is the parsed feed envelope, or null when the response carried no usable JSON / the
   *    host answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the host itself is unreachable and the caller should stop draining
   *    further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    companyId: string,
    page: number,
  ): Promise<{ data: RoublerFeedResponse | null; hostReachable: boolean }> {
    const url = roublerFeedUrl(companyId, page);
    try {
      const response = await client.get<RoublerFeedResponse | RoublerAdvertItem[] | string>(url);
      const parsed = this.coerceFeed(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, but there is nothing
        // more to drain.
        this.logger.warn(`Roubler feed returned HTTP ${status} for ${companyId} (page ${page})`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the host is
      // unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Roubler feed fetch failed for ${companyId}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce an axios response body into a parsed careers envelope. The client usually parses the
   * JSON for us (object / array body); a text/plain string body is parsed defensively. A bare
   * array body is wrapped as `{ data: [...] }`. A non-object / unparseable body yields null.
   */
  private coerceFeed(
    data: RoublerFeedResponse | RoublerAdvertItem[] | string | unknown,
  ): RoublerFeedResponse | null {
    if (Array.isArray(data)) return { data: data as RoublerAdvertItem[] };
    if (data && typeof data === 'object') return data as RoublerFeedResponse;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return { data: parsed as RoublerAdvertItem[] };
        if (parsed && typeof parsed === 'object') return parsed as RoublerFeedResponse;
      } catch (err: any) {
        this.logger.warn(`Roubler JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /**
   * Narrow the feed envelope to its role array. Roles may arrive under `data`, `adverts`, or
   * `results`; the first array-valued key wins. Returns an empty array when none is present.
   */
  private extractItems(body: RoublerFeedResponse): RoublerAdvertItem[] {
    if (Array.isArray(body.data)) return body.data;
    if (Array.isArray(body.adverts)) return body.adverts;
    if (Array.isArray(body.results)) return body.results;
    return [];
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: RoublerAdvertItem,
    companyId: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, companyId, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, companyId, format);
  }

  /** Build a normalised RoublerJob from a parsed role. */
  private normaliseItem(
    item: RoublerAdvertItem,
    companyId: string,
    companyName: string,
  ): RoublerJob | null {
    const atsId = this.itemId(item);
    if (!atsId) return null;

    // Prefer the feed's own apply / detail URL; fall back to a derived board detail URL.
    const url =
      this.cleanText(item.applyUrl) ??
      this.cleanText(item.url) ??
      this.cleanText(item.link) ??
      roublerAdvertUrl(companyId, atsId);

    const loc = this.normaliseLocation(item);
    const department = this.cleanText(item.department) ?? this.cleanText(item.category);
    const title =
      this.cleanText(item.title) ?? this.cleanText(item.name) ?? this.cleanText(item.position);
    const employmentType =
      this.cleanText(item.employmentType) ??
      this.cleanText(item.jobType) ??
      this.cleanText(item.type);

    return {
      atsId,
      url,
      // The Roubler detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName: this.cleanText(item.companyName) ?? this.cleanText(item.brand) ?? companyName,
      city: loc.city,
      state: loc.state,
      country: loc.country,
      locationText: loc.text,
      descriptionHtml:
        this.cleanText(item.description) ??
        this.cleanText(item.content) ??
        this.cleanText(item.summary),
      department,
      employmentType,
      datePosted: this.parseDate(item.publishedAt ?? item.datePosted ?? item.createdAt),
      isRemote: this.detectRemote(item, title, loc.text, department, employmentType),
    };
  }

  /** Map a normalised RoublerJob → JobPostDto. */
  private processJob(
    job: RoublerJob,
    companyId: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveSlugName(companyId);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `roubler-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.ROUBLER,
      atsId,
      atsType: 'roubler',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Roubler exposes the body as
   * HTML / rich text, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant careers company id. An explicit `companySlug` is used directly (a bare
   * board URL passed as the slug is reduced to its `/careers/{companyId}` token); a `companyUrl`
   * on an `app.roubler.com` host has the id taken from its `/careers/{companyId}` path. Returns
   * an empty string when neither yields an id.
   */
  private resolveCompanyId(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full board URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(ROUBLER_ROOT_DOMAIN + '/')) {
        const fromUrl = this.idFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.idFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant company id from a Roubler board URL. The candidate-facing board is
   * `app.roubler.com/careers/{companyId}`; the id is the first path segment after `/careers/`.
   */
  private idFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      // Accept the board host (app.roubler.com) or any *.roubler.com host bearing a /careers/.
      if (!hostname.endsWith(ROUBLER_ROOT_DOMAIN) && hostname !== ROUBLER_BOARD_HOST) return '';
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      const careersIdx = segments.findIndex((s) => s.toLowerCase() === ROUBLER_CAREERS_PATH);
      if (careersIdx >= 0 && segments[careersIdx + 1]) {
        return decodeURIComponent(segments[careersIdx + 1]).toLowerCase();
      }
      return '';
    } catch {
      // Malformed URL — no id.
    }
    return '';
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(companyId: string): string {
    const base = companyId && companyId.trim() ? companyId.trim() : companyId;
    // Drop a trailing TLD-like suffix before title-casing.
    const withoutTld = base.replace(/\.[a-z]{2,}$/i, '');
    return (withoutTld || base)
      .replace(/[-_.]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Reduce a role's location (nested object or flat fields or free-text) into structured
   * city / state / country parts plus a combined free-text line for remote detection.
   */
  private normaliseLocation(item: RoublerAdvertItem): {
    city: string | null;
    state: string | null;
    country: string | null;
    text: string | null;
  } {
    const loc = item.location;
    if (loc && typeof loc === 'object') {
      const l = loc as RoublerAdvertLocation;
      const city = this.cleanText(l.city) ?? this.cleanText(l.suburb);
      const state = this.cleanText(l.state) ?? this.cleanText(l.region);
      const country = this.cleanText(l.country);
      const pre = this.cleanText(l.name) ?? this.cleanText(l.label);
      const text = pre ?? this.joinLocation(city, state, country);
      return { city, state, country, text };
    }

    if (typeof loc === 'string') {
      const text = this.cleanText(loc);
      // Flat fields may still narrow the free-text line.
      const city = this.cleanText(item.city);
      const state = this.cleanText(item.state);
      const country = this.cleanText(item.country);
      return { city, state, country, text: text ?? this.joinLocation(city, state, country) };
    }

    const city = this.cleanText(item.city);
    const state = this.cleanText(item.state);
    const country = this.cleanText(item.country);
    return { city, state, country, text: this.joinLocation(city, state, country) };
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: RoublerJob): LocationDto | null {
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
   * Detect remote roles from an explicit `remote` flag, then the structured employment-type
   * token, then from the title, location, or department text.
   */
  private detectRemote(
    item: RoublerAdvertItem,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
    employmentType: string | null | undefined,
  ): boolean {
    if (item.remote === true) return true;
    if (
      typeof employmentType === 'string' &&
      employmentType.toLowerCase().includes(ROUBLER_REMOTE_TYPE)
    ) {
      return true;
    }
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (ROUBLER_REMOTE_REGEX.test(field)) return true;
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

  /** Resolve a role's stable id from its `id` / `advertId` / `uuid` keys, else null. */
  private itemId(item: RoublerAdvertItem): string | null {
    return (
      this.cleanText(this.toStringId(item.id)) ??
      this.cleanText(this.toStringId(item.advertId)) ??
      this.cleanText(item.uuid)
    );
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
