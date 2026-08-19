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
  RECRUITLY_ROOT_DOMAIN,
  RECRUITLY_JOB_PATH,
  RECRUITLY_DEFAULT_RESULTS,
  RECRUITLY_DEFAULT_TIMEOUT_SECONDS,
  RECRUITLY_HEADERS,
  RECRUITLY_OPEN_STATUS,
  RECRUITLY_REMOTE_REGEX,
  recruitlyJobFeedUrl,
  recruitlyApplyUrl,
} from './recruitly.constants';
import {
  RecruitlyJob,
  RecruitlyJobItem,
  RecruitlyJobFeed,
} from './recruitly.types';

/**
 * Recruitly ATS careers scraper — generic, multi-tenant.
 *
 * Recruitly (recruitly.io — a UK-headquartered recruitment-agency CRM / ATS) exposes each
 * tenant's published, candidate-facing job board through a single, public, unauthenticated
 * JSON endpoint on its shared API host, addressed by the tenant's public board **API key**:
 *
 *   GET https://api.recruitly.io/api/job?apiKey={apiKey}
 *     → { "data": [ … ] }   (the tenant's published roles)
 *
 * Each role carries a `hire…`-prefixed string `id` (the stable ATS id and the final segment
 * of the public apply URL), a numeric `uniqueId`, an agency `reference`, a `title`, a
 * `status` (`OPEN` / `CLOSED`), a `jobType` / `employmentType`, a `remoteWorking` flag, a
 * `companyName` (the hiring brand the agency recruits for), a structured `location`, a
 * `pay` block, a `postedOn` date (`DD/MM/YYYY`), an HTML `description`, and a public
 * `applyUrl` (`https://jobs.recruitly.io/widget/apply/{id}`). The adapter reads the JSON
 * feed directly — rather than depending on a client-rendered DOM, a headless browser, or
 * the authenticated back-office REST API.
 *
 * The caller addresses a tenant board by its public board API key, passed as `companySlug`
 * (the bare key) or embedded in a `companyUrl` (a Recruitly board / widget / API URL whose
 * `apiKey` query parameter or `/api/job` path carries the key). An unknown / revoked key,
 * a tenant with no published roles, or an empty board degrades naturally to an empty
 * result. A fetch error, an HTTP 4xx, a DNS failure, or a malformed body degrades to an
 * empty / partial result rather than throwing, so a single bad tenant never nukes a batch
 * run.
 */
@SourcePlugin({
  site: Site.RECRUITLY,
  name: 'Recruitly',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class RecruitlyService implements IScraper {
  private readonly logger = new Logger(RecruitlyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Recruitly scraper');
      return new JobResponseDto([]);
    }

    const apiKey = this.resolveApiKey(companySlug, input.companyUrl);
    if (!apiKey) {
      this.logger.warn('Could not resolve a Recruitly board API key from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Recruitly API host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH keys:
    // the no-proxy path keys off `timeout`, the proxy path off `requestTimeout`. A caller
    // may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? RECRUITLY_DEFAULT_TIMEOUT_SECONDS,
      RECRUITLY_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(RECRUITLY_HEADERS);

    const resultsWanted = input.resultsWanted ?? RECRUITLY_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log('Fetching Recruitly jobs for board API key');

      const jobs = await this.fetchJobs(client, apiKey);
      if (jobs == null) {
        this.logger.log('Recruitly board API key has no reachable published-roles feed');
        return new JobResponseDto([]);
      }

      if (jobs.length === 0) {
        this.logger.log('Recruitly board has no published roles');
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const item of jobs) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processItem(item, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Recruitly role ${item?.id}: ${err.message}`);
        }
      }

      this.logger.log(`Recruitly total: ${jobPosts.length} jobs`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Recruitly scrape error: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch the tenant board's public published-roles JSON feed. Returns the parsed roles
   * (possibly empty — an empty board is a valid "no roles" result), or null when the host
   * is unreachable / answered an HTTP error / returned an unusable body.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    apiKey: string,
  ): Promise<RecruitlyJobItem[] | null> {
    const url = recruitlyJobFeedUrl(apiKey);
    const body = await this.fetchJson(client, url);
    if (body == null) return null;
    return this.extractJobs(body);
  }

  /**
   * GET a Recruitly API URL as JSON. Returns the parsed body, or null when the response
   * carried no usable body, the host answered an HTTP error status (4xx / 5xx — a real,
   * reachable host), or a transport-level failure occurred (DNS / refused / reset /
   * timeout). Never throws — every failure degrades gracefully.
   */
  private async fetchJson(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<unknown | null> {
    try {
      const response = await client.get<unknown>(url, { responseType: 'json' });
      const data = response?.data;
      // Some clients hand back the JSON as a string when the server omits a JSON
      // content-type; parse it defensively so the feed is still usable.
      if (typeof data === 'string') {
        try {
          return JSON.parse(data);
        } catch {
          return null;
        }
      }
      return data ?? null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx unknown / revoked key, 5xx) — reachable,
        // but no usable feed. Degrade to empty.
        this.logger.warn(`Recruitly feed returned HTTP ${status}`);
        return null;
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout).
      this.logger.warn(`Recruitly feed fetch failed: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Narrow the published-roles array out of the parsed feed body. Recruitly answers a
   * `{ "data": [ … ] }` envelope; a few deployments answer a bare array. Returns the role
   * array (possibly empty — an empty board is a valid "no roles" result), or null when the
   * body carries no usable role list.
   */
  private extractJobs(body: unknown): RecruitlyJobItem[] | null {
    if (Array.isArray(body)) return body as RecruitlyJobItem[];
    const feed = body as RecruitlyJobFeed | null;
    if (feed && Array.isArray(feed.data)) return feed.data as RecruitlyJobItem[];
    return null;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: RecruitlyJobItem,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, format);
  }

  /** Build a normalised RecruitlyJob from a parsed role. */
  private normaliseItem(item: RecruitlyJobItem): RecruitlyJob | null {
    const atsId = this.deriveAtsId(item);
    if (!atsId) return null;

    // A CLOSED / archived role is not a live, applyable vacancy — skip it.
    const status = this.cleanText(item.status);
    if (status && status.toUpperCase() !== RECRUITLY_OPEN_STATUS) return null;

    const url = this.deriveApplyUrl(item, atsId);
    const location = item.location ?? null;
    const city = this.cleanText(location?.cityName);
    const state = this.cleanText(location?.regionName);
    const country = this.cleanText(location?.countryName) ?? this.cleanText(location?.countryCode);
    const locationText = this.joinLocation(city, state, country);
    const employmentType = this.cleanText(item.employmentType) ?? this.cleanText(item.jobType);
    const title = this.cleanText(item.title);

    return {
      atsId,
      url,
      // The Recruitly apply-widget page is the public detail + apply surface.
      applyUrl: url,
      title,
      companyName: this.cleanText(item.companyName),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(item.description),
      employmentType,
      datePosted: this.parseDate(item.postedOn),
      isRemote: this.detectRemote(item, title, locationText, employmentType),
    };
  }

  /** Map a normalised RecruitlyJob → JobPostDto. */
  private processJob(job: RecruitlyJob, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? '';
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `recruitly-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.RECRUITLY,
      atsId,
      atsType: 'recruitly',
      department: null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Recruitly feeds expose the
   * body as HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the
   * tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the public board API key. An explicit `companySlug` is used directly (a board
   * / widget / API URL passed as the slug has its `apiKey` extracted); a `companyUrl` on a
   * `recruitly.io` host has its `apiKey` query parameter (or last `/api/job` segment)
   * extracted. Returns an empty string when neither yields a key.
   */
  private resolveApiKey(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full board / widget / API URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(RECRUITLY_ROOT_DOMAIN)) {
        const fromUrl = this.apiKeyFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug;
    }
    if (companyUrl) {
      const fromUrl = this.apiKeyFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Extract the board API key from a Recruitly board / widget / API URL. The key is the
   * `apiKey` query parameter (`…?apiKey={key}`) on the board-embed / API URLs.
   */
  private apiKeyFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(RECRUITLY_ROOT_DOMAIN)) {
        // Not a Recruitly host — no derivable board key.
        return '';
      }
      const apiKey = u.searchParams.get('apiKey');
      if (apiKey && apiKey.trim()) return apiKey.trim();
    } catch {
      // Malformed URL — no key.
    }
    return '';
  }

  /** Pick the stable ATS id: the `hire…` `id`, else `uniqueId`, else `reference`. */
  private deriveAtsId(item: RecruitlyJobItem): string | null {
    return (
      this.cleanText(item.id) ??
      this.numToText(item.uniqueId) ??
      this.cleanText(item.reference)
    );
  }

  /**
   * Pick the canonical public apply / detail URL: the feed's own `applyUrl` when it is a
   * usable Recruitly URL, else the built apply-widget URL for the role id.
   */
  private deriveApplyUrl(item: RecruitlyJobItem, atsId: string): string {
    const applyUrl = this.cleanText(item.applyUrl);
    if (applyUrl && /^https?:\/\//i.test(applyUrl)) return applyUrl;
    return recruitlyApplyUrl(atsId);
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: RecruitlyJob): LocationDto | null {
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
   * Detect remote roles from the structured `remoteWorking` flag, then from the title,
   * location, or employment-type text.
   */
  private detectRemote(
    item: RecruitlyJobItem,
    title: string | null,
    location: string | null,
    employmentType: string | null | undefined,
  ): boolean {
    if (item.remoteWorking === true) return true;
    const haystacks: Array<string | null | undefined> = [title, location, employmentType];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (RECRUITLY_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse a `DD/MM/YYYY` (or ISO) date value into a YYYY-MM-DD string. Non-parseable
   * values yield null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;

    // Recruitly emits `DD/MM/YYYY`; normalise it explicitly (a bare `new Date` mis-reads
    // it as `MM/DD/YYYY`).
    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(cleaned);
    if (dmy) {
      const [, dd, mm, yyyy] = dmy;
      const day = dd.padStart(2, '0');
      const month = mm.padStart(2, '0');
      const parsed = new Date(`${yyyy}-${month}-${day}T00:00:00Z`);
      if (!isNaN(parsed.getTime())) return toDateOnly(`${yyyy}-${month}-${day}T00:00:00Z`);
      return null;
    }

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
