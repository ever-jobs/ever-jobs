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
  ELMO_HOST_SUFFIXES,
  ELMO_ROOT_DOMAINS,
  ELMO_CAREERS_PATH,
  ELMO_VIEW_PATH,
  ELMO_APPLY_PATH,
  ELMO_BOARD_FALLBACKS,
  ELMO_DEFAULT_RESULTS,
  ELMO_MAX_PAGES,
  ELMO_DEFAULT_TIMEOUT_SECONDS,
  ELMO_HEADERS,
  ELMO_JOB_ANCHOR_REGEX,
  ELMO_REMOTE_REGEX,
  elmoCareerOrigin,
} from './elmo.constants';
import { ElmoListingJob, ElmoJob } from './elmo.types';

/**
 * ELMO ATS careers scraper — generic, multi-tenant.
 *
 * ELMO (elmosoftware.com.au, Australia / NZ / APAC) is an Australian HR + recruitment /
 * talent-management suite. Every customer tenant publishes a branded, public,
 * unauthenticated candidate-facing career board on its own sub-domain of the shared
 * hosted talent host `https://{tenant}.elmotalent.com.au/careers/{board}` (and the NZ
 * host `.elmotalent.co.nz`). The open-roles index is a server-rendered HTML page that
 * lists the tenant's open roles inline; each role row links to its canonical detail page
 * `https://{tenant}.elmotalent.com.au/careers/{board}/job/view/{jobId}`.
 *
 * The adapter resolves the tenant + board, fetches the server-rendered board across a
 * small set of likely `{board}` segments until one renders a role list, scrapes that
 * listing HTML (anchoring on the `/job/view/{jobId}` links rather than on volatile CSS
 * class names), and maps each role. The numeric `{jobId}` from the `/job/view/{jobId}`
 * URL is the stable ATS id; the canonical detail / apply URLs are
 * `/careers/{board}/job/view/{jobId}` and `/careers/{board}/job/apply/{jobId}`.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `anzca`) or by `companyUrl` (a
 * career-board URL whose host encodes the tenant slug and whose path may carry the
 * `{board}` segment). An unknown tenant, one with no open roles, an empty board, or a
 * 302-redirect off the board to the ELMO marketing site degrades naturally to an empty
 * result. A fetch error, an HTTP 4xx, a DNS failure, or a malformed body degrades to an
 * empty / partial result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.ELMO,
  name: 'ELMO',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ElmoService implements IScraper {
  private readonly logger = new Logger(ElmoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for ELMO scraper');
      return new JobResponseDto([]);
    }

    const resolved = this.resolveTenant(companySlug, input.companyUrl);
    if (!resolved) {
      this.logger.warn('Could not resolve an ELMO tenant slug from input');
      return new JobResponseDto([]);
    }
    const { tenant, board: boardHint } = resolved;

    // Cap the per-request timeout so an unresponsive ELMO talent host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH
    // keys: the no-proxy path keys off `timeout`, the proxy path off
    // `requestTimeout`. A caller may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? ELMO_DEFAULT_TIMEOUT_SECONDS,
      ELMO_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(ELMO_HEADERS);

    const resultsWanted = input.resultsWanted ?? ELMO_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching ELMO jobs for tenant: ${tenant}`);

      const found = await this.fetchListing(client, tenant, boardHint, resultsWanted);
      if (!found) {
        this.logger.log(`ELMO tenant "${tenant}" has no reachable career board`);
        return new JobResponseDto([]);
      }

      const { listings, board } = found;
      if (listings.length === 0) {
        this.logger.log(`ELMO tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const listing of listings) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processListing(listing, tenant, board, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing ELMO role ${listing?.jobId}: ${err.message}`);
        }
      }

      this.logger.log(`ELMO total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`ELMO scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Probe the tenant's career board across the candidate `{board}` segments (the
   * input-derived board first, then the documented fallbacks) until one renders a role
   * list. Returns the parsed listings and the board segment that served them (used to
   * build per-role URLs), or null when none respond.
   */
  private async fetchListing(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    boardHint: string | null,
    resultsWanted: number,
  ): Promise<{ listings: ElmoListingJob[]; board: string } | null> {
    const origin = elmoCareerOrigin(tenant);
    const boards = this.candidateBoards(tenant, boardHint);
    let attempts = 0;

    for (const board of boards) {
      if (attempts >= ELMO_MAX_PAGES) return null;
      attempts++;

      const url = `${origin}/${ELMO_CAREERS_PATH}/${encodeURIComponent(board)}`;
      const { data: html, hostReachable } = await this.fetchHtml(client, url, tenant);
      // A transport-level failure (DNS / refused / reset / timeout) means the tenant
      // host itself is unreachable — no other board segment can succeed, so abort the
      // whole probe sweep rather than burning a full timeout per board.
      if (!hostReachable) return null;
      if (html == null) continue;

      const listings = this.extractListings(html, board, origin, resultsWanted);
      // A page rendering at least one `/job/view/{jobId}` link is the right board;
      // return its listings. A page with no role links is not this tenant's board —
      // try the next candidate segment.
      if (listings.length > 0) {
        this.logger.log(`ELMO board "${board}" yielded ${listings.length} roles for ${tenant}`);
        return { listings, board };
      }
    }

    return null;
  }

  /**
   * Build the ordered list of candidate `{board}` segments to probe: the
   * input-derived board (when present), then the tenant slug itself, then the
   * documented fallbacks — de-duplicated, preserving order.
   */
  private candidateBoards(tenant: string, boardHint: string | null): string[] {
    const ordered = [boardHint, tenant, ...ELMO_BOARD_FALLBACKS];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const b of ordered) {
      const board = this.cleanText(b);
      if (!board) continue;
      const key = board.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(board);
    }
    return out;
  }

  /**
   * GET a career-board URL as text. Returns `{ data, hostReachable }`:
   *  - `data` is the body, or null when the response carried no usable text / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the tenant host itself is unreachable and the
   *    caller should stop probing further board segments.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<{ data: string | null; hostReachable: boolean }> {
    try {
      // Do NOT follow redirects: a real ELMO board serves the open-roles index as a
      // direct 200, whereas a parked / wrong-board request 302-redirects OFF the board
      // host to the marketing site (https://elmosoftware.com.au), which is not a role
      // list. Surfacing the 3xx as a fast, skippable response keeps a dead board from
      // burning a timeout.
      const response = await client.get<string>(url, { responseType: 'text', maxRedirects: 0 });
      return {
        data: typeof response.data === 'string' ? response.data : null,
        hostReachable: true,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (3xx redirect-away, 4xx board-not-found, or
        // 5xx) — it is reachable, so the caller may still try other board segments. A
        // 3xx here means "not the board" and is skipped fast.
        this.logger.warn(`ELMO board returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout):
      // the tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`ELMO board fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Scrape the server-rendered board HTML into role listings. The page renders each
   * open role as an `<a href="…/careers/{board}/job/view/{jobId}">{title}</a>` link;
   * the adapter anchors on those links (rather than on volatile CSS class names),
   * reads the title from the anchor inner text, and de-duplicates by job id. Returns a
   * possibly-empty array (an empty board is a valid "no roles" result); a page with no
   * role links yields an empty array so the caller tries the next board segment.
   */
  private extractListings(
    html: string,
    board: string,
    origin: string,
    resultsWanted: number,
  ): ElmoListingJob[] {
    const out: ElmoListingJob[] = [];
    const seen = new Set<string>();

    ELMO_JOB_ANCHOR_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ELMO_JOB_ANCHOR_REGEX.exec(html)) !== null) {
      const jobId = this.cleanText(match[1]);
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);

      const title = this.cleanText(htmlToPlainText(match[2] ?? '') ?? match[2]);
      out.push({
        jobId,
        board,
        url: `${origin}/${ELMO_CAREERS_PATH}/${encodeURIComponent(board)}/${ELMO_VIEW_PATH}/${jobId}`,
        title,
        // The listing markup is tenant-themed; location / department / type / date are
        // surfaced from the detail page in a future enhancement and left null here.
        location: null,
        department: null,
        employmentType: null,
        date: null,
      });

      if (out.length >= resultsWanted) break;
    }

    return out;
  }

  /** Map a scraped listing → JobPostDto, deduping by ATS id. */
  private processListing(
    listing: ElmoListingJob,
    tenant: string,
    board: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseListing(listing, tenant, board);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised ElmoJob from a scraped listing. */
  private normaliseListing(
    listing: ElmoListingJob,
    tenant: string,
    board: string,
  ): ElmoJob | null {
    const atsId = this.cleanText(listing.jobId);
    if (!atsId) return null;

    const origin = elmoCareerOrigin(tenant);
    const url =
      this.cleanText(listing.url) ??
      `${origin}/${ELMO_CAREERS_PATH}/${encodeURIComponent(board)}/${ELMO_VIEW_PATH}/${atsId}`;
    const applyUrl = `${origin}/${ELMO_CAREERS_PATH}/${encodeURIComponent(board)}/${ELMO_APPLY_PATH}/${atsId}`;

    const title = this.cleanText(listing.title);
    const locationText = this.cleanText(listing.location);
    const { city, state, country } = this.splitLocation(locationText);
    const department = this.cleanText(listing.department);

    return {
      atsId,
      url,
      applyUrl,
      title,
      companyName: this.deriveCompanyName(tenant),
      city,
      state,
      country,
      locationText,
      department,
      employmentType: this.cleanText(listing.employmentType),
      datePosted: this.parseDate(listing.date),
      isRemote: this.detectRemote(title, locationText, department),
    };
  }

  /** Map a normalised ElmoJob → JobPostDto. */
  private processJob(
    job: ElmoJob,
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
    // The listing surface carries no per-role HTML body; the description is sourced from
    // the detail page in a future enhancement and is null here (format-aware for parity).
    const description = this.formatDescription(null, format);

    return new JobPostDto({
      id: `elmo-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.ELMO,
      atsId,
      atsType: 'elmo',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert a job-ad body per `descriptionFormat`. The body is HTML, so HTML returns it
   * as-is, Markdown converts it, and Plain strips the tags. Null bodies stay null.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug + an optional board hint. An explicit `companySlug` is used
   * directly (a bare career-board URL passed as the slug is reduced to its tenant token
   * + board); a `companyUrl` on an `elmotalent.com.au` / `.co.nz` host has the tenant
   * taken from its leading sub-domain label and the board from its `/careers/{board}`
   * path. Returns null when neither yields a tenant.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): { tenant: string; board: string | null } | null {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-board URL as the slug.
      if (/^https?:\/\//i.test(slug) || this.isElmoHost(slug)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return { tenant: slug.toLowerCase(), board: null };
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return null;
  }

  /** True when a bare value contains an ELMO talent root domain. */
  private isElmoHost(value: string): boolean {
    const lower = value.toLowerCase();
    return ELMO_ROOT_DOMAINS.some((d) => lower.includes(d));
  }

  /**
   * Derive the tenant token (+ board, when present) from an ELMO career-board URL. The
   * candidate-facing host is `{tenant}.elmotalent.com.au` (or `.co.nz`); the tenant is
   * the leading sub-domain label and the board is the first segment after `/careers/`.
   */
  private tenantFromUrl(value: string): { tenant: string; board: string | null } | null {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      const suffix = ELMO_HOST_SUFFIXES.find((s) => hostname.endsWith(s));
      if (!suffix) {
        // Not a hosted talent host — no derivable tenant.
        return null;
      }
      const label = hostname.slice(0, hostname.length - suffix.length);
      // Guard against an empty / `www` label.
      if (!label || label === 'www') return null;

      // Board = first path segment after `/careers/`, when present.
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      let board: string | null = null;
      const careersIdx = segments.findIndex((s) => s.toLowerCase() === ELMO_CAREERS_PATH);
      if (careersIdx >= 0 && segments[careersIdx + 1]) {
        board = this.cleanText(decodeURIComponent(segments[careersIdx + 1]));
      }
      return { tenant: label.toLowerCase(), board };
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
  private extractLocation(job: ElmoJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state / country.
   * Comma-separated tail is treated as the country; the head as the city. ELMO board
   * locations are often a single free-text line, so the whole value lands in `city`
   * when there is no comma; a bare "Remote" token yields a null location.
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

  /** Detect remote / hybrid roles from the title, location, or department text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (ELMO_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /**
   * Parse a date value into a YYYY-MM-DD string. Relative values are not absolute dates
   * and yield null; unparseable values yield null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    if (/\bago\b/i.test(cleaned)) return null; // relative, not absolute
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
