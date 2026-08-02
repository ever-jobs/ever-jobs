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
  MOKAHR_ROOT_DOMAIN,
  MOKAHR_MODES,
  MOKAHR_DEFAULT_RESULTS,
  MOKAHR_PAGE_SIZE,
  MOKAHR_MAX_PAGES,
  MOKAHR_DEFAULT_TIMEOUT_SECONDS,
  MOKAHR_HEADERS,
  MOKAHR_SITE_PATH_REGEX,
  MOKAHR_SLUG_PAIR_REGEX,
  MOKAHR_REMOTE_REGEX,
  mokahrJobsApiUrl,
  mokahrJobUrl,
} from './mokahr.constants';
import {
  MokaHrApiEnvelope,
  MokaHrJob,
  MokaHrJobListData,
  MokaHrJobRecord,
  MokaHrDepartment,
  MokaHrLocation,
} from './mokahr.types';

/**
 * MokaHR ATS careers scraper — generic, multi-tenant.
 *
 * MokaHR (mokahr.com, China) is a leading China-region recruitment / ATS SaaS. Each
 * customer organisation publishes a branded, public, unauthenticated candidate-facing
 * career site addressed by a `{tenant}` company slug plus a numeric `{orgId}` on the
 * shared application host `https://app.mokahr.com/social-recruitment/{tenant}/{orgId}`.
 * The career site is a client-rendered SPA whose open roles are served by a public,
 * anonymous JSON listing endpoint on the platform API host:
 *
 *   GET https://api.mokahr.com/api-platform/v1/jobs/{orgId}?mode=social&limit=&offset=
 *
 * which returns the standard MokaHR envelope `{ code, msg, data }`, where `data` is the
 * open-role array (or a wrapper object holding it). Each role carries `id`, `title`, a
 * `locations[]` array, a `department` object, an HTML `description`, and `updatedAt` /
 * `publishedAt` timestamps. The numeric role `id` is the stable ATS id and the final
 * segment of the canonical public detail / apply URL
 * `https://app.mokahr.com/apply/{tenant}/{orgId}#/job/{jobId}`.
 *
 * The caller addresses a tenant by `companySlug` (the `{tenant}/{orgId}` pair, e.g.
 * `tesla/46129`) or by `companyUrl` (any social-/campus-recruitment URL on a
 * `mokahr.com` host, from which both the tenant slug and the numeric orgId are parsed).
 * An unknown tenant, one with no open roles, or a disabled listing degrades naturally to
 * an empty result. A fetch error, an HTTP 4xx/5xx, a DNS failure, or a malformed body
 * degrades to an empty / partial result rather than throwing, so a single tenant never
 * nukes a batch run.
 */
@SourcePlugin({
  site: Site.MOKAHR,
  name: 'MokaHR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class MokaHrService implements IScraper {
  private readonly logger = new Logger(MokaHrService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for MokaHR scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant || !tenant.orgId) {
      this.logger.warn('Could not resolve a MokaHR tenant slug + orgId from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive MokaHR host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path
    // keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a
    // shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? MOKAHR_DEFAULT_TIMEOUT_SECONDS,
      MOKAHR_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(MOKAHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? MOKAHR_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching MokaHR jobs for tenant: ${tenant.slug} (orgId ${tenant.orgId})`);

      const records = await this.fetchJobList(client, tenant.orgId, resultsWanted);
      if (records.length === 0) {
        this.logger.log(`MokaHR tenant "${tenant.slug}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const record of records) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processRecord(record, tenant, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing MokaHR role ${record?.id ?? record?.jobId}: ${err.message}`,
          );
        }
      }

      this.logger.log(`MokaHR total: ${jobPosts.length} jobs for ${tenant.slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`MokaHR scrape error for ${tenant.slug}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Probe the tenant's public listing endpoint across the known recruitment modes,
   * paging via `limit` / `offset` until the board is exhausted or `resultsWanted` is
   * met. The first mode that yields any roles wins; an unknown tenant or a disabled
   * listing (HTTP error / empty payload) degrades to an empty list. De-duplicates by
   * role id within the walk so a re-paged role is never double-counted.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    orgId: string,
    resultsWanted: number,
  ): Promise<MokaHrJobRecord[]> {
    for (const mode of MOKAHR_MODES) {
      const seen = new Set<string>();
      const items: MokaHrJobRecord[] = [];
      let hostReachable = true;

      for (let page = 0; page < MOKAHR_MAX_PAGES; page++) {
        const offset = page * MOKAHR_PAGE_SIZE;
        const url = mokahrJobsApiUrl(orgId, mode, MOKAHR_PAGE_SIZE, offset);
        const fetched = await this.fetchJson(client, url, orgId);
        // A transport-level failure (DNS / refused / reset / timeout) means the platform
        // host itself is unreachable — no other mode/page can succeed, so abort the whole
        // probe rather than burning a full timeout per combination.
        if (!fetched.hostReachable) {
          hostReachable = false;
          break;
        }
        if (fetched.data == null) break; // HTTP error / no body — stop this mode's walk

        const { records } = this.extractRecords(fetched.data);
        let added = 0;
        for (const record of records) {
          const id = this.deriveAtsId(record);
          // Fall back to the URL-encoded title for de-dup when no role id is present.
          const key = id ?? this.cleanText(this.pickTitle(record)) ?? '';
          if (!key || seen.has(key)) continue;
          seen.add(key);
          items.push(record);
          added++;
          if (items.length >= resultsWanted) return items;
        }

        // Stop the page walk once a page yields fewer than a full page of NEW roles —
        // there is no further page to fetch.
        if (added < MOKAHR_PAGE_SIZE) break;
      }

      if (!hostReachable) return [];
      if (items.length > 0) {
        this.logger.log(`MokaHR mode "${mode}" yielded ${items.length} roles for org ${orgId}`);
        return items;
      }
    }

    return [];
  }

  /**
   * GET a listing URL as JSON. Returns `{ data, hostReachable }`:
   *  - `data` is the parsed envelope, or null when the response carried no usable body /
   *    the host answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the platform host itself is unreachable and the
   *    caller should stop probing further mode/page combinations.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchJson(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    orgId: string,
  ): Promise<{ data: MokaHrApiEnvelope | null; hostReachable: boolean }> {
    try {
      const response = await client.get<unknown>(url, { responseType: 'json' });
      const data = this.coerceEnvelope(response.data);
      return { data, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx not-found / disabled listing, or 5xx) —
        // it is reachable, so the caller may still try other modes. Degrade to no body.
        this.logger.warn(`MokaHR listing returned HTTP ${status} for org ${orgId}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // platform host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`MokaHR listing fetch failed for org ${orgId}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce a raw response body into a MokaHR envelope. The shared client may hand back a
   * parsed object or, when a proxy/edge returns a JSON string, the raw text — in which
   * case we JSON.parse defensively. A non-object / unparseable body yields null.
   */
  private coerceEnvelope(body: unknown): MokaHrApiEnvelope | null {
    if (body && typeof body === 'object') return body as MokaHrApiEnvelope;
    if (typeof body === 'string') {
      const text = body.trim();
      if (!text) return null;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed as MokaHrApiEnvelope;
      } catch (err: any) {
        this.logger.warn(`MokaHR listing JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /**
   * Extract the open-role array from a listing envelope. `data` may be the role array
   * directly, or a wrapper object whose `jobs` / `list` / `items` / `content` array holds
   * the roles. Returns the (possibly empty) role array; never throws.
   */
  private extractRecords(envelope: MokaHrApiEnvelope): { records: MokaHrJobRecord[] } {
    const data = envelope?.data;
    if (Array.isArray(data)) return { records: data as MokaHrJobRecord[] };
    if (data && typeof data === 'object') {
      const wrapper = data as MokaHrJobListData;
      const arr =
        (Array.isArray(wrapper.jobs) && wrapper.jobs) ||
        (Array.isArray(wrapper.list) && wrapper.list) ||
        (Array.isArray(wrapper.items) && wrapper.items) ||
        (Array.isArray(wrapper.content) && wrapper.content) ||
        [];
      return { records: arr as MokaHrJobRecord[] };
    }
    return { records: [] };
  }

  /** Map a parsed listing record → JobPostDto, deduping by ATS id. */
  private processRecord(
    record: MokaHrJobRecord,
    tenant: ResolvedTenant,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseRecord(record, tenant);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised MokaHrJob from a parsed listing record. */
  private normaliseRecord(record: MokaHrJobRecord, tenant: ResolvedTenant): MokaHrJob | null {
    const atsId = this.deriveAtsId(record);
    if (!atsId) return null;

    const title = this.cleanText(this.pickTitle(record));
    const url = this.cleanText(record.url) ?? mokahrJobUrl(tenant.slug, tenant.orgId, atsId);

    const { city, state, country, locationText } = this.deriveLocation(record);
    const department = this.deriveDepartment(record);

    return {
      atsId,
      url,
      applyUrl: url,
      title,
      companyName: this.deriveCompanyName(tenant.slug),
      city,
      state,
      country,
      locationText,
      descriptionHtml:
        this.cleanText(record.description) ??
        this.cleanText(record.jobDescription) ??
        this.cleanText(record.requirement),
      department,
      employmentType: this.cleanText(record.employmentType) ?? this.cleanText(record.jobType),
      datePosted:
        this.parseDate(record.publishedAt) ??
        this.parseDate(record.updatedAt) ??
        this.parseDate(record.createdAt),
      isRemote: this.detectRemote(title, locationText, department),
    };
  }

  /** Map a normalised MokaHrJob → JobPostDto. */
  private processJob(
    job: MokaHrJob,
    tenant: ResolvedTenant,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant.slug);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `mokahr-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.MOKAHR,
      atsId,
      atsType: 'mokahr',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Derive the stable ATS id from a role record: prefer the numeric `id`, then the
   * alternate `jobId`. Returns null when none is usable.
   */
  private deriveAtsId(record: MokaHrJobRecord): string | null {
    const id = this.numToText(record?.id);
    if (id) return id;
    return this.numToText(record?.jobId);
  }

  /** Pick the role title across the known title-field variants. */
  private pickTitle(record: MokaHrJobRecord): string | null {
    return (
      this.cleanText(record?.title) ??
      this.cleanText(record?.jobTitle) ??
      this.cleanText(record?.name)
    );
  }

  /**
   * Derive structured + free-text location from a role record. A role may carry a
   * `locations[]` array (each with `city` / `province` / `address`), a single `location`
   * object or string, or a flat `city`. We take the first usable location and split it
   * into city / state / country, keeping a single-line free-text form for remote
   * detection.
   */
  private deriveLocation(record: MokaHrJobRecord): {
    city: string | null;
    state: string | null;
    country: string | null;
    locationText: string | null;
  } {
    const loc = this.pickLocation(record);
    if (typeof loc === 'string') {
      const text = this.cleanText(loc);
      return { ...this.splitLocation(text), locationText: text };
    }
    if (loc) {
      const city = this.cleanText(loc.city) ?? this.cleanText(loc.name) ?? this.cleanText(loc.address);
      const state = this.cleanText(loc.province);
      const country = this.cleanText(loc.country);
      const locationText =
        [city, state, country].filter((p): p is string => !!p).join(', ') || null;
      return { city, state, country, locationText };
    }
    const flatCity = this.cleanText(record?.city);
    return { city: flatCity, state: null, country: null, locationText: flatCity };
  }

  /** Pick the first usable location from the role's `locations[]` / `location` / flat fields. */
  private pickLocation(record: MokaHrJobRecord): MokaHrLocation | string | null {
    if (Array.isArray(record?.locations)) {
      const first = record.locations.find(
        (l) => l && (this.cleanText(l.city) || this.cleanText(l.name) || this.cleanText(l.address)),
      );
      if (first) return first;
    }
    if (record?.location) return record.location;
    return null;
  }

  /** Derive the department label from the role's `department` object / string / alt key. */
  private deriveDepartment(record: MokaHrJobRecord): string | null {
    const dept = record?.department;
    if (typeof dept === 'string') return this.cleanText(dept);
    if (dept && typeof dept === 'object') {
      return this.cleanText((dept as MokaHrDepartment).name);
    }
    return this.cleanText(record?.departmentName);
  }

  /**
   * Convert the HTML job-ad body per `descriptionFormat`. The body is HTML, so HTML
   * returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug + numeric orgId. An explicit `companySlug` of the form
   * `{tenant}/{orgId}` (or a full career-site URL passed as the slug) is parsed for both
   * parts; a `companyUrl` on a `mokahr.com` host has both parts read from its
   * social-/campus-recruitment path. Returns null when neither yields a usable pair.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): ResolvedTenant | null {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(MOKAHR_ROOT_DOMAIN)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // The canonical `{tenant}/{orgId}` slug pair (e.g. `tesla/46129`).
      const pair = MOKAHR_SLUG_PAIR_REGEX.exec(slug);
      if (pair) {
        return { slug: pair[1].toLowerCase(), orgId: pair[2] };
      }
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return null;
  }

  /**
   * Derive the tenant slug + orgId from a MokaHR career-site URL. The candidate-facing
   * path is `/(social|campus)-recruitment/{tenant}/{orgId}`; both parts are read from it.
   */
  private tenantFromUrl(value: string): ResolvedTenant | null {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(MOKAHR_ROOT_DOMAIN)) {
        // Not a MokaHR host — no derivable tenant.
        return null;
      }
      const match = MOKAHR_SITE_PATH_REGEX.exec(u.pathname);
      if (match && match[1] && match[2]) {
        return { slug: match[1].toLowerCase(), orgId: match[2] };
      }
    } catch {
      // Malformed URL — no tenant.
    }
    return null;
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
  private extractLocation(job: MokaHrJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state / country.
   * Comma-separated tail is treated as the country; the head as the city. A MokaHR
   * location is often a single free-text line, so the whole value lands in `city` when
   * there is no comma.
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

  /** Detect remote roles from the title, location, or department text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (MOKAHR_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /**
   * Parse an ISO / epoch timestamp value into a YYYY-MM-DD string. Non-absolute /
   * unparseable values yield null.
   */
  private parseDate(value: string | number | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      // MokaHR may emit epoch millis (13 digits) or seconds (10 digits).
      const ms = value > 1e12 ? value : value * 1000;
      const parsed = new Date(ms);
      return isNaN(parsed.getTime()) ? null : toDateOnly(ms);
    }
    const cleaned = this.cleanText(typeof value === 'string' ? value : null);
    if (!cleaned) return null;
    try {
      const parsed = new Date(cleaned);
      if (!isNaN(parsed.getTime())) return toDateOnly(cleaned);
    } catch {
      // ignore
    }
    return null;
  }

  /** Coerce a numeric / string id field into trimmed text, or null when empty. */
  private numToText(value: number | string | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return this.cleanText(typeof value === 'string' ? value : null);
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}

/** A resolved tenant: the company slug + the numeric organisation id. */
interface ResolvedTenant {
  /** Company slug (the `{tenant}` URL segment, e.g. `tesla`). */
  slug: string;
  /** Numeric organisation id (the `{orgId}` URL segment, e.g. `46129`). */
  orgId: string;
}
