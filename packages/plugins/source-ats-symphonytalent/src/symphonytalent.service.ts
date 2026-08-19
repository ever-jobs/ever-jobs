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
  SYMPHONYTALENT_API_HOST,
  SYMPHONYTALENT_ROOT_DOMAIN,
  SYMPHONYTALENT_PAGE_SIZE,
  SYMPHONYTALENT_DEFAULT_RESULTS,
  SYMPHONYTALENT_MAX_PAGES,
  SYMPHONYTALENT_DEFAULT_TIMEOUT_SECONDS,
  SYMPHONYTALENT_HEADERS,
  SYMPHONYTALENT_REMOTE_TYPE,
  SYMPHONYTALENT_REMOTE_REGEX,
  symphonytalentFeedBase,
} from './symphonytalent.constants';
import {
  SymphonyTalentJob,
  SymphonyTalentJobItem,
  SymphonyTalentJobsResponse,
} from './symphonytalent.types';

/**
 * Symphony Talent / SmashFlyX ATS careers scraper — generic, multi-tenant.
 *
 * Symphony Talent (symphonytalent.com — an enterprise recruitment-marketing / candidate-CRM
 * vendor that absorbed SmashFly Technologies; flagship product SmashFlyX) powers each
 * customer's branded, public, unauthenticated candidate-facing career site. Every such site
 * consumes one shared, public, anonymous JSON jobs API on Symphony Talent's hosting cloud,
 * addressing the tenant purely by a **numeric organisation id** (`Organization` / `org_id`):
 *
 *   GET https://jobsapi-internal.m-cloud.io/api/job?Organization={orgId}&Limit={n}&offset={k}
 *
 * which returns a flat envelope `{ totalHits, queryResult }` whose `queryResult[]` array
 * holds the tenant's open roles (no bearer token — the tenant's own public career site calls
 * it cross-origin). The adapter GETs this feed, advances `offset` to drain pages bounded by
 * `totalHits`, and maps each role — rather than depending on a client-rendered DOM, a
 * headless browser, or the authenticated SmashFly Console / Job-Import REST API (which DO
 * require credentials). Each role's numeric `id` (e.g. `23398009`) is the stable ATS id, and
 * its `url` is the canonical public detail page.
 *
 * The caller addresses a tenant by `companySlug` (the numeric `Organization` id, e.g.
 * `2015`) or by `companyUrl` (a URL on the API host carrying an `Organization=` query param,
 * or a numeric id embedded in the path). An unknown org id, one with no open roles, or an
 * empty board degrades naturally to an empty result. A fetch error, an HTTP 4xx, a DNS
 * failure, or a malformed body degrades to an empty / partial result rather than throwing, so
 * a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.SYMPHONYTALENT,
  name: 'Symphony Talent',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SymphonyTalentService implements IScraper {
  private readonly logger = new Logger(SymphonyTalentService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Symphony Talent scraper');
      return new JobResponseDto([]);
    }

    const orgId = this.resolveOrgId(companySlug, input.companyUrl);
    if (!orgId) {
      this.logger.warn('Could not resolve a Symphony Talent organisation id from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive API host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path
    // keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a
    // shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? SYMPHONYTALENT_DEFAULT_TIMEOUT_SECONDS,
      SYMPHONYTALENT_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(SYMPHONYTALENT_HEADERS);

    const resultsWanted = input.resultsWanted ?? SYMPHONYTALENT_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Symphony Talent jobs for organisation: ${orgId}`);

      const fallbackName = this.deriveOrgName(orgId);
      const seen = new Set<string>();

      // Drain the paginated public feed up to the page cap or until we've collected
      // `resultsWanted` roles. The feed pages by `offset` (1-based) with a fixed `Limit`. A
      // transport-level failure (host unreachable) aborts the sweep; an HTTP error / malformed
      // page degrades to an empty / partial result.
      for (let page = 0; page < SYMPHONYTALENT_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const offset = page * SYMPHONYTALENT_PAGE_SIZE + 1;
        const result = await this.fetchPage(client, orgId, offset);
        // hostReachable === false → DNS / refused / reset / timeout: no further page can
        // succeed, so stop probing rather than burning a timeout per page.
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / unparseable body → stop draining

        const items = Array.isArray(body.queryResult) ? body.queryResult : [];
        if (items.length === 0) break; // empty page → nothing further to drain

        for (const item of items) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processItem(item, orgId, fallbackName, input.descriptionFormat, seen);
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Symphony Talent role ${item?.id}: ${err.message}`);
          }
        }

        // Stop once we have walked past the reported total (or the feed under-filled a page).
        const total = typeof body.totalHits === 'number' ? body.totalHits : null;
        if (total !== null && offset + items.length > total) break;
        if (items.length < SYMPHONYTALENT_PAGE_SIZE) break;
      }

      this.logger.log(`Symphony Talent total: ${jobPosts.length} jobs for ${orgId}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Symphony Talent scrape error for ${orgId}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET one page of the shared public jobs feed (for this org / offset) as JSON. Returns
   * `{ data, hostReachable }`:
   *  - `data` is the parsed `{ totalHits, queryResult }` envelope, or null when the response
   *    carried no usable JSON / the host answered an HTTP error status (4xx / 5xx — a real,
   *    reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the API host itself is unreachable and the caller
   *    should stop draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    orgId: string,
    offset: number,
  ): Promise<{ data: SymphonyTalentJobsResponse | null; hostReachable: boolean }> {
    const url = this.buildFeedUrl(orgId, offset);
    try {
      const response = await client.get<SymphonyTalentJobsResponse | string>(url);
      const parsed = this.coerceBody(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx unknown-org / 5xx) — it is reachable, but
        // there is nothing more to drain.
        this.logger.warn(`Symphony Talent feed returned HTTP ${status} for ${orgId}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // API host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Symphony Talent feed fetch failed for ${orgId}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce an axios response body into a parsed feed envelope. The client usually parses the
   * JSON for us (object body); the SmashFlyX feed is also served as JSONP to the browser, so
   * we additionally strip a `callback(... )` wrapper from a string body before parsing. A
   * non-object / unparseable body yields null (degrade to no roles).
   */
  private coerceBody(
    data: SymphonyTalentJobsResponse | string | unknown,
  ): SymphonyTalentJobsResponse | null {
    if (data && typeof data === 'object') return data as SymphonyTalentJobsResponse;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      const json = this.unwrapJsonp(trimmed);
      try {
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === 'object') return parsed as SymphonyTalentJobsResponse;
      } catch (err: any) {
        this.logger.warn(`Symphony Talent feed JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /**
   * Strip a JSONP `callback({...});` wrapper, leaving the bare JSON. A plain JSON body (no
   * wrapper) is returned unchanged.
   */
  private unwrapJsonp(body: string): string {
    if (body.startsWith('{') || body.startsWith('[')) return body;
    const open = body.indexOf('(');
    const close = body.lastIndexOf(')');
    if (open !== -1 && close > open) {
      return body.slice(open + 1, close).trim();
    }
    return body;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: SymphonyTalentJobItem,
    orgId: string,
    fallbackName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, orgId, fallbackName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, orgId, format);
  }

  /** Build a normalised SymphonyTalentJob from a parsed role. */
  private normaliseItem(
    item: SymphonyTalentJobItem,
    orgId: string,
    fallbackName: string,
  ): SymphonyTalentJob | null {
    const atsId = this.cleanText(item.id != null ? String(item.id) : null);
    if (!atsId) return null;

    // The feed always carries the canonical detail URL in `url`; fall back to a derived
    // career-host-agnostic id reference only if a future shape ever omits it.
    const url = this.cleanText(item.url);
    if (!url) return null; // without the canonical career-site host we cannot address the role

    const city = this.cleanText(item.primary_city);
    const state = this.cleanText(item.primary_state);
    const country = this.cleanText(item.primary_country);
    const locationText = this.joinLocation(city, state, country);
    const department = this.cleanText(item.department) ?? this.cleanText(item.primary_category);
    const title = this.cleanText(item.title);
    const employmentType = this.cleanText(item.employment_type) ?? this.cleanText(item.job_type);

    return {
      atsId,
      url,
      // The career site links to the apply flow via `fndly_url`; fall back to the detail URL.
      applyUrl: this.cleanText(item.fndly_url) ?? url,
      title,
      companyName: this.cleanText(item.company_name) ?? fallbackName,
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(item.description),
      department,
      employmentType,
      datePosted: this.parseDate(item.open_date),
      isRemote: this.detectRemote(item, title, locationText, department),
    };
  }

  /** Map a normalised SymphonyTalentJob → JobPostDto. */
  private processJob(
    job: SymphonyTalentJob,
    orgId: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveOrgName(orgId);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `symphonytalent-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.SYMPHONYTALENT,
      atsId,
      atsType: 'symphonytalent',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Symphony Talent exposes the
   * body as HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant's numeric `Organization` id. An explicit `companySlug` that is a bare
   * numeric id is used directly; a `companySlug` or `companyUrl` carrying an `Organization=`
   * query param, or a numeric id embedded in a `m-cloud.io` / career-site path, has the id
   * extracted. Returns an empty string when neither yields an org id.
   */
  private resolveOrgId(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A bare numeric org id is the canonical addressing form.
      if (/^\d+$/.test(slug)) return slug;
      // A caller may also pass a full URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes('=') || slug.includes('/')) {
        const fromUrl = this.orgIdFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
    }
    if (companyUrl) {
      const fromUrl = this.orgIdFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Extract the numeric org id from a URL. Recognises an `Organization` / `org_id` query
   * param (case-insensitive) on any host, and a numeric path segment on the API host.
   */
  private orgIdFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      for (const [key, val] of u.searchParams.entries()) {
        const k = key.toLowerCase();
        if ((k === 'organization' || k === 'org_id' || k === 'org') && /^\d+$/.test(val)) {
          return val;
        }
      }
      const host = u.hostname.toLowerCase();
      if (host === SYMPHONYTALENT_API_HOST || host.endsWith(`.${SYMPHONYTALENT_ROOT_DOMAIN}`)) {
        const seg = u.pathname.split('/').find((s) => /^\d+$/.test(s));
        if (seg) return seg;
      }
    } catch {
      // Malformed URL — no org id.
    }
    return '';
  }

  /** Assemble the public jobs-feed URL for a given org / offset. */
  private buildFeedUrl(orgId: string, offset: number): string {
    const params = new URLSearchParams({
      Organization: orgId,
      Limit: String(SYMPHONYTALENT_PAGE_SIZE),
      offset: String(offset),
      sortfield: 'open_date',
      sortorder: 'descending',
    });
    return `${symphonytalentFeedBase()}?${params.toString()}`;
  }

  /**
   * Derive a display company name from the org id. The feed normally carries the brand in
   * `company_name`, so this is only a fallback when a role omits it.
   */
  private deriveOrgName(orgId: string): string {
    return `Organization ${orgId}`;
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: SymphonyTalentJob): LocationDto | null {
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
   * Detect remote roles from the structured `location_type` token, then from the title,
   * location, or department text.
   */
  private detectRemote(
    item: SymphonyTalentJobItem,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const locationType = this.cleanText(item.location_type);
    if (locationType && locationType.toLowerCase().includes(SYMPHONYTALENT_REMOTE_TYPE)) {
      return true;
    }
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (SYMPHONYTALENT_REMOTE_REGEX.test(field)) return true;
    }
    return false;
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
