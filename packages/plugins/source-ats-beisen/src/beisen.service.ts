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
  BEISEN_ROOT_DOMAIN,
  BEISEN_REGISTER_PATH,
  BEISEN_SEARCH_PATH,
  BEISEN_DISPLAY_FIELDS,
  BEISEN_DEFAULT_RESULTS,
  BEISEN_PAGE_SIZE,
  BEISEN_MAX_PAGES,
  BEISEN_DEFAULT_TIMEOUT_SECONDS,
  BEISEN_HEADERS,
  BEISEN_BSGLOBAL_REGEX,
  BEISEN_TENANT_ID_REGEX,
  BEISEN_UNSET_DATE_PREFIX,
  BEISEN_REMOTE_REGEX,
  beisenTenantHost,
  beisenJobUrl,
} from './beisen.constants';
import {
  BeisenBsGlobal,
  BeisenJob,
  BeisenJobRecord,
  BeisenListEnvelope,
  ResolvedBeisenTenant,
} from './beisen.types';

/**
 * Beisen (北森 / iTalent) ATS careers scraper — generic, multi-tenant.
 *
 * Beisen ("iTalent") is the largest enterprise cloud-HR / talent-management SaaS in the China
 * region. Its recruitment product powers the public, unauthenticated career sites of a large
 * roster of major China-operating employers. Each tenant publishes a branded career SPA at
 * `https://{slug}.zhiye.com`; open roles are served by a public, anonymous JSON listing
 * endpoint reached via a deterministic two-step flow:
 *
 *   1. GET  `https://{slug}.zhiye.com/portal/registerSystemInfo` → HTML inlining
 *      `var BSGlobal = { Key, Name, PortalId, Code }`. The `PortalId` is required for the
 *      listing call; `Name` is the tenant's branded company display name.
 *   2. POST `https://{slug}.zhiye.com/api/Jobad/GetJobAdPageList` with the `PortalId` in the
 *      body → `{ Code, Count, Data:[ { JobAdId, JobAdName, LocNames, Duty, Require, Salary,
 *      Category, ChangeDate, PostDate } ] }`, paginated via `PageIndex`/`PageSize`.
 *
 * The numeric `JobAdId` is the stable ATS id and the final segment of the canonical public
 * detail / apply URL `https://{slug}.zhiye.com/portal/jobs/{JobAdId}`.
 *
 * The caller addresses a tenant by `companySlug` (the bare `{slug}` subdomain token, e.g.
 * `mengniu`, or a full `*.zhiye.com` URL) or by `companyUrl` (any URL on a `zhiye.com` host,
 * whose subdomain is the tenant slug). An unknown tenant, a legacy portal with no `BSGlobal`, a
 * disabled listing, or any HTTP / transport / parse failure degrades to an empty / partial
 * result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.BEISEN,
  name: 'Beisen',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class BeisenService implements IScraper {
  private readonly logger = new Logger(BeisenService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Beisen scraper');
      return new JobResponseDto([]);
    }

    const resolved = this.resolveSlug(companySlug, input.companyUrl);
    if (!resolved) {
      this.logger.warn('Could not resolve a Beisen tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Beisen host degrades gracefully fast rather
    // than hanging on the client's 60s default. A caller may request a shorter timeout; we cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? BEISEN_DEFAULT_TIMEOUT_SECONDS,
      BEISEN_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(BEISEN_HEADERS);

    const resultsWanted = input.resultsWanted ?? BEISEN_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      const tenant = await this.resolveTenant(client, resolved.slug, resolved.base);
      if (!tenant) {
        this.logger.log(`Beisen tenant "${resolved.slug}" did not expose a usable portal config`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Fetching Beisen jobs for tenant: ${tenant.slug} (portal ${tenant.portalId})`);

      const records = await this.fetchJobList(client, tenant, resultsWanted);
      if (records.length === 0) {
        this.logger.log(`Beisen tenant "${tenant.slug}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const record of records) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processRecord(record, tenant, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Beisen role ${record?.JobAdId}: ${err.message}`);
        }
      }

      this.logger.log(`Beisen total: ${jobPosts.length} jobs for ${tenant.slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Beisen scrape error for ${resolved.slug}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Resolve the tenant config by fetching the career-site bootstrap HTML and extracting the
   * inline `BSGlobal` block. Requires a `PortalId`; a legacy portal with no `BSGlobal`, a
   * missing `PortalId`, an HTTP error, a transport failure, or a malformed body all yield null.
   */
  private async resolveTenant(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    base: string,
  ): Promise<ResolvedBeisenTenant | null> {
    const url = `${base}${BEISEN_REGISTER_PATH}`;
    let html: string | null;
    try {
      const response = await client.get<unknown>(url, { responseType: 'text' });
      html = this.coerceText(response.data);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        this.logger.warn(`Beisen register returned HTTP ${status} for ${slug}`);
      } else {
        this.logger.warn(`Beisen register fetch failed for ${slug}: ${err?.message ?? err}`);
      }
      return null;
    }
    if (!html) return null;

    const bsGlobal = this.extractBsGlobal(html);
    const portalId = this.cleanText(bsGlobal?.PortalId);
    if (!portalId) {
      this.logger.warn(`Beisen tenant "${slug}" exposed no PortalId (legacy / non-portal page)`);
      return null;
    }

    const tenantIdMatch = BEISEN_TENANT_ID_REGEX.exec(html);
    return {
      slug,
      base,
      portalId,
      companyName: this.cleanText(bsGlobal?.Name),
      tenantId: tenantIdMatch ? tenantIdMatch[1] : null,
    };
  }

  /**
   * Extract and parse the inline `var BSGlobal = { … }` object literal from the career-site
   * HTML. Anchors on the opening brace, then performs a string/escape-aware balanced-brace scan
   * so a nested config object is consumed in full. A missing block or unparseable JSON yields
   * null. Never throws.
   */
  private extractBsGlobal(html: string): BeisenBsGlobal | null {
    const anchor = BEISEN_BSGLOBAL_REGEX.exec(html);
    if (!anchor) return null;
    // The regex ends just past the opening `{`; rewind to that brace to start the scan.
    const start = anchor.index + anchor[0].length - 1;
    const json = this.sliceBalancedObject(html, start);
    if (!json) return null;
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object') return parsed as BeisenBsGlobal;
    } catch (err: any) {
      this.logger.warn(`Beisen BSGlobal JSON parse failed: ${err?.message ?? err}`);
    }
    return null;
  }

  /**
   * From an opening `{` at `start`, return the substring spanning to its matching `}` (inclusive),
   * counting brace depth while skipping over string literals (single/double quoted) and their
   * escape sequences. Returns null when no balanced close is found.
   */
  private sliceBalancedObject(text: string, start: number): string | null {
    let depth = 0;
    let inString = false;
    let quote = '';
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') {
          i++; // skip the escaped char
          continue;
        }
        if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  /**
   * Page the tenant's listing endpoint from `PageIndex=0`, deduping by role id, until the board
   * is exhausted or `resultsWanted` is met. Stops a page walk on an empty / short / no-new page,
   * or once the cumulative role count reaches the envelope `Count`. A transport-level failure
   * (host unreachable) aborts the walk and returns whatever was gathered so far.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    tenant: ResolvedBeisenTenant,
    resultsWanted: number,
  ): Promise<BeisenJobRecord[]> {
    const seen = new Set<string>();
    const items: BeisenJobRecord[] = [];

    for (let page = 0; page < BEISEN_MAX_PAGES; page++) {
      const fetched = await this.fetchPage(client, tenant, page);
      if (!fetched.hostReachable) break; // host down — return partial
      if (fetched.records.length === 0) break; // exhausted / HTTP error

      let added = 0;
      for (const record of fetched.records) {
        const id = this.deriveAtsId(record);
        const key = id ?? this.cleanText(this.pickTitle(record)) ?? '';
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(record);
        added++;
        if (items.length >= resultsWanted) return items;
      }

      // Stop when the envelope's total is reached, or the page was short / yielded no new roles.
      if (fetched.count != null && seen.size >= fetched.count) break;
      if (added === 0 || fetched.records.length < BEISEN_PAGE_SIZE) break;
    }

    return items;
  }

  /**
   * POST one listing page. Returns `{ records, count, hostReachable }`:
   *  - `records` is the (possibly empty) role array; empty on an HTTP error / no body.
   *  - `count` is the envelope total, when present, used to bound pagination.
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / refused / reset /
   *    timeout), where the platform host is unreachable and the caller should stop paging.
   * Never throws.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    tenant: ResolvedBeisenTenant,
    pageIndex: number,
  ): Promise<{ records: BeisenJobRecord[]; count: number | null; hostReachable: boolean }> {
    const url = `${tenant.base}${BEISEN_SEARCH_PATH}`;
    const body = {
      PageIndex: pageIndex,
      PageSize: BEISEN_PAGE_SIZE,
      KeyWords: '',
      SpecialType: 0,
      PortalId: tenant.portalId,
      DisplayFields: [...BEISEN_DISPLAY_FIELDS],
    };
    try {
      const response = await client.post<unknown>(url, body, {
        responseType: 'json',
        headers: { Referer: `${tenant.base}/social/jobs` },
      });
      const envelope = this.coerceEnvelope(response.data);
      if (!envelope) return { records: [], count: null, hostReachable: true };
      const records = Array.isArray(envelope.Data) ? envelope.Data : [];
      return { records, count: this.numToInt(envelope.Count), hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        this.logger.warn(`Beisen listing returned HTTP ${status} for ${tenant.slug} p${pageIndex}`);
        return { records: [], count: null, hostReachable: true };
      }
      this.logger.warn(
        `Beisen listing fetch failed for ${tenant.slug} p${pageIndex}: ${err?.message ?? err}`,
      );
      return { records: [], count: null, hostReachable: false };
    }
  }

  /**
   * Coerce a raw response body into a Beisen envelope. The shared client may hand back a parsed
   * object or, when a proxy/edge returns a JSON string, the raw text — in which case we
   * JSON.parse defensively. A non-object / unparseable body yields null.
   */
  private coerceEnvelope(body: unknown): BeisenListEnvelope | null {
    if (body && typeof body === 'object') return body as BeisenListEnvelope;
    if (typeof body === 'string') {
      const text = body.trim();
      if (!text) return null;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed as BeisenListEnvelope;
      } catch (err: any) {
        this.logger.warn(`Beisen listing JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /** Coerce a raw response body into HTML text, or null when there is no usable string body. */
  private coerceText(body: unknown): string | null {
    if (typeof body === 'string') return body.length > 0 ? body : null;
    // Some clients hand back already-parsed bodies; stringify objects so the regex can still run.
    if (body && typeof body === 'object') {
      try {
        return JSON.stringify(body);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Map a parsed listing record → JobPostDto, deduping by ATS id. */
  private processRecord(
    record: BeisenJobRecord,
    tenant: ResolvedBeisenTenant,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseRecord(record, tenant);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised BeisenJob from a parsed listing record. */
  private normaliseRecord(record: BeisenJobRecord, tenant: ResolvedBeisenTenant): BeisenJob | null {
    const atsId = this.deriveAtsId(record);
    if (!atsId) return null;

    const title = this.cleanText(this.pickTitle(record));
    const url = beisenJobUrl(tenant.base, atsId);
    const { city, state, country, locationText } = this.deriveLocation(record);
    const department = this.cleanText(record.Category) ?? this.cleanText(record.Department);

    return {
      atsId,
      url,
      applyUrl: url,
      title,
      companyName: tenant.companyName ?? this.deriveCompanyName(tenant.slug),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.deriveBody(record),
      department,
      salaryText: this.cleanText(record.Salary),
      datePosted: this.parseDate(record.ChangeDate) ?? this.parseDate(record.PostDate),
      isRemote: this.detectRemote(title, locationText, department),
    };
  }

  /** Map a normalised BeisenJob → JobPostDto. */
  private processJob(
    job: BeisenJob,
    tenant: ResolvedBeisenTenant,
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
      id: `beisen-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.BEISEN,
      atsId,
      atsType: 'beisen',
      department: job.department ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Resolve the tenant slug + career-site origin. An explicit `companySlug` may be a bare
   * subdomain token (`mengniu`) or a full `*.zhiye.com` URL; a `companyUrl` on a `zhiye.com`
   * host has its subdomain read as the slug. Returns null when neither yields a usable slug.
   */
  private resolveSlug(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): { slug: string; base: string } | null {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (/^https?:\/\//i.test(slug) || slug.includes(BEISEN_ROOT_DOMAIN)) {
        const fromUrl = this.slugFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // A bare subdomain token (letters/digits/hyphen). Reject anything URL-ish or with a dot.
      const bare = slug.toLowerCase();
      if (/^[a-z0-9][a-z0-9-]*$/.test(bare)) {
        return { slug: bare, base: beisenTenantHost(bare) };
      }
    }
    if (companyUrl) {
      const fromUrl = this.slugFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return null;
  }

  /**
   * Derive the tenant slug + origin from a Beisen career-site URL. The slug is the left-most
   * label of a `*.zhiye.com` hostname (e.g. `mengniu.zhiye.com` → `mengniu`).
   */
  private slugFromUrl(value: string): { slug: string; base: string } | null {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(`.${BEISEN_ROOT_DOMAIN}`)) return null;
      const label = hostname.slice(0, hostname.length - BEISEN_ROOT_DOMAIN.length - 1);
      // Take the left-most label (handles any defensive multi-level subdomain) and reject `www`.
      const slug = label.split('.')[0];
      if (!slug || slug === 'www') return null;
      return { slug, base: beisenTenantHost(slug) };
    } catch {
      return null;
    }
  }

  /**
   * Derive the stable ATS id from a role record — the numeric `JobAdId`. Returns null when none
   * is usable.
   */
  private deriveAtsId(record: BeisenJobRecord): string | null {
    return this.numToText(record?.JobAdId);
  }

  /** Pick the role title across the known title-field variants. */
  private pickTitle(record: BeisenJobRecord): string | null {
    return this.cleanText(record?.JobAdName) ?? this.cleanText(record?.Name);
  }

  /**
   * Join the role body from `Duty` + `Require` (blank-line separated), falling back to the flat
   * `Description`. Returns null when nothing usable is present.
   */
  private deriveBody(record: BeisenJobRecord): string | null {
    const duty = this.cleanText(record?.Duty);
    const require = this.cleanText(record?.Require);
    const joined = [duty, require].filter((p): p is string => !!p).join('\n\n');
    return joined.length > 0 ? joined : this.cleanText(record?.Description);
  }

  /**
   * Derive structured + free-text location from a role record. `LocNames` is an array of
   * city/region strings; we keep a comma-joined free-text line for remote detection and place
   * the first part in `city`, the remainder in `state`.
   */
  private deriveLocation(record: BeisenJobRecord): {
    city: string | null;
    state: string | null;
    country: string | null;
    locationText: string | null;
  } {
    const parts: string[] = [];
    if (Array.isArray(record?.LocNames)) {
      for (const name of record.LocNames) {
        const v = this.cleanText(name);
        if (v) parts.push(v);
      }
    }
    if (parts.length === 0) {
      const flat = this.cleanText(record?.Location);
      if (flat) parts.push(flat);
    }
    if (parts.length === 0) {
      return { city: null, state: null, country: null, locationText: null };
    }
    const locationText = parts.join(', ');
    const city = parts[0];
    const state = parts.length > 1 ? parts.slice(1).join(', ') : null;
    return { city, state, country: null, locationText };
  }

  /**
   * Convert the role body per `descriptionFormat`. The body may carry HTML, so HTML returns it
   * as-is, Markdown converts it, and Plain strips any tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Surface the role's location parts as a LocationDto, or null when nothing usable. */
  private extractLocation(job: BeisenJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the title, location, or department text (EN + ZH). */
  private detectRemote(
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (BEISEN_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse an ISO / epoch timestamp into a YYYY-MM-DD string. Beisen's `0001-01-01…` unset
   * sentinel and any unparseable value yield null.
   */
  private parseDate(value: string | number | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = value > 1e12 ? value : value * 1000;
      const parsed = new Date(ms);
      return isNaN(parsed.getTime()) ? null : toDateOnly(ms);
    }
    const cleaned = this.cleanText(typeof value === 'string' ? value : null);
    if (!cleaned) return null;
    if (cleaned.startsWith(BEISEN_UNSET_DATE_PREFIX)) return null;
    try {
      const parsed = new Date(cleaned.replace(' ', 'T'));
      if (!isNaN(parsed.getTime())) return toDateOnly(cleaned.replace(' ', 'T'));
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

  /** Coerce a numeric / string count field into an integer, or null. */
  private numToInt(value: number | string | null | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string') {
      const n = parseInt(value.trim(), 10);
      return Number.isFinite(n) ? n : null;
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
