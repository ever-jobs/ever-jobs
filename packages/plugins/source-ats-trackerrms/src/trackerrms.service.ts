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
  TRACKERRMS_PORTAL_HOSTS,
  TRACKERRMS_DEFAULT_REGION,
  TRACKERRMS_ROOT_DOMAIN,
  TRACKERRMS_JOBS_PATH,
  TRACKERRMS_APPLY_PATH,
  TRACKERRMS_FIELDS,
  TRACKERRMS_DEFAULT_RESULTS,
  TRACKERRMS_MAX_ITEMS,
  TRACKERRMS_HEADERS,
  TRACKERRMS_ITEM_REGEX,
  TRACKERRMS_TITLE_REGEX,
  TRACKERRMS_LINK_REGEX,
  TRACKERRMS_JOBCODE_REGEX,
  TRACKERRMS_REFERENCE_REGEX,
  TRACKERRMS_REMOTE_REGEX,
} from './trackerrms.constants';
import { TrackerRmsJob, TrackerRmsRawItem } from './trackerrms.types';

/**
 * TrackerRMS (Tracker / tracker-rms.com) ATS careers scraper — generic, multi-tenant.
 *
 * TrackerRMS is a staffing & recruiting ATS. Each tenant publishes its open roles
 * to the public via the "Publish Jobs to your Website" / "Jobs+" integration,
 * served by the shared regional EVO Portal host and keyed by the tenant's
 * TrackerRMS database name:
 *
 *   https://evoportal{us|uk|ca}.tracker-rms.com/{database}/jobs?fields={csv}
 *
 * The feed is a server-rendered HTML `<ul><li>…</li></ul>` fragment — one `<li>`
 * block per open role — whose column set is tenant-configured. The adapter
 * requests a broad field set, splits the fragment into role blocks, and parses
 * each block defensively (heading → title, anchor → apply URL + `jobcode`
 * reference, remaining markup → description, free-text → location / worktype).
 *
 * The caller addresses a tenant by `companySlug` (the TrackerRMS database name,
 * e.g. `Tracker_PrecisionResources`) or by `companyUrl` (an EVO Portal feed/apply
 * URL whose first path segment is the database name, and whose host encodes the
 * region). The whole feed lives in one document — there is no pagination — so we
 * fetch once and slice client-side to honour `resultsWanted`. A fetch error, an
 * unknown tenant (HTTP 4xx / empty feed), a malformed block, or a single bad role
 * degrades to an empty / partial result rather than throwing, so a single tenant
 * never nukes a batch run.
 */
@SourcePlugin({
  site: Site.TRACKERRMS,
  name: 'TrackerRMS',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TrackerRmsService implements IScraper {
  private readonly logger = new Logger(TrackerRmsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for TrackerRMS scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant.database) {
      this.logger.warn('Could not resolve a TrackerRMS database from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TRACKERRMS_HEADERS);

    const resultsWanted = input.resultsWanted ?? TRACKERRMS_DEFAULT_RESULTS;
    const host = TRACKERRMS_PORTAL_HOSTS[tenant.region] ?? TRACKERRMS_PORTAL_HOSTS[TRACKERRMS_DEFAULT_REGION];
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching TrackerRMS jobs for database "${tenant.database}" (${tenant.region})`);

      // The feed enumerates every open role for the tenant in one HTML document.
      const items = await this.fetchJobFeed(client, host, tenant.database);
      if (items.length === 0) {
        this.logger.log(`TrackerRMS database "${tenant.database}" has no open roles`);
        return new JobResponseDto([]);
      }

      for (const item of items) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processItem(item, host, tenant.database, seen, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing TrackerRMS role: ${err.message}`);
        }
      }

      this.logger.log(`TrackerRMS total: ${jobPosts.length} jobs for ${tenant.database}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`TrackerRMS scrape error for ${tenant.database}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch the tenant feed and split it into raw role blocks. An unknown database /
   * wrong region returns an HTTP 4xx (or an empty fragment), both of which degrade
   * to an empty list rather than throwing.
   */
  private async fetchJobFeed(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    database: string,
  ): Promise<TrackerRmsRawItem[]> {
    const url =
      `${host}/${encodeURIComponent(database)}${TRACKERRMS_JOBS_PATH}` +
      `?fields=${encodeURIComponent(TRACKERRMS_FIELDS)}`;

    let html = '';
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      html = typeof response.data === 'string' ? response.data : '';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`TrackerRMS feed not found (HTTP ${status}) at ${url}`);
        return [];
      }
      throw err;
    }

    return this.splitItems(html);
  }

  /** Split the feed fragment into per-role `<li>` blocks (bounded by a hard ceiling). */
  private splitItems(html: string): TrackerRmsRawItem[] {
    const items: TrackerRmsRawItem[] = [];
    if (!html) return items;

    const re = new RegExp(TRACKERRMS_ITEM_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null && items.length < TRACKERRMS_MAX_ITEMS) {
      const inner = match[1] ?? '';
      // A role block has either a heading or an anchor; skip pure layout `<li>`s.
      if (!TRACKERRMS_TITLE_REGEX.test(inner) && !TRACKERRMS_LINK_REGEX.test(inner)) continue;
      const linkMatch = TRACKERRMS_LINK_REGEX.exec(inner);
      items.push({ html: inner, applyHref: linkMatch ? linkMatch[1] : null });
    }

    return items;
  }

  /** Parse one raw role block into a normalised job, then map it to a JobPostDto. */
  private processItem(
    item: TrackerRmsRawItem,
    host: string,
    database: string,
    seen: Set<string>,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const job = this.parseItem(item, host, database);
    if (!job) return null;
    if (seen.has(job.jobId)) return null;
    seen.add(job.jobId);
    return this.processJob(job, database, format);
  }

  /** Parse a raw `<li>` block into a normalised TrackerRmsJob (best-effort). */
  private parseItem(item: TrackerRmsRawItem, host: string, database: string): TrackerRmsJob | null {
    const inner = item.html;

    const titleMatch = TRACKERRMS_TITLE_REGEX.exec(inner);
    const title = this.cleanText(this.stripTags(titleMatch ? titleMatch[1] : null));

    const applyHref = this.cleanText(item.applyHref);
    const reference = this.resolveReference(applyHref, inner);
    // Without a stable reference we cannot build a deterministic id / apply URL.
    if (!reference) return null;

    const url = applyHref
      ? this.absoluteUrl(applyHref, host)
      : this.buildApplyUrl(host, database, reference);

    // The description is the block markup minus the heading and the apply anchor.
    const descriptionHtml = this.extractDescription(inner);
    const locationText = this.extractLabelledField(inner, ['location', 'city', 'town']);
    const worktype = this.extractLabelledField(inner, ['worktype', 'work type', 'job type', 'type']);
    const location = this.splitLocation(locationText);

    return {
      jobId: reference,
      url,
      title,
      companyName: this.deriveCompanyName(database),
      descriptionHtml,
      city: location.city,
      state: location.state,
      country: location.country,
      employmentType: this.normaliseEmploymentType(worktype),
      isRemote: this.detectRemote(title, locationText, worktype),
    };
  }

  /** Map a normalised TrackerRmsJob → JobPostDto. */
  private processJob(
    job: TrackerRmsJob,
    database: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(database);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `trackerrms-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.TRACKERRMS,
      atsId,
      atsType: 'trackerrms',
      department: null,
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The block body is HTML, so
   * markdown / plain conversion is consistent with the sibling adapters.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the tenant database + region. An explicit `companySlug` is used as the
   * database name directly (a feed/apply URL passed as the slug is reduced to its
   * database + region); a `companyUrl` on a `tracker-rms.com` EVO Portal host has
   * the database taken from its first path segment and the region from its host
   * label. Returns an empty database when neither yields one.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): { database: string; region: string } {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full EVO Portal URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(TRACKERRMS_ROOT_DOMAIN)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl.database) return fromUrl;
      }
      return { database: slug, region: TRACKERRMS_DEFAULT_REGION };
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl.database) return fromUrl;
    }
    return { database: '', region: TRACKERRMS_DEFAULT_REGION };
  }

  /**
   * Derive the database + region from a TrackerRMS EVO Portal URL. The public forms
   * are `https://evoportal{region}.tracker-rms.com/{database}/jobs` and
   * `…/{database}/apply`; the region is taken from the `evoportal{xx}` host label.
   */
  private tenantFromUrl(value: string): { database: string; region: string } {
    const empty = { database: '', region: TRACKERRMS_DEFAULT_REGION };
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(TRACKERRMS_ROOT_DOMAIN)) return empty;

      const region = this.regionFromHost(hostname);
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      if (segments.length > 0) {
        // First path segment is the TrackerRMS database name.
        const first = segments[0];
        if (first && first.toLowerCase() !== 'jobs' && first.toLowerCase() !== 'apply') {
          return { database: decodeURIComponent(first), region };
        }
      }
    } catch {
      // Malformed URL — no tenant.
    }
    return empty;
  }

  /** Map an `evoportal{xx}.tracker-rms.com` host label to a known region key. */
  private regionFromHost(hostname: string): string {
    const label = hostname.split('.')[0]; // e.g. "evoportalus"
    const suffix = label.replace(/^evoportal/i, '').toLowerCase();
    return TRACKERRMS_PORTAL_HOSTS[suffix] ? suffix : TRACKERRMS_DEFAULT_REGION;
  }

  /**
   * Recover the TrackerRMS reference (job code). Prefer the `jobcode` query param
   * on the apply link; fall back to a `reference|…` token rendered in the block.
   */
  private resolveReference(applyHref: string | null, inner: string): string | null {
    if (applyHref) {
      const fromHref = TRACKERRMS_JOBCODE_REGEX.exec(applyHref);
      if (fromHref && fromHref[1]) return this.cleanText(decodeURIComponent(fromHref[1]));
    }
    const fromBody = TRACKERRMS_REFERENCE_REGEX.exec(inner);
    if (fromBody && fromBody[1]) return this.cleanText(fromBody[1]);
    return null;
  }

  /** Build the canonical apply / candidate-registration URL for a role. */
  private buildApplyUrl(host: string, database: string, reference: string): string {
    return (
      `${host}/${encodeURIComponent(database)}${TRACKERRMS_APPLY_PATH}` +
      `?jobcode=${encodeURIComponent(reference)}`
    );
  }

  /** Resolve a possibly-relative href against the portal host into an absolute URL. */
  private absoluteUrl(href: string, host: string): string {
    try {
      return new URL(href, `${host}/`).toString();
    } catch {
      return href;
    }
  }

  /**
   * Build the description body: the block's inner HTML with the heading and the
   * apply anchor stripped out (so the candidate-facing role copy remains).
   */
  private extractDescription(inner: string): string | null {
    const body = inner
      .replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, ' ')
      .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ' ');
    const cleaned = this.cleanText(body);
    if (!cleaned) return null;
    // Only return a body if there is real text once tags are stripped.
    return this.cleanText(this.stripTags(cleaned)) ? cleaned : null;
  }

  /**
   * Pull a labelled free-text field (e.g. "Location: Birmingham, AL") from the
   * block's text. TrackerRMS renders fields inline, so we scan the de-tagged text
   * for any of the given labels and return the trailing value on that line.
   */
  private extractLabelledField(inner: string, labels: string[]): string | null {
    const text = this.stripTags(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n'));
    if (!text) return null;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      for (const label of labels) {
        const re = new RegExp(`^\\s*${this.escapeRegExp(label)}\\s*[:\\-]\\s*(.+)$`, 'i');
        const m = re.exec(line);
        if (m && m[1]) {
          const value = this.cleanText(m[1]);
          if (value) return value;
        }
      }
    }
    return null;
  }

  /** Split a "City, State, Country" style location string into structured parts. */
  private splitLocation(value: string | null): {
    city: string | null;
    state: string | null;
    country: string | null;
  } {
    const cleaned = this.cleanText(value);
    if (!cleaned) return { city: null, state: null, country: null };
    if (this.isRemoteToken(cleaned)) return { city: null, state: null, country: null };

    const parts = cleaned
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return { city: null, state: null, country: null };
    if (parts.length === 1) return { city: parts[0], state: null, country: null };
    if (parts.length === 2) return { city: parts[0], state: parts[1], country: null };
    return { city: parts[0], state: parts[1], country: parts.slice(2).join(', ') };
  }

  /** De-slugify + title-case the database name into a display company name. */
  private deriveCompanyName(database: string): string {
    const base = (database && database.trim() ? database.trim() : database)
      // TrackerRMS database names are commonly prefixed (e.g. "Tracker_Acme").
      .replace(/^tracker[_-]/i, '');
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Surface the role's location parts (city / state / country) as a LocationDto,
   * leaving location null when nothing usable is present.
   */
  private extractLocation(job: TrackerRmsJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the title, location, or worktype text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    worktype: string | null,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, worktype];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (TRACKERRMS_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^(remote|fully\s*remote|work\s*from\s*home|wfh)$/i.test(value.trim());
  }

  /**
   * Normalise a TrackerRMS worktype token (e.g. `Permanent`, `Contract`,
   * `Contract To Hire`, `Temp`, `Full Time`) into a readable, title-cased label.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    return cleaned
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Strip all HTML tags from a fragment, returning its text. */
  private stripTags(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    return value.replace(/<[^>]*>/g, ' ');
  }

  /** Escape a string for safe use inside a dynamically-built RegExp. */
  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.replace(/\s+/g, ' ').trim();
    return v.length > 0 ? v : null;
  }
}
