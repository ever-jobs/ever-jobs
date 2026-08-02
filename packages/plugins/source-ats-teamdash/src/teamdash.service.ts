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
  randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import {
  TEAMDASH_HOST_TEMPLATE,
  TEAMDASH_CAREER_PAGE_PATH_TEMPLATE,
  TEAMDASH_DEFAULT_CAREER_SLUG,
  TEAMDASH_CONTEXT_MARKER,
  TEAMDASH_MAX_CONCURRENCY,
  TEAMDASH_REQUEST_DELAY_MS,
  TEAMDASH_DEFAULT_RESULTS,
  TEAMDASH_HEADERS,
} from './teamdash.constants';
import {
  TeamdashContext,
  TeamdashFeedItem,
  TeamdashLanding,
  TeamdashLandingBlock,
} from './teamdash.types';

/**
 * Teamdash career-page scraper — generic, multi-tenant.
 *
 * Teamdash is an Estonian recruitment ATS. Every customer tenant publishes a
 * public career page on its own sub-domain under the shared apex
 * `teamdash.com` (e.g. `https://cr14.teamdash.com/`), or on a custom domain.
 *
 * Teamdash exposes no anonymous JSON listing API. Instead, each public career
 * page and job posting is a server-side-rendered "landing" whose full state is
 * embedded inline as a single `window.context = { ... }` JSON assignment.
 * The scraper:
 *
 *   1. Fetches the career-page landing HTML and extracts `window.context`.
 *   2. Reads `career_page_feed_contents` — a map of feed-slug → array of job
 *      summaries (`{ url, title, location, ... }`) — for the listing.
 *   3. Fans out (bounded, `Promise.allSettled`) to each job-posting URL, reads
 *      that landing's `window.context.landing`, and assembles the description
 *      HTML from `landing.data.blocks[]`.
 *   4. Maps each role to `JobPostDto`, de-duplicating by `atsId` (the opaque
 *      job-URL token) within the run.
 *
 * The tenant entry point is resolved from `companyUrl` (the full career-page
 * URL — preferred) or `companySlug` (the tenant sub-domain label, with a
 * best-effort `career-page` landing fallback). A fetch error, an unknown
 * tenant, or a malformed payload degrades to an empty/partial result rather
 * than throwing, so a single tenant never aborts a batch run.
 */
@SourcePlugin({
  site: Site.TEAMDASH,
  name: 'Teamdash',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TeamdashService implements IScraper {
  private readonly logger = new Logger(TeamdashService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Teamdash scraper');
      return new JobResponseDto([]);
    }

    const careerUrl = this.resolveCareerUrl(input.companySlug, input.companyUrl);
    if (!careerUrl) {
      this.logger.warn('Could not resolve a Teamdash career-page URL from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TEAMDASH_HEADERS);

    const resultsWanted = input.resultsWanted ?? TEAMDASH_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Teamdash career page: ${careerUrl}`);

      const listContext = await this.fetchContext(client, careerUrl);
      if (!listContext) {
        this.logger.warn(`Teamdash career page not found or unreadable: ${careerUrl}`);
        return new JobResponseDto([]);
      }

      const companyName = this.deriveCompanyName(listContext, input.companySlug, careerUrl);
      const feedItems = this.collectFeedItems(listContext);

      if (feedItems.length === 0) {
        this.logger.log(`Teamdash feed empty for ${companyName} (${careerUrl})`);
        return new JobResponseDto([]);
      }

      this.logger.log(
        `Teamdash feed parsed: ${feedItems.length} roles for ${companyName}`,
      );

      // Trim the candidate list to what the caller wants before fanning out to
      // detail pages, so we never fetch more detail than necessary.
      const wanted = feedItems.slice(0, resultsWanted);

      for (let i = 0; i < wanted.length; i += TEAMDASH_MAX_CONCURRENCY) {
        if (jobPosts.length >= resultsWanted) break;
        const chunk = wanted.slice(i, i + TEAMDASH_MAX_CONCURRENCY);

        const detailResults = await Promise.allSettled(
          chunk.map((item) => this.fetchDetailLanding(client, item)),
        );

        for (let j = 0; j < chunk.length; j += 1) {
          const item = chunk[j];
          const detailResult = detailResults[j];
          let landing: TeamdashLanding | null = null;
          if (detailResult.status === 'fulfilled') {
            landing = detailResult.value;
          } else {
            this.logger.warn(
              `Teamdash detail fetch failed for ${item.url}: ` +
                `${detailResult.reason?.message ?? detailResult.reason}`,
            );
          }

          try {
            const post = this.processItem(
              item,
              landing,
              companyName,
              input.descriptionFormat,
            );
            if (!post) continue;
            const key = post.atsId as string;
            if (seen.has(key)) continue;
            seen.add(key);
            jobPosts.push(post);
            if (jobPosts.length >= resultsWanted) break;
          } catch (err: any) {
            this.logger.warn(
              `Error processing Teamdash role ${item.url}: ${err.message}`,
            );
          }
        }

        if (
          jobPosts.length < resultsWanted &&
          i + TEAMDASH_MAX_CONCURRENCY < wanted.length
        ) {
          await randomSleep(TEAMDASH_REQUEST_DELAY_MS, TEAMDASH_REQUEST_DELAY_MS * 2);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Teamdash total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Teamdash scrape error for ${careerUrl}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /**
   * Fetch a Teamdash public page and extract its embedded `window.context`
   * JSON blob. Returns null on HTTP 4xx, a missing blob, or a parse failure.
   */
  private async fetchContext(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<TeamdashContext | null> {
    let html: string;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 401 || status === 403 || status === 404) {
        this.logger.warn(`Teamdash page not found (HTTP ${status}) for ${url}`);
        return null;
      }
      throw err;
    }
    return this.parseContext(html);
  }

  /**
   * Extract and parse the balanced `window.context = { ... }` JSON object from
   * a page's HTML. Returns null when the marker is absent or the JSON is
   * malformed — never throws.
   */
  private parseContext(html: string): TeamdashContext | null {
    if (!html) return null;
    const markerIdx = html.indexOf(TEAMDASH_CONTEXT_MARKER);
    if (markerIdx < 0) return null;

    const start = html.indexOf('{', markerIdx);
    if (start < 0) return null;

    // Walk the string tracking brace depth, respecting string literals and
    // escapes, so we capture exactly the balanced JSON object.
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < html.length; i += 1) {
      const ch = html[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end < 0) return null;

    try {
      return JSON.parse(html.substring(start, end)) as TeamdashContext;
    } catch (err: any) {
      this.logger.warn(`Teamdash context JSON parse error: ${err.message}`);
      return null;
    }
  }

  /**
   * Flatten `career_page_feed_contents` (a map of feed-slug → job arrays) into
   * a single de-duplicated list of feed items keyed by job URL.
   */
  private collectFeedItems(ctx: TeamdashContext): TeamdashFeedItem[] {
    const feeds = ctx.career_page_feed_contents;
    if (!feeds || typeof feeds !== 'object') return [];

    const out: TeamdashFeedItem[] = [];
    const seenUrls = new Set<string>();
    for (const key of Object.keys(feeds)) {
      const arr = feeds[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const url = typeof item.url === 'string' ? item.url.trim() : '';
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        out.push(item);
      }
    }
    return out;
  }

  /**
   * Fetch a job-posting landing and return its `landing` object (with the
   * description blocks). Returns null on any failure — the role is still
   * collected from the listing summary with a null description.
   */
  private async fetchDetailLanding(
    client: ReturnType<typeof createHttpClient>,
    item: TeamdashFeedItem,
  ): Promise<TeamdashLanding | null> {
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!url) return null;
    try {
      const ctx = await this.fetchContext(client, url);
      return ctx?.landing ?? null;
    } catch {
      return null;
    }
  }

  /** Map a listing item + optional detail landing into a `JobPostDto`. */
  private processItem(
    item: TeamdashFeedItem,
    landing: TeamdashLanding | null,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    // Skip internal-only postings.
    if (landing?.is_internal === true) return null;

    const jobUrl = typeof item.url === 'string' ? item.url.trim() : '';
    if (!jobUrl) return null;

    const atsId = this.extractAtsId(jobUrl);
    if (!atsId) return null;

    const title =
      this.cleanText(item.title) ??
      this.cleanText(landing?.data?.meta?.title) ??
      this.cleanText(landing?.display_name);
    if (!title) return null;

    const rawDescription = landing ? this.assembleDescription(landing) : null;
    let description: string | null = null;
    if (rawDescription) {
      if (format === DescriptionFormat.HTML) {
        description = rawDescription;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawDescription) ?? rawDescription;
      } else {
        description = htmlToPlainText(rawDescription);
      }
    }

    const department = this.cleanText(landing?.stage?.name) ?? null;

    return new JobPostDto({
      id: `teamdash-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(item),
      description,
      datePosted: this.parseDate(landing?.created_at ?? landing?.updated_at),
      isRemote: this.detectRemote(item, title, rawDescription),
      emails: extractEmails(description),
      site: Site.TEAMDASH,
      atsId,
      atsType: 'teamdash',
      department,
      applyUrl: jobUrl,
    });
  }

  /**
   * Assemble the description HTML from a job-posting landing's content blocks.
   * Concatenates the translatable HTML `content` (and hero heading/subheading)
   * of every block, preferring the landing's default language.
   */
  private assembleDescription(landing: TeamdashLanding): string | null {
    const blocks = landing.data?.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) return null;
    const lang = typeof landing.default_language === 'string' ? landing.default_language : 'en';

    const parts: string[] = [];
    for (const block of blocks) {
      this.pushBlockText(block.heading, lang, parts);
      this.pushBlockText(block.subheading, lang, parts);
      this.pushBlockText(block.content, lang, parts);
    }

    const joined = parts.join('\n').trim();
    return joined.length > 0 ? joined : null;
  }

  /**
   * Extract a single block field's HTML — a field may be a plain string or a
   * translatable `{ <lang>: html }` map — and append it to `out` when non-empty.
   */
  private pushBlockText(
    field: TeamdashLandingBlock['content'],
    lang: string,
    out: string[],
  ): void {
    if (!field) return;
    if (typeof field === 'string') {
      const v = field.trim();
      if (v) out.push(v);
      return;
    }
    if (typeof field === 'object') {
      const map = field as Record<string, string>;
      const candidate =
        (typeof map[lang] === 'string' ? map[lang] : undefined) ??
        (typeof map.en === 'string' ? map.en : undefined) ??
        Object.values(map).find((v) => typeof v === 'string');
      if (candidate && candidate.trim()) out.push(candidate.trim());
    }
  }

  /**
   * Resolve the career-page URL from an explicit `companyUrl` or, when only a
   * `companySlug` is given, build a best-effort career-page landing URL on the
   * tenant sub-domain. Returns an empty string when neither yields a URL.
   */
  private resolveCareerUrl(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companyUrl && companyUrl.trim()) {
      try {
        // Validate; return the URL as-is (it already points at a landing).
        const u = new URL(companyUrl.trim());
        return u.toString();
      } catch {
        // Fall through to slug-based resolution.
      }
    }

    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      let host: string;
      if (slug.includes('.')) {
        // A bare hostname was supplied as the slug.
        host = `https://${slug.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
      } else {
        host = TEAMDASH_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(slug));
      }
      const path = TEAMDASH_CAREER_PAGE_PATH_TEMPLATE.replace(
        '{slug}',
        TEAMDASH_DEFAULT_CAREER_SLUG,
      );
      return `${host}${path}`;
    }

    return '';
  }

  /**
   * Extract the opaque job-URL token used as the ATS id, e.g. `DJQJDUk1` from
   * `https://cr14.teamdash.com/p/job/DJQJDUk1/full-stack-developer`.
   * Falls back to the last meaningful path segment.
   */
  private extractAtsId(jobUrl: string): string {
    try {
      const u = new URL(jobUrl);
      const segments = u.pathname.split('/').filter(Boolean);
      const jobIdx = segments.indexOf('job');
      if (jobIdx >= 0 && segments[jobIdx + 1]) {
        return segments[jobIdx + 1];
      }
      return segments[segments.length - 1] ?? '';
    } catch {
      return '';
    }
  }

  /**
   * Derive a human-readable company name from the context `instance_name`,
   * the `companySlug`, or the career-page host.
   */
  private deriveCompanyName(
    ctx: TeamdashContext,
    companySlug: string | undefined,
    careerUrl: string,
  ): string {
    const candidate =
      this.cleanText(ctx.instance_name) ??
      (companySlug && companySlug.trim() ? companySlug.trim() : undefined) ??
      this.hostLabel(careerUrl);
    return (candidate ?? 'Teamdash Employer')
      .replace(/[-_.]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** First sub-domain label of a URL host, ignoring `www`. */
  private hostLabel(url: string): string | undefined {
    try {
      const u = new URL(url);
      const labels = u.hostname.split('.').filter(Boolean);
      const label = labels[0];
      if (label && label !== 'www') return label;
    } catch {
      // ignore
    }
    return undefined;
  }

  /**
   * Extract a `LocationDto` from the free-text `location` field.
   * Splits on commas to derive city, region/state, and country.
   */
  private extractLocation(item: TeamdashFeedItem): LocationDto | null {
    const label = this.cleanText(item.location);
    if (!label) return null;
    const parts = label
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    const city = parts[0];
    const state = parts.length >= 3 ? parts[1] : null;
    const country = parts[parts.length - 1];
    return new LocationDto({
      city: city ?? null,
      state: state ?? null,
      country: country ?? null,
    });
  }

  /**
   * Detect remote roles from the location label, title, or description text.
   * Teamdash has no dedicated remote flag on the public feed.
   */
  private detectRemote(
    item: TeamdashFeedItem,
    title: string,
    description: string | null,
  ): boolean {
    const haystacks = [item.location, title, description];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('work from home') ||
        v.includes('wfh') ||
        v.includes('kaugtöö') // Estonian for "remote work"
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Parse an ISO-8601 timestamp (e.g. `"2025-01-21T11:46:41.000000Z"`) into a
   * `YYYY-MM-DD` string. Returns null for null/undefined or unparseable input.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      // JS Date does not accept 6-digit fractional seconds; trim to 3.
      const normalised = value.trim().replace(/(\.\d{3})\d+/, '$1');
      const parsed = new Date(normalised);
      if (!isNaN(parsed.getTime())) return toDateOnly(normalised);
    } catch {
      // ignore
    }
    return null;
  }

  /** Trim a nullable string to a non-empty value, or undefined. */
  private cleanText(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const v = value.trim();
    return v.length > 0 ? v : undefined;
  }
}
