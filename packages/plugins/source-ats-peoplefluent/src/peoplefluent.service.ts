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
  PEOPLEFLUENT_ROOT_DOMAIN,
  PEOPLEFLUENT_CAREERS_HOST,
  PEOPLEFLUENT_CAREERS_HOST_TOKEN,
  PEOPLEFLUENT_INDEX_PATHS,
  PEOPLEFLUENT_LOCALES,
  PEOPLEFLUENT_DEFAULT_LOCALE_CODE,
  PEOPLEFLUENT_DETAIL_PATH,
  PEOPLEFLUENT_DEFAULT_RESULTS,
  PEOPLEFLUENT_MAX_PAGES,
  PEOPLEFLUENT_DEFAULT_TIMEOUT_SECONDS,
  PEOPLEFLUENT_HEADERS,
  PEOPLEFLUENT_JOB_ANCHOR_REGEX,
  PEOPLEFLUENT_JOB_ID_REGEX,
  PEOPLEFLUENT_REMOTE_REGEX,
  peopleFluentBasePath,
} from './peoplefluent.constants';
import { PeopleFluentListing, PeopleFluentJob } from './peoplefluent.types';

/**
 * PeopleFluent ATS careers scraper — generic, multi-tenant.
 *
 * PeopleFluent (peoplefluent.com, US — a global enterprise talent-management /
 * recruiting suite) hosts each customer's branded, public, unauthenticated
 * candidate-facing career site on the shared PeopleClick Recruiting Management System
 * (RMS) careers host. A tenant is addressed by its RMS client code as a path segment:
 *
 *   https://careers.peopleclick.com/careerscp/client_{tenant}/external/...
 *
 * The candidate board is a thin server-rendered shell whose results view renders the
 * open roles as a list of anchors, each pointing at the role's canonical detail page:
 *
 *   …/external/jobDetails/jobDetail.html?jobPostId={id}&localeCode={locale}
 *
 * The adapter probes the tenant's public gateway / search surface across the known
 * locale + entry-path variants, extracts the `jobDetail.html?jobPostId={id}` anchors
 * (taking the anchor text as a title hint), de-duplicates by the stable numeric
 * `jobPostId` (the ATS id), and builds the canonical detail / apply URL — rather than
 * depending on a client-rendered DOM or a headless browser.
 *
 * The caller addresses a tenant by `companySlug` (the RMS client code, e.g. `mit`) or by
 * `companyUrl` (a career-site URL on a `peopleclick.com` / `peoplefluent.com` host whose
 * `client_{tenant}` path segment encodes the tenant). An unknown tenant, one with no open
 * roles, or an empty board degrades naturally to an empty result. A fetch error, an HTTP
 * 4xx, a DNS failure, or a malformed body degrades to an empty / partial result rather
 * than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.PEOPLEFLUENT,
  name: 'PeopleFluent',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PeopleFluentService implements IScraper {
  private readonly logger = new Logger(PeopleFluentService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for PeopleFluent scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a PeopleFluent tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive PeopleFluent career host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH keys:
    // the no-proxy path keys off `timeout`, the proxy path off `requestTimeout`. A caller
    // may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? PEOPLEFLUENT_DEFAULT_TIMEOUT_SECONDS,
      PEOPLEFLUENT_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(PEOPLEFLUENT_HEADERS);

    const resultsWanted = input.resultsWanted ?? PEOPLEFLUENT_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching PeopleFluent jobs for tenant: ${tenant}`);

      const found = await this.fetchListings(client, tenant);
      if (!found) {
        this.logger.log(`PeopleFluent tenant "${tenant}" has no reachable open-roles board`);
        return new JobResponseDto([]);
      }

      const { listings, locale } = found;
      if (listings.length === 0) {
        this.logger.log(`PeopleFluent tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const listing of listings) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processListing(listing, tenant, locale, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing PeopleFluent role ${listing?.jobPostId}: ${err.message}`,
          );
        }
      }

      this.logger.log(`PeopleFluent total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`PeopleFluent scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Probe the tenant's candidate index across the known locale/entry-path variants until
   * one returns a server-rendered results view carrying `jobDetail.html?jobPostId=`
   * anchors. Returns the parsed listings and the locale that served them (used to build
   * per-role URLs), or null when none respond.
   */
  private async fetchListings(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<{ listings: PeopleFluentListing[]; locale: string } | null> {
    let attempts = 0;

    for (const locale of PEOPLEFLUENT_LOCALES) {
      const base = peopleFluentBasePath(tenant, locale);
      for (const path of PEOPLEFLUENT_INDEX_PATHS) {
        if (attempts >= PEOPLEFLUENT_MAX_PAGES) return null;
        attempts++;

        const url = `${base}${path}`;
        const { data: html, hostReachable } = await this.fetchHtml(client, url, tenant);
        // A transport-level failure (DNS / refused / reset / timeout) means the careers
        // host itself is unreachable — no other locale/path can succeed, so abort the
        // whole probe sweep rather than burning a full timeout per combo.
        if (!hostReachable) return null;
        if (html == null) continue;

        const listings = this.extractListings(html);
        if (listings == null) continue; // no role anchors on this page — try next entry

        // A page rendering role anchors is the right surface; return its listings
        // (possibly empty — an empty board is a valid "no roles" result).
        return { listings, locale };
      }
    }

    return null;
  }

  /**
   * GET a career-site URL as text. Returns `{ data, hostReachable }`:
   *  - `data` is the body, or null when the response carried no usable text / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the careers host itself is unreachable and the
   *    caller should stop probing further locale/path combinations.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
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
        // The host answered an HTTP status (4xx path/tenant-not-found, or 5xx) — it is
        // reachable, so the caller may still try other locale/path combinations.
        this.logger.warn(`PeopleFluent board returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout):
      // the careers host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`PeopleFluent board fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Extract the open-role listings from the server-rendered results HTML. The results
   * view renders each role as an anchor pointing at its canonical detail page
   * (`…/jobDetails/jobDetail.html?jobPostId={id}`); the adapter anchors on that stable
   * `jobPostId` URL token. Returns:
   *  - the listing array (possibly empty) when role anchors / id tokens are present
   *  - `null` when the page carries no role tokens at all (so the caller tries another
   *    entry path)
   */
  private extractListings(html: string): PeopleFluentListing[] | null {
    const byId = new Map<string, PeopleFluentListing>();

    // Primary: conventional `<a href="…jobPostId=…">title</a>` rows.
    PEOPLEFLUENT_JOB_ANCHOR_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PEOPLEFLUENT_JOB_ANCHOR_REGEX.exec(html)) !== null) {
      const detailUrl = match[1];
      const jobPostId = match[2];
      const title = this.cleanText(this.stripHtml(match[3]));
      if (!jobPostId) continue;
      if (!byId.has(jobPostId)) {
        byId.set(jobPostId, {
          jobPostId,
          detailUrl,
          title,
          localeCode: this.localeFromUrl(detailUrl),
        });
      }
    }

    // Fallback: bare `jobDetail.html?jobPostId={id}` tokens not wrapped in an anchor
    // (e.g. embedded in a JSON bootstrap / onclick handler). Captures the id only.
    PEOPLEFLUENT_JOB_ID_REGEX.lastIndex = 0;
    while ((match = PEOPLEFLUENT_JOB_ID_REGEX.exec(html)) !== null) {
      const jobPostId = match[1];
      if (jobPostId && !byId.has(jobPostId)) {
        byId.set(jobPostId, { jobPostId, detailUrl: match[0] });
      }
    }

    if (byId.size === 0) {
      // No role tokens at all → this entry is not the results surface; try the next one.
      return null;
    }
    return Array.from(byId.values());
  }

  /** Map a parsed listing → JobPostDto, deduping by ATS id. */
  private processListing(
    listing: PeopleFluentListing,
    tenant: string,
    locale: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseListing(listing, tenant, locale);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised PeopleFluentJob from a parsed listing. */
  private normaliseListing(
    listing: PeopleFluentListing,
    tenant: string,
    locale: string,
  ): PeopleFluentJob | null {
    const atsId = this.cleanText(listing.jobPostId);
    if (!atsId) return null;

    const localeCode =
      this.cleanText(listing.localeCode) ?? this.localeCodeForUrl(locale);
    const url = this.buildDetailUrl(tenant, atsId, localeCode);

    const title = this.cleanText(listing.title);
    const locationText = this.cleanText(listing.location);
    const { city, state, country } = this.splitLocation(locationText);

    return {
      atsId,
      url,
      applyUrl: url,
      title,
      companyName: this.deriveCompanyName(tenant),
      city,
      state,
      country,
      locationText,
      descriptionHtml: null,
      department: null,
      datePosted: null,
      isRemote: this.detectRemote(title, locationText),
    };
  }

  /** Map a normalised PeopleFluentJob → JobPostDto. */
  private processJob(
    job: PeopleFluentJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `peoplefluent-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.PEOPLEFLUENT,
      atsId,
      atsType: 'peoplefluent',
      department: job.department ?? null,
      employmentType: null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The body is HTML when present, so
   * HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug (the RMS client code). An explicit `companySlug` is used
   * directly (a bare career-site URL passed as the slug is reduced to its `client_` token);
   * a `companyUrl` on a `peopleclick.com` / `peoplefluent.com` host has the tenant taken
   * from its `client_{tenant}` path segment. Returns an empty string when neither yields a
   * tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (
        /^https?:\/\//i.test(slug) ||
        slug.includes(PEOPLEFLUENT_CAREERS_HOST_TOKEN) ||
        slug.includes(PEOPLEFLUENT_ROOT_DOMAIN) ||
        slug.includes('client_')
      ) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // Strip an accidental `client_` prefix; normalise the bare client code.
      return slug.replace(/^client_/i, '').toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant token from a PeopleFluent / PeopleClick career-site URL. Tenants
   * are addressed by the `client_{tenant}` path segment (e.g.
   * `…/careerscp/client_mit/external/…`), so the tenant is the label after `client_`.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    // The `client_{tenant}` segment is the stable tenant token regardless of host.
    const m = /client_([^/?#&]+)/i.exec(raw);
    if (m && m[1]) {
      const tenant = m[1].toLowerCase();
      if (tenant && tenant !== 'www') return tenant;
    }
    return '';
  }

  /** Build the canonical public detail / apply URL for a role from its parts. */
  private buildDetailUrl(tenant: string, atsId: string, localeCode: string): string {
    const base = peopleFluentBasePath(tenant, '');
    return `${base}${PEOPLEFLUENT_DETAIL_PATH}?jobPostId=${encodeURIComponent(atsId)}&localeCode=${encodeURIComponent(localeCode)}`;
  }

  /** Extract the `localeCode` query value from a detail URL token, when present. */
  private localeFromUrl(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const m = /[?&]localeCode=([^&"'<>\s]+)/i.exec(cleaned);
    return m ? this.cleanText(m[1]) : null;
  }

  /** Map a probe-locale path segment to a detail-URL `localeCode` value. */
  private localeCodeForUrl(locale: string): string {
    const cleaned = this.cleanText(locale);
    return cleaned ?? PEOPLEFLUENT_DEFAULT_LOCALE_CODE;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: PeopleFluentJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state / country.
   * Comma-separated tail is treated as the country; the head as the city. A bare
   * "Remote" token yields a null location.
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

  /** Detect remote / hybrid roles from the title or location text. */
  private detectRemote(title: string | null, location: string | null): boolean {
    const haystacks: Array<string | null | undefined> = [title, location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (PEOPLEFLUENT_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /** Strip HTML tags from an anchor's inner text and collapse whitespace. */
  private stripHtml(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const text = value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/\s{2,}/g, ' ')
      .trim();
    return text.length > 0 ? text : null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
