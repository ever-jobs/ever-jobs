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
  APPLOI_ROOT_DOMAIN,
  APPLOI_BOARD_HOST,
  APPLOI_SEARCH_PATH,
  APPLOI_SEARCH_SOURCE,
  APPLOI_DEFAULT_RESULTS,
  APPLOI_MAX_PAGES,
  APPLOI_DEFAULT_TIMEOUT_SECONDS,
  APPLOI_HEADERS,
  APPLOI_REMOTE_TYPE,
  APPLOI_REMOTE_REGEX,
  APPLOI_INTEGRATIONS_ORIGIN,
  apploiProfileUrl,
  apploiJobViewUrl,
} from './apploi.constants';
import {
  ApploiJob,
  ApploiJobItem,
  ApploiJobsResponse,
  ApploiCompanyProfile,
  ApploiCompanyProfileResponse,
} from './apploi.types';

/**
 * Apploi ATS careers scraper — generic, multi-tenant.
 *
 * Apploi (apploi.com, NYC — a US healthcare / hourly-workforce ATS & recruitment platform,
 * now part of Viventium) powers each customer's branded, public, unauthenticated
 * candidate-facing job board on the shared host `https://jobs.apploi.com/profile/{slug}`. The
 * board is a client-rendered SPA backed by two **public, anonymous JSON APIs** it consumes
 * (no bearer token — the SPA sends an empty `Authorization: Bearer ` for anonymous visitors):
 *
 *   1. GET https://api.apploi.com/v1/company_profiles/{slug}
 *        → { data: { team_id, teams_to_show, name, … } }
 *   2. GET https://ats-integrations.apploi.com/search/jobs/?teams={csv}&page={n}&source=company_profile_page
 *        → { data: [ { id, name, city, state, description, job_type, industry,
 *                      published_date, redirect_apply_url, … } ] }
 *
 * The adapter resolves the tenant slug, fetches the profile to learn its `teams_to_show`, then
 * drains the job-search feed for those teams (the envelope has no pagination meta, so it walks
 * `page` until a page returns an empty `data`, bounded by a page cap), and maps each role —
 * rather than depending on a client-rendered DOM, a headless browser, or any authenticated
 * Apploi API. Each role's string `id` is the stable ATS id, and its `redirect_apply_url` is
 * the canonical public `jobs.apploi.com/view/{id}` detail / apply page.
 *
 * The caller addresses a tenant by `companySlug` (the profile slug, e.g. `apploi.com`) or by
 * `companyUrl` (a `jobs.apploi.com/profile/{slug}` URL). An unknown slug, a tenant with no
 * teams, or an empty board degrades naturally to an empty result. A fetch error, an HTTP 4xx,
 * a DNS failure, or a malformed body degrades to an empty / partial result rather than
 * throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.APPLOI,
  name: 'Apploi',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ApploiService implements IScraper {
  private readonly logger = new Logger(ApploiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Apploi scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve an Apploi tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Apploi host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path
    // keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter
    // timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? APPLOI_DEFAULT_TIMEOUT_SECONDS,
      APPLOI_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(APPLOI_HEADERS);

    const resultsWanted = input.resultsWanted ?? APPLOI_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Apploi jobs for slug: ${slug}`);

      // Step 1: resolve the tenant's team ids from the public company profile.
      const profile = await this.fetchProfile(client, slug);
      const teams = this.resolveTeams(profile);
      if (!teams) {
        this.logger.warn(`No Apploi teams resolved for slug ${slug}`);
        return new JobResponseDto([]);
      }

      const companyName = this.cleanText(profile?.name) ?? this.deriveSlugName(slug);
      const seen = new Set<string>();

      // Step 2: drain the paginated public job-search feed for those teams. The envelope
      // carries no pagination meta, so we stop when a page returns an empty `data` array, when
      // we hit the page cap, or once `resultsWanted` roles are collected. A transport-level
      // failure (host unreachable) aborts the sweep; an HTTP error / malformed page degrades
      // to an empty / partial result.
      for (let page = 1; page <= APPLOI_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, teams, page);
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / unparseable body → stop draining

        const items = Array.isArray(body.data) ? body.data : [];
        if (items.length === 0) break; // past the last page

        for (const item of items) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processItem(item, slug, companyName, input.descriptionFormat, seen);
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Apploi role ${item?.id}: ${err.message}`);
          }
        }
      }

      this.logger.log(`Apploi total: ${jobPosts.length} jobs for ${slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Apploi scrape error for ${slug}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * GET the tenant's public company profile as JSON. Returns the parsed profile, or null when
   * the profile is missing / unreachable / unparseable (degrade to no roles). Never throws.
   */
  private async fetchProfile(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
  ): Promise<ApploiCompanyProfile | null> {
    const url = apploiProfileUrl(slug);
    try {
      const response = await client.get<ApploiCompanyProfileResponse | string>(url);
      const parsed = this.coerceProfile(response.data);
      return parsed;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        this.logger.warn(`Apploi profile returned HTTP ${status} for ${slug}`);
      } else {
        this.logger.warn(`Apploi profile fetch failed for ${slug}: ${err?.message ?? err}`);
      }
      return null;
    }
  }

  /**
   * GET one page of the public job-search feed as JSON. Returns `{ data, hostReachable }`:
   *  - `data` is the parsed `{ data: [...] }` envelope, or null when the response carried no
   *    usable JSON / the host answered an HTTP error status (4xx / 5xx — a real, reachable
   *    host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the host itself is unreachable and the caller should stop
   *    draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    teams: string,
    page: number,
  ): Promise<{ data: ApploiJobsResponse | null; hostReachable: boolean }> {
    const url = this.buildFeedUrl(teams, page);
    try {
      const response = await client.get<ApploiJobsResponse | string>(url);
      const parsed = this.coerceJobs(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, but there is
        // nothing more to drain.
        this.logger.warn(`Apploi feed returned HTTP ${status} for teams ${teams}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the host
      // is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Apploi feed fetch failed for teams ${teams}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce an axios response body into a parsed company-profile. The client usually parses the
   * JSON for us (object body); a text/plain string body is parsed defensively. A non-object /
   * unparseable body yields null.
   */
  private coerceProfile(
    data: ApploiCompanyProfileResponse | string | unknown,
  ): ApploiCompanyProfile | null {
    const env = this.coerceObject<ApploiCompanyProfileResponse>(data);
    if (env && env.data && typeof env.data === 'object') {
      return env.data as ApploiCompanyProfile;
    }
    return null;
  }

  /**
   * Coerce an axios response body into a parsed job-search envelope. A non-object /
   * unparseable body yields null (degrade to no roles).
   */
  private coerceJobs(data: ApploiJobsResponse | string | unknown): ApploiJobsResponse | null {
    return this.coerceObject<ApploiJobsResponse>(data);
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
        this.logger.warn(`Apploi JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /**
   * Resolve the tenant's team-id CSV from the company profile. Prefers `teams_to_show` (the
   * full set the board renders), falling back to the primary `team_id`. Returns an empty
   * string when neither is present.
   */
  private resolveTeams(profile: ApploiCompanyProfile | null): string {
    if (!profile) return '';
    const teamsToShow = this.cleanText(profile.teams_to_show);
    if (teamsToShow) {
      // Keep only well-formed numeric ids, de-duped, preserving order.
      const ids = teamsToShow
        .split(',')
        .map((t) => t.trim())
        .filter((t) => /^\d+$/.test(t));
      const unique = Array.from(new Set(ids));
      if (unique.length > 0) return unique.join(',');
    }
    const primary = this.cleanText(this.toStringId(profile.team_id));
    if (primary && /^\d+$/.test(primary)) return primary;
    return '';
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: ApploiJobItem,
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

  /** Build a normalised ApploiJob from a parsed role. */
  private normaliseItem(
    item: ApploiJobItem,
    slug: string,
    companyName: string,
  ): ApploiJob | null {
    const atsId = this.cleanText(this.toStringId(item.id));
    if (!atsId) return null;

    // The feed always carries the canonical detail URL in `redirect_apply_url`; fall back to a
    // derived `/view/{id}` only if a future shape ever omits it.
    const url = this.cleanText(item.redirect_apply_url) ?? apploiJobViewUrl(atsId);
    const city = this.cleanText(item.city);
    const state = this.cleanText(item.state);
    const country = this.cleanText(item.country) ?? this.countryFromAddress(item.address);
    const locationText = this.joinLocation(city, state, country);
    const department = this.cleanText(item.industry);
    const title = this.cleanText(item.name);
    const employmentType = this.cleanText(item.job_type);

    return {
      atsId,
      url,
      // The Apploi detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName: this.cleanText(item.brand_name) ?? companyName ?? this.deriveSlugName(slug),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(item.description),
      department,
      employmentType,
      datePosted: this.parseDate(item.published_date),
      isRemote: this.detectRemote(item, title, locationText, department),
    };
  }

  /** Map a normalised ApploiJob → JobPostDto. */
  private processJob(
    job: ApploiJob,
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
      id: `apploi-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.APPLOI,
      atsId,
      atsType: 'apploi',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Apploi exposes the body as
   * HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare board URL
   * passed as the slug is reduced to its `/profile/{slug}` token); a `companyUrl` on a
   * `jobs.apploi.com` host has the slug taken from its `/profile/{slug}` path. Returns an empty
   * string when neither yields a slug.
   */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full board URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(APPLOI_ROOT_DOMAIN + '/')) {
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
   * Derive the tenant slug from an Apploi board URL. The candidate-facing board is
   * `jobs.apploi.com/profile/{slug}`; the slug is the first path segment after `/profile/`.
   */
  private slugFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      // Accept the board host (jobs.apploi.com) or any *.apploi.com host bearing a /profile/.
      if (!hostname.endsWith(APPLOI_ROOT_DOMAIN)) return '';
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      const profileIdx = segments.findIndex((s) => s.toLowerCase() === 'profile');
      if (profileIdx >= 0 && segments[profileIdx + 1]) {
        return decodeURIComponent(segments[profileIdx + 1]).toLowerCase();
      }
      // A `/view/{id}` URL carries no tenant slug.
      return '';
    } catch {
      // Malformed URL — no slug.
    }
    return '';
  }

  /** Assemble the public job-search feed URL for a team-id CSV and page. */
  private buildFeedUrl(teams: string, page: number): string {
    const params = new URLSearchParams({
      teams,
      page: String(page),
      source: APPLOI_SEARCH_SOURCE,
    });
    return `${APPLOI_INTEGRATIONS_ORIGIN}/${APPLOI_SEARCH_PATH}?${params.toString()}`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(slug: string): string {
    const base = slug && slug.trim() ? slug.trim() : slug;
    // Drop a trailing TLD-like suffix (`apploi.com` → `apploi`) before title-casing.
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
  private extractLocation(job: ApploiJob): LocationDto | null {
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
   * Best-effort country extraction from a free-text address line (e.g. `…, KS 67560 USA`).
   * Apploi rarely emits a dedicated country field, so a trailing `USA` / `US` token is used.
   */
  private countryFromAddress(address: string | null | undefined): string | null {
    const cleaned = this.cleanText(address);
    if (!cleaned) return null;
    const m = cleaned.match(/\b(USA|United States|US|Canada|UK|United Kingdom)\b\s*$/i);
    return m ? m[1] : null;
  }

  /**
   * Detect remote roles from the structured `job_type` token, then from the title, location,
   * or industry text.
   */
  private detectRemote(
    item: ApploiJobItem,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const typeToken = this.cleanText(item.job_type);
    if (typeToken && typeToken.toLowerCase().includes(APPLOI_REMOTE_TYPE)) {
      return true;
    }
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (APPLOI_REMOTE_REGEX.test(field)) return true;
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
