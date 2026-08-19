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
  CARERIX_ROOT_DOMAIN,
  CARERIX_HOST_TEMPLATE,
  CARERIX_FEED_PATHS,
  CARERIX_JOBBOARD_FEED_PATH,
  CARERIX_RSS_FEED_PATH,
  CARERIX_PAGE_SIZE,
  CARERIX_MAX_PAGES,
  CARERIX_DEFAULT_RESULTS,
  CARERIX_HEADERS,
  CARERIX_INDEED_JOB_REGEX,
  CARERIX_RSS_ITEM_REGEX,
  CARERIX_PUBLICATION_ID_REGEX,
  CARERIX_REMOTE_REGEX,
} from './carerix.constants';
import { CarerixFeedJob, CarerixJob } from './carerix.types';

/**
 * Carerix ATS careers scraper — generic, multi-tenant.
 *
 * Carerix (carerix.com, Netherlands) provisions each customer ("application") on its
 * own sub-domain `https://{tenant}.carerix.com/` and publishes that tenant's open
 * vacancies through the bundled, public, unauthenticated **CxTools** XML feeds under
 * `/cxtools/`:
 *
 *   GET https://{tenant}.carerix.com/cxtools/indeedFeed.php      (Indeed XML schema)
 *   GET https://{tenant}.carerix.com/cxtools/jobboardFeed.php?start=&count=  (generic)
 *   GET https://{tenant}.carerix.com/cxtools/RSSx.php            (RSS / J4P fallback)
 *
 * The adapter probes these feeds in order, parsing each `<job>` / `<item>` element
 * into a vacancy. The stable Carerix `publicationID` (the Indeed `<referencenumber>`
 * or the id embedded in the publication's detail / apply URL) is the ATS id, and the
 * publication's own `<url>` is the canonical candidate-facing detail / apply URL.
 *
 * The caller addresses a tenant by `companySlug` (the Carerix application name) or by
 * `companyUrl` (any URL on a `carerix.com` host whose sub-domain encodes the tenant).
 * A tenant with the feed disabled / no published vacancies yields an empty feed (or
 * HTTP 404), so it degrades naturally to an empty result. A fetch error, an HTTP 4xx,
 * a DNS failure, or a malformed body degrades to an empty / partial result rather
 * than throwing, so a single bad tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.CARERIX,
  name: 'Carerix',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class CarerixService implements IScraper {
  private readonly logger = new Logger(CarerixService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Carerix scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Carerix tenant slug from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(CARERIX_HEADERS);

    const resultsWanted = input.resultsWanted ?? CARERIX_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Carerix vacancies for tenant: ${tenant}`);

      const feedJobs = await this.fetchJobList(client, tenant, resultsWanted);
      if (feedJobs.length === 0) {
        this.logger.log(`Carerix tenant "${tenant}" has no published vacancies`);
        return new JobResponseDto([]);
      }

      for (const feedJob of feedJobs) {
        try {
          const post = this.processFeedJob(feedJob, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing Carerix vacancy ${feedJob.referenceNumber}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Carerix total: ${jobPosts.length} vacancies for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Carerix scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Probe the tenant's public CxTools feeds in order, returning the parsed,
   * de-duplicated vacancies from the first feed that yields any. The generic
   * job-board feed is paged via `start`/`count`; the Indeed / RSS feeds render the
   * whole board in one document. An unknown tenant or disabled feed (HTTP 4xx /
   * empty body) degrades to an empty list.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    resultsWanted: number,
  ): Promise<CarerixFeedJob[]> {
    const origin = CARERIX_HOST_TEMPLATE(tenant);

    for (const path of CARERIX_FEED_PATHS) {
      const seen = new Set<string>();
      const items: CarerixFeedJob[] = [];
      const paged = path === CARERIX_JOBBOARD_FEED_PATH;

      for (let page = 0; page < (paged ? CARERIX_MAX_PAGES : 1); page++) {
        const url = this.buildFeedUrl(origin, path, page);
        const body = await this.fetchText(client, url, tenant);
        if (body == null) break;

        const parsed = this.parseFeed(body, path);
        let added = 0;
        for (const job of parsed) {
          const id = this.cleanText(job.referenceNumber);
          // Fall back to the URL-encoded publication id for de-dup when no ref id.
          const key = id ?? this.cleanText(job.url) ?? '';
          if (!key || seen.has(key)) continue;
          seen.add(key);
          items.push(job);
          added++;
          if (items.length >= resultsWanted) return items;
        }

        // Stop the page walk once a page yields no new vacancies.
        if (added === 0) break;
      }

      if (items.length > 0) {
        this.logger.log(`Carerix feed ${path} yielded ${items.length} vacancies for ${tenant}`);
        return items;
      }
    }

    return [];
  }

  /** Build a concrete feed URL for a given path + page index. */
  private buildFeedUrl(origin: string, path: string, page: number): string {
    if (path === CARERIX_JOBBOARD_FEED_PATH) {
      const start = page * CARERIX_PAGE_SIZE;
      return `${origin}${path}?start=${start}&count=${CARERIX_PAGE_SIZE}`;
    }
    return `${origin}${path}`;
  }

  /** GET a feed URL as text; an HTTP 4xx / DNS failure degrades to null (no throw). */
  private async fetchText(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Carerix feed not found (HTTP ${status}) for ${tenant}`);
        return null;
      }
      // 5xx / network / DNS error — degrade gracefully rather than throwing.
      this.logger.warn(`Carerix feed fetch failed for ${tenant}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse a feed body into vacancy fragments. The Indeed and generic job-board feeds
   * share the `<job>…</job>` element shape; the RSS feed uses `<item>…</item>`. We
   * anchor on those block elements and read the labelled child tags, rather than
   * depending on a strict XML parser, so minor schema drift never throws.
   */
  private parseFeed(body: string, path: string): CarerixFeedJob[] {
    const isRss = path === CARERIX_RSS_FEED_PATH;
    const blockRegex = isRss ? CARERIX_RSS_ITEM_REGEX : CARERIX_INDEED_JOB_REGEX;

    const out: CarerixFeedJob[] = [];
    blockRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(body)) !== null) {
      const block = match[1] ?? '';
      const job = isRss ? this.parseRssItem(block) : this.parseIndeedJob(block);
      if (job) out.push(job);
    }
    return out;
  }

  /** Parse one Indeed-schema `<job>` block into a CarerixFeedJob. */
  private parseIndeedJob(block: string): CarerixFeedJob | null {
    const url = this.tag(block, 'url') ?? this.tag(block, 'link');
    const referenceNumber =
      this.tag(block, 'referencenumber') ??
      this.tag(block, 'reference') ??
      this.publicationIdFromUrl(url);

    const job: CarerixFeedJob = {
      referenceNumber,
      title: this.tag(block, 'title'),
      url,
      company: this.tag(block, 'company'),
      city: this.tag(block, 'city'),
      state: this.tag(block, 'state'),
      country: this.tag(block, 'country'),
      date: this.tag(block, 'date'),
      jobType: this.tag(block, 'jobtype'),
      category: this.tag(block, 'category'),
      description: this.tag(block, 'description'),
    };

    if (!job.title && !job.referenceNumber && !job.url) return null;
    return job;
  }

  /** Parse one RSS `<item>` block into a CarerixFeedJob (J4P / RSS fallback). */
  private parseRssItem(block: string): CarerixFeedJob | null {
    const url = this.tag(block, 'link') ?? this.tag(block, 'url');
    const referenceNumber =
      this.tag(block, 'referencenumber') ??
      this.tag(block, 'guid') ??
      this.publicationIdFromUrl(url);

    const job: CarerixFeedJob = {
      referenceNumber: this.publicationIdFromUrl(referenceNumber) ?? referenceNumber,
      title: this.tag(block, 'title'),
      url,
      company: this.tag(block, 'company') ?? this.tag(block, 'author'),
      city: this.tag(block, 'city'),
      state: this.tag(block, 'state') ?? this.tag(block, 'region'),
      country: this.tag(block, 'country'),
      date: this.tag(block, 'pubdate') ?? this.tag(block, 'date'),
      jobType: this.tag(block, 'jobtype') ?? this.tag(block, 'type'),
      category: this.tag(block, 'category'),
      description: this.tag(block, 'description'),
    };

    if (!job.title && !job.referenceNumber && !job.url) return null;
    return job;
  }

  /**
   * Read a single XML child tag's text out of a feed block, unwrapping a CDATA
   * section and decoding the common XML entities. Returns null when absent / empty.
   */
  private tag(block: string, name: string): string | null {
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
    const m = re.exec(block);
    if (!m) return null;
    return this.cleanText(this.decodeXml(this.stripCdata(m[1])));
  }

  /** Unwrap a `<![CDATA[…]]>` wrapper, if present. */
  private stripCdata(value: string): string {
    const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
    return m ? m[1] : value;
  }

  /** Decode the handful of XML entities the feeds emit. */
  private decodeXml(value: string): string {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /** Extract a Carerix publicationID from a publication detail / apply URL. */
  private publicationIdFromUrl(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const m = CARERIX_PUBLICATION_ID_REGEX.exec(cleaned);
    return m ? m[1] : null;
  }

  /** Map a parsed feed vacancy → JobPostDto. */
  private processFeedJob(
    feedJob: CarerixFeedJob,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const job = this.normaliseJob(feedJob, tenant);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised CarerixJob from a parsed feed vacancy. */
  private normaliseJob(feedJob: CarerixFeedJob, tenant: string): CarerixJob {
    const jobId =
      this.cleanText(feedJob.referenceNumber) ??
      this.publicationIdFromUrl(feedJob.url) ??
      '';
    const title = this.cleanText(feedJob.title);
    const city = this.cleanText(feedJob.city);
    const state = this.cleanText(feedJob.state);
    const country = this.cleanText(feedJob.country);

    return {
      jobId,
      url: this.cleanText(feedJob.url) ?? this.buildJobUrl(tenant, jobId),
      title,
      companyName: this.cleanText(feedJob.company) ?? this.deriveCompanyName(tenant),
      city,
      state,
      country,
      department: this.cleanText(feedJob.category),
      employmentType: this.normaliseEmploymentType(feedJob.jobType),
      description: this.cleanText(feedJob.description),
      datePosted: this.parseDate(feedJob.date),
      isRemote: this.detectRemote(title, city, state, feedJob.jobType, feedJob.category),
    };
  }

  /** Map a normalised CarerixJob → JobPostDto. */
  private processJob(
    job: CarerixJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    const description = this.formatDescription(job.description ?? null, format);

    return new JobPostDto({
      id: `carerix-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.CARERIX,
      atsId,
      atsType: 'carerix',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the vacancy body per `descriptionFormat`. The feed body is HTML, so HTML
   * is returned as-is, markdown is converted, and plain text is stripped.
   */
  private formatDescription(text: string | null, format?: DescriptionFormat): string | null {
    if (!text) return null;
    if (format === DescriptionFormat.HTML) return text;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(text) ?? text;
    return htmlToPlainText(text) ?? text;
  }

  /**
   * Resolve the tenant slug (the Carerix application name). An explicit `companySlug`
   * is used directly (a bare host / URL passed as the slug is reduced to its tenant
   * token); a `companyUrl` on a `carerix.com` host has the tenant taken from its
   * leading sub-domain label. Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (/^https?:\/\//i.test(slug) || slug.includes(CARERIX_ROOT_DOMAIN)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant token from a Carerix URL. Tenants are addressed by sub-domain
   * (`https://{tenant}.carerix.com/…`), so the tenant is the leading host label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(CARERIX_ROOT_DOMAIN)) return '';
      const labels = hostname.split('.');
      // {tenant}.carerix.com → at least 3 labels; the first is the tenant.
      if (labels.length < 3) return '';
      const tenant = labels[0];
      // `www` is not a tenant; ignore the marketing host.
      if (!tenant || tenant === 'www') return '';
      return tenant;
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Build a best-effort public detail / apply URL for a vacancy from its parts. */
  private buildJobUrl(tenant: string, jobId: string): string {
    const origin = CARERIX_HOST_TEMPLATE(tenant);
    // Documented SRSx short-URL form: `…/vacature-{publicationID}`.
    return jobId ? `${origin}/vacature-${jobId}` : origin;
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
  private extractLocation(job: CarerixJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote / hybrid roles from the title, location, type, or category text. */
  private detectRemote(
    title: string | null,
    city: string | null,
    state: string | null,
    jobType: string | null | undefined,
    category: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, city, state, jobType, category];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (CARERIX_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Normalise a Carerix `<jobtype>` token (e.g. "fulltime", "parttime",
   * "FULL_TIME", "Vast / Tijdelijk") into a readable, trimmed, title-cased label.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const spaced = cleaned
      .replace(/[_]+/g, ' ')
      .replace(/\bfulltime\b/i, 'full time')
      .replace(/\bparttime\b/i, 'part time')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return spaced.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse a feed date value into a YYYY-MM-DD string. Relative values are not
   * absolute dates and yield null; an absolute date string is parsed + normalised.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    if (/\b(ago|geleden)\b/i.test(cleaned)) return null; // relative, not absolute
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
