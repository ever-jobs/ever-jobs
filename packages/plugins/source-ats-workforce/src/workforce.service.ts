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
  WORKFORCE_ROOT_DOMAIN,
  WORKFORCE_REGION_HOSTS,
  WORKFORCE_APPLY_PATH,
  WORKFORCE_BOARD_PATHS,
  WORKFORCE_DEFAULT_RESULTS,
  WORKFORCE_MAX_DETAIL_PAGES,
  WORKFORCE_MAX_BOARD_PAGES,
  WORKFORCE_DEFAULT_TIMEOUT_SECONDS,
  WORKFORCE_HEADERS,
  WORKFORCE_APPLY_LINK_REGEX,
  WORKFORCE_UUID_REGEX,
  WORKFORCE_LD_JSON_REGEX,
  WORKFORCE_TITLE_REGEX,
  WORKFORCE_OG_TITLE_REGEX,
  WORKFORCE_OG_DESCRIPTION_REGEX,
  WORKFORCE_REMOTE_REGEX,
  WORKFORCE_REMOTE_LOCATION_TYPE,
  workforceOrigin,
} from './workforce.constants';
import {
  WorkforceJob,
  WorkforceJobRef,
  WorkforceJobPostingLd,
  WorkforcePostalAddress,
} from './workforce.types';

/**
 * Workforce.com ATS hiring scraper — generic, multi-tenant.
 *
 * Workforce.com (workforce.com — a US / AU / UK workforce-management + hiring platform for
 * hourly, shift-based businesses) powers each customer's public, unauthenticated
 * candidate-facing hiring surface on a regional host (`app.workforce.com` /
 * `eu.workforce.com`). Each open role has a public, anonymous apply page at
 *
 *   https://{region}.workforce.com/ats/apply/job/{uuid}
 *
 * that server-renders the full role detail (title, employer brand, a postal-address location
 * line, the role description) plus the application form. A tenant's careers / board page links
 * to those apply pages. The adapter harvests every distinct `/ats/apply/job/{uuid}` link from
 * the board HTML (a single apply URL degrades to a one-role board), then parses each role's
 * apply page — preferring a schema.org `JobPosting` `application/ld+json` island when present
 * and degrading to scraped `<title>` / `og:` meta otherwise. No headless browser, no auth, no
 * API key.
 *
 * The caller addresses a tenant by `companyUrl` (a careers / board URL, or a single
 * `/ats/apply/job/{uuid}` apply URL) or by `companySlug` (a UUID used directly, else a slug
 * probed against defensive Workforce-hosted board paths). An unknown tenant, one with no open
 * roles, or an empty board degrades naturally to an empty result. A fetch error, an HTTP 4xx,
 * a DNS failure, or a malformed body degrades to an empty / partial result rather than
 * throwing, so a single tenant never nukes a batch run.
 *
 * Surface confidence (researched 2026-06-03, no authentication): the per-role apply page
 * `/ats/apply/job/{uuid}` is VERIFIED live (confirmed against Workforce.com's own hiring, a
 * real named tenant); the multi-tenant board-enumeration (link harvest + slug probe) is built
 * DEFENSIVELY from the documented apply-URL pattern and is not independently verified.
 */
@SourcePlugin({
  site: Site.WORKFORCE,
  name: 'Workforce.com',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class WorkforceService implements IScraper {
  private readonly logger = new Logger(WorkforceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Workforce.com scraper');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Workforce host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path
    // keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter
    // timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? WORKFORCE_DEFAULT_TIMEOUT_SECONDS,
      WORKFORCE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(WORKFORCE_HEADERS);

    const resultsWanted = input.resultsWanted ?? WORKFORCE_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(
        `Fetching Workforce.com jobs for ${input.companyUrl ?? `slug:${companySlug}`}`,
      );

      // Enumerate the tenant's open-role apply refs (from a board URL, a single apply URL, or
      // a defensive slug probe). An empty list is a valid "no roles" / unreachable result.
      const refs = await this.collectJobRefs(client, companySlug, input.companyUrl);
      if (refs.length === 0) {
        this.logger.log('Workforce.com tenant has no reachable open-roles board');
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      let detailFetches = 0;
      for (const ref of refs) {
        if (jobPosts.length >= resultsWanted) break;
        if (detailFetches >= WORKFORCE_MAX_DETAIL_PAGES) break;
        if (seen.has(ref.uuid)) continue; // dedup by ATS id (UUID)
        seen.add(ref.uuid);
        detailFetches++;
        try {
          const post = await this.processRef(client, ref, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Workforce.com role ${ref.uuid}: ${err.message}`);
        }
      }

      this.logger.log(`Workforce.com total: ${jobPosts.length} jobs`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Workforce.com scrape error: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Enumerate a tenant's open-role apply refs. Resolution order:
   *  1. `companyUrl` is itself an `/ats/apply/job/{uuid}` apply URL → a one-role board.
   *  2. `companyUrl` is a careers / board page → harvest every `/ats/apply/job/{uuid}` link.
   *  3. `companySlug` is a bare role UUID → a one-role board on each region host (first
   *     reachable wins).
   *  4. `companySlug` is a tenant slug → probe defensive Workforce-hosted board paths across
   *     the region hosts, harvesting apply links from the first page that yields any.
   * Returns a deduped (by UUID) list, or an empty list when nothing is reachable.
   */
  private async collectJobRefs(
    client: ReturnType<typeof createHttpClient>,
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): Promise<WorkforceJobRef[]> {
    // (1) / (2) — caller-supplied board / apply URL.
    if (companyUrl && companyUrl.trim()) {
      const direct = this.refFromApplyUrl(companyUrl);
      if (direct) return [direct];
      const refs = await this.harvestBoard(client, companyUrl);
      if (refs.length > 0) return refs;
    }

    // A `companyUrl` may also be passed as the slug; honour that before the slug paths.
    if (companySlug && /^https?:\/\//i.test(companySlug.trim())) {
      const direct = this.refFromApplyUrl(companySlug.trim());
      if (direct) return [direct];
      const refs = await this.harvestBoard(client, companySlug.trim());
      if (refs.length > 0) return refs;
    }

    if (!companySlug || !companySlug.trim()) return [];
    const slug = companySlug.trim();

    // (3) — bare role UUID passed as the slug.
    if (WORKFORCE_UUID_REGEX.test(slug)) {
      for (const host of WORKFORCE_REGION_HOSTS) {
        const url = this.buildApplyUrl(host, slug.toLowerCase());
        // Confirm the apply page is reachable on this region host before committing to it.
        const { data, hostReachable } = await this.fetchHtml(client, url, slug);
        if (data != null) return [{ uuid: slug.toLowerCase(), url }];
        if (!hostReachable) continue; // try the next region
      }
      return [];
    }

    // (4) — tenant slug → defensive board-path probe across region hosts.
    return this.probeSlugBoard(client, slug.toLowerCase());
  }

  /**
   * Probe the defensive Workforce-hosted board paths (`/ats/{slug}`, `/careers/{slug}`,
   * `/jobs/{slug}`) across the region hosts. The first page that yields any
   * `/ats/apply/job/{uuid}` links wins; its harvested refs are returned. A transport-level
   * failure on a host aborts that host (its other paths can't succeed) and moves to the next.
   * These paths are documented-but-unverified, so a clean miss returns an empty list.
   */
  private async probeSlugBoard(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
  ): Promise<WorkforceJobRef[]> {
    let attempts = 0;
    for (const host of WORKFORCE_REGION_HOSTS) {
      let hostDown = false;
      for (const tpl of WORKFORCE_BOARD_PATHS) {
        if (attempts >= WORKFORCE_MAX_BOARD_PAGES) return [];
        attempts++;
        const path = tpl.replace('{slug}', encodeURIComponent(slug));
        const url = `${workforceOrigin(host)}/${path}`;
        const { data: html, hostReachable } = await this.fetchHtml(client, url, slug);
        if (!hostReachable) {
          hostDown = true;
          break; // host unreachable — its other board paths can't succeed
        }
        if (html == null) continue;
        const refs = this.harvestApplyLinks(html, host);
        if (refs.length > 0) return refs;
      }
      if (hostDown) continue;
    }
    return [];
  }

  /**
   * Fetch a board / careers page and harvest every distinct `/ats/apply/job/{uuid}` apply
   * link from its HTML, pinning the region host from the board URL. Returns an empty list when
   * the page is unreachable or carries no apply links.
   */
  private async harvestBoard(
    client: ReturnType<typeof createHttpClient>,
    boardUrl: string,
  ): Promise<WorkforceJobRef[]> {
    const host = this.hostFromUrl(boardUrl) ?? WORKFORCE_REGION_HOSTS[0];
    const { data: html } = await this.fetchHtml(client, this.ensureAbsolute(boardUrl), host);
    if (html == null) return [];
    return this.harvestApplyLinks(html, host);
  }

  /**
   * Harvest distinct role refs from a page's HTML by sweeping every `/ats/apply/job/{uuid}`
   * link. UUIDs are lower-cased and de-duplicated; the absolute apply URL is rebuilt on the
   * pinned region host so a relative link still resolves.
   */
  private harvestApplyLinks(html: string, host: string): WorkforceJobRef[] {
    const refs: WorkforceJobRef[] = [];
    const seen = new Set<string>();
    WORKFORCE_APPLY_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WORKFORCE_APPLY_LINK_REGEX.exec(html)) !== null) {
      const uuid = match[1]?.toLowerCase();
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      refs.push({ uuid, url: this.buildApplyUrl(host, uuid) });
    }
    return refs;
  }

  /** Recognise a caller-supplied `/ats/apply/job/{uuid}` apply URL as a one-role ref. */
  private refFromApplyUrl(value: string): WorkforceJobRef | null {
    WORKFORCE_APPLY_LINK_REGEX.lastIndex = 0;
    const match = WORKFORCE_APPLY_LINK_REGEX.exec(value);
    if (!match || !match[1]) return null;
    const uuid = match[1].toLowerCase();
    const host = this.hostFromUrl(value) ?? WORKFORCE_REGION_HOSTS[0];
    return { uuid, url: this.buildApplyUrl(host, uuid) };
  }

  /**
   * Parse a single role's apply page → JobPostDto. Fetches the apply HTML, extracts the
   * richest available role shape (schema.org JobPosting ld+json first, else scraped
   * title / og: meta), normalises, and maps. Returns null when the role yields no usable
   * title.
   */
  private async processRef(
    client: ReturnType<typeof createHttpClient>,
    ref: WorkforceJobRef,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const { data: html } = await this.fetchHtml(client, ref.url, ref.uuid);
    if (html == null) return null;
    const job = this.normaliseRole(html, ref);
    if (!job) return null;
    return this.processJob(job, format);
  }

  /**
   * Build a normalised WorkforceJob from a role apply page. Prefers a schema.org JobPosting
   * `application/ld+json` block; falls back to the document `<title>` / `og:title` for the
   * title and `og:description` for the body. Returns null when no usable title is found.
   */
  private normaliseRole(html: string, ref: WorkforceJobRef): WorkforceJob | null {
    const ld = this.extractJobPostingLd(html);

    const title =
      this.cleanText(ld?.title) ??
      this.cleanText(this.firstGroup(html, WORKFORCE_OG_TITLE_REGEX)) ??
      this.cleanText(this.decodeEntities(this.firstGroup(html, WORKFORCE_TITLE_REGEX)));
    if (!title) return null;

    const org = this.firstOf(ld?.hiringOrganization);
    const companyName = this.cleanText(org?.name);

    const location = this.firstOf(ld?.jobLocation);
    const address = location?.address ?? null;
    const city = this.cleanText(address?.addressLocality);
    const state = this.cleanText(address?.addressRegion);
    const country = this.cleanText(this.countryName(address));
    const locationText = this.joinLocation(city, state, country);

    const descriptionHtml =
      this.cleanText(ld?.description) ??
      this.cleanText(this.firstGroup(html, WORKFORCE_OG_DESCRIPTION_REGEX));

    return {
      atsId: ref.uuid,
      url: ref.url,
      // The Workforce apply page hosts the application form inline; the canonical apply URL is
      // the detail URL itself.
      applyUrl: ref.url,
      title,
      companyName,
      city,
      state,
      country,
      locationText,
      descriptionHtml,
      employmentType: this.formatEmploymentType(ld?.employmentType),
      datePosted: this.parseDate(ld?.datePosted),
      isRemote: this.detectRemote(ld, title, locationText, descriptionHtml),
    };
  }

  /** Map a normalised WorkforceJob → JobPostDto. */
  private processJob(job: WorkforceJob, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveHostName(job.url);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `workforce-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.WORKFORCE,
      atsId,
      atsType: 'workforce',
      department: null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Extract the schema.org `JobPosting` block from a role page's `application/ld+json`
   * island(s). Sweeps every ld+json script, parsing each (an array or `@graph` is flattened)
   * and returning the first block whose `@type` includes `JobPosting`. Returns null when none
   * is present / parseable (the caller degrades to scraped title / meta).
   */
  private extractJobPostingLd(html: string): WorkforceJobPostingLd | null {
    WORKFORCE_LD_JSON_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WORKFORCE_LD_JSON_REGEX.exec(html)) !== null) {
      const raw = match[1];
      if (!raw || !raw.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        // One unparseable block must not abort the sweep — try the next ld+json island.
        continue;
      }
      const found = this.findJobPosting(parsed);
      if (found) return found;
    }
    return null;
  }

  /**
   * Walk a parsed ld+json value (object, array, or `@graph` container) for the first node
   * whose `@type` includes `JobPosting`.
   */
  private findJobPosting(value: unknown): WorkforceJobPostingLd | null {
    if (Array.isArray(value)) {
      for (const el of value) {
        const found = this.findJobPosting(el);
        if (found) return found;
      }
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    const node = value as Record<string, unknown>;
    if (this.typeIncludes(node['@type'], 'JobPosting')) {
      return node as WorkforceJobPostingLd;
    }
    if (Array.isArray(node['@graph'])) {
      return this.findJobPosting(node['@graph']);
    }
    return null;
  }

  /** True when a schema.org `@type` value (string or array) includes the wanted type. */
  private typeIncludes(type: unknown, wanted: string): boolean {
    if (typeof type === 'string') return type.toLowerCase() === wanted.toLowerCase();
    if (Array.isArray(type)) {
      return type.some((t) => typeof t === 'string' && t.toLowerCase() === wanted.toLowerCase());
    }
    return false;
  }

  /**
   * Convert the role description body per `descriptionFormat`. Workforce apply pages expose
   * the body as HTML when present, so HTML returns it as-is, Markdown converts it, and Plain
   * strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * GET a Workforce URL as text. Returns `{ data, hostReachable }`:
   *  - `data` is the body, or null when the response carried no usable text / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the host itself is unreachable and the caller should stop
   *    probing further variations on that host.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    label: string,
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
        // caller may still try other variations.
        this.logger.warn(`Workforce.com returned HTTP ${status} for ${label}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the host
      // is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Workforce.com fetch failed for ${label}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /** Assemble the canonical `{origin}/ats/apply/job/{uuid}` public apply URL for a role. */
  private buildApplyUrl(host: string, uuid: string): string {
    return `${workforceOrigin(host)}/${WORKFORCE_APPLY_PATH}/${encodeURIComponent(uuid)}`;
  }

  /**
   * Extract the host from a URL, returning it only when it is a Workforce host
   * (`*.workforce.com`); otherwise null (so the caller falls back to the default region host).
   */
  private hostFromUrl(value: string): string | null {
    try {
      const u = new URL(this.ensureAbsolute(value));
      const hostname = u.hostname.toLowerCase();
      if (hostname === WORKFORCE_ROOT_DOMAIN || hostname.endsWith(`.${WORKFORCE_ROOT_DOMAIN}`)) {
        return hostname;
      }
    } catch {
      // Malformed URL — no host.
    }
    return null;
  }

  /** Prefix a bare host / path with https:// so `new URL` / a GET can consume it. */
  private ensureAbsolute(value: string): string {
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  }

  /** De-slugify + title-case a Workforce host's leading label into a display company name. */
  private deriveHostName(url: string): string {
    const host = this.hostFromUrl(url);
    if (!host) return 'Workforce.com';
    const label = host.split('.')[0];
    if (!label || label === 'app' || label === 'eu' || label === 'www') return 'Workforce.com';
    return label.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: WorkforceJob): LocationDto | null {
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
   * Detect remote roles from the structured `jobLocationType` (`TELECOMMUTE`) flag, then from
   * the title, location, or description text.
   */
  private detectRemote(
    ld: WorkforceJobPostingLd | null,
    title: string | null,
    location: string | null,
    description: string | null,
  ): boolean {
    const locType = this.cleanText(ld?.jobLocationType);
    if (locType && locType.toUpperCase() === WORKFORCE_REMOTE_LOCATION_TYPE) return true;
    const haystacks: Array<string | null> = [title, location, description];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (WORKFORCE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Format a schema.org employmentType token (or array) into a display label (e.g. `Full Time`). */
  private formatEmploymentType(value: string | string[] | null | undefined): string | null {
    const first = Array.isArray(value) ? value.find((v) => typeof v === 'string') : value;
    const cleaned = this.cleanText(typeof first === 'string' ? first : null);
    if (!cleaned) return null;
    return cleaned
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Resolve a country name from a schema.org `addressCountry` (string or `{ name }` object). */
  private countryName(address: WorkforcePostalAddress | null): string | null {
    const c = address?.addressCountry;
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object') return this.cleanText(c.name);
    return null;
  }

  /** Return the first element of a possibly-array schema.org value, else the value itself. */
  private firstOf<T>(value: T | T[] | null | undefined): T | null {
    if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
    return value ?? null;
  }

  /** Run a single-capture regex over HTML, returning the first group or null. */
  private firstGroup(html: string, regex: RegExp): string | null {
    const re = new RegExp(regex.source, regex.flags.replace('g', ''));
    const match = re.exec(html);
    return match && match[1] ? match[1] : null;
  }

  /** Decode the handful of HTML entities that show up in a scraped `<title>`. */
  private decodeEntities(value: string | null): string | null {
    if (!value) return value;
    return value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'");
  }

  /**
   * Parse an ISO timestamp value into a YYYY-MM-DD string. Non-absolute / unparseable values
   * yield null.
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
