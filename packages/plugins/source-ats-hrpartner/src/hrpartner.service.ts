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
  HRPARTNER_ROOT_DOMAIN,
  HRPARTNER_CAREER_HOST_SUFFIX,
  HRPARTNER_INDEX_PATHS,
  HRPARTNER_JOB_PATH,
  HRPARTNER_DEFAULT_RESULTS,
  HRPARTNER_MAX_PAGES,
  HRPARTNER_DEFAULT_TIMEOUT_SECONDS,
  HRPARTNER_HEADERS,
  HRPARTNER_CARD_REGEX,
  HRPARTNER_TITLE_LINK_REGEX,
  HRPARTNER_HREF_REGEX,
  HRPARTNER_SUMMARY_REGEX,
  HRPARTNER_TAG_REGEX,
  HRPARTNER_H1_REGEX,
  HRPARTNER_OG_TITLE_REGEX,
  HRPARTNER_TITLE_REGEX,
  HRPARTNER_GENERIC_TITLES,
  HRPARTNER_REMOTE_REGEX,
  hrpartnerCareerOrigin,
} from './hrpartner.constants';
import { HrPartnerJob, HrPartnerJobItem } from './hrpartner.types';

/**
 * HR Partner ATS careers scraper — generic, multi-tenant.
 *
 * HR Partner (hrpartner.io — an Australia-headquartered, globally-used HR + recruitment
 * suite for SMBs) gives each customer a branded, public, unauthenticated candidate-facing
 * job board on the shared host `https://{tenant}.hrpartner.io/jobs`. The board is a
 * server-rendered HTML page (Tailwind + Alpine.js progressive enhancement — there is no
 * SPA, no `__NEXT_DATA__` data island, and no public JSON API): every open role is emitted
 * directly in the markup as a `.job-listing` card. The adapter parses each card — rather
 * than depending on a client-rendered DOM, a headless browser, or an authenticated REST
 * API. Each card carries a title link `<a href="/jobs/{slug}"><h3>{title}</h3></a>` (the
 * slug is the stable ATS id and the canonical detail / apply URL segment `/jobs/{slug}`),
 * a free-text `job-content` summary, and a row of `rounded-full` pill tags (first =
 * location, rest = category / department). The tenant's display brand is the board `<h1>`
 * (mirrored in `<title>` / `og:title`).
 *
 * The caller addresses a tenant by `companySlug` (e.g. `employmentoptions`) or by
 * `companyUrl` (a board URL whose host encodes the tenant slug). An unknown tenant resolves
 * to the host's catch-all empty board (HTTP 200 with no role cards) and degrades naturally
 * to an empty result. A fetch error, an HTTP 4xx, a DNS failure, or a malformed body
 * degrades to an empty / partial result rather than throwing, so a single tenant never
 * nukes a batch run.
 */
@SourcePlugin({
  site: Site.HRPARTNER,
  name: 'HR Partner',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HrPartnerService implements IScraper {
  private readonly logger = new Logger(HrPartnerService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for HR Partner scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve an HR Partner tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive HR Partner board host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH keys:
    // the no-proxy path keys off `timeout`, the proxy path off `requestTimeout`. A caller
    // may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? HRPARTNER_DEFAULT_TIMEOUT_SECONDS,
      HRPARTNER_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(HRPARTNER_HEADERS);

    const resultsWanted = input.resultsWanted ?? HRPARTNER_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching HR Partner jobs for tenant: ${tenant}`);

      const found = await this.fetchJobs(client, tenant);
      if (!found) {
        this.logger.log(`HR Partner tenant "${tenant}" has no reachable board`);
        return new JobResponseDto([]);
      }

      const { jobs, companyName } = found;
      if (jobs.length === 0) {
        this.logger.log(`HR Partner tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const item of jobs) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processItem(item, tenant, companyName, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing HR Partner role ${item?.slug}: ${err.message}`);
        }
      }

      this.logger.log(`HR Partner total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`HR Partner scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Probe the tenant's server-rendered board across the known path variants until one
   * emits role cards. Returns the parsed roles and the tenant's display brand name (from
   * the board `<h1>` / `og:title` / `<title>`), or null when none respond.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<{ jobs: HrPartnerJobItem[]; companyName: string } | null> {
    const origin = hrpartnerCareerOrigin(tenant);
    let attempts = 0;
    let lastBrand = '';

    for (const path of HRPARTNER_INDEX_PATHS) {
      if (attempts >= HRPARTNER_MAX_PAGES) break;
      attempts++;

      const url = path ? `${origin}/${path}` : `${origin}/`;
      const { data: html, hostReachable } = await this.fetchHtml(client, url, tenant);
      // A transport-level failure (DNS / refused / reset / timeout) means the tenant host
      // itself is unreachable — no other path can succeed, so abort the whole probe sweep
      // rather than burning a full timeout per combo.
      if (!hostReachable) return null;
      if (html == null) continue;

      const brand = this.deriveCompanyName(html);
      if (brand) lastBrand = brand;

      const jobs = this.extractJobs(html, origin);
      // A board exposing role cards is the right surface; return its roles. An empty board
      // (catch-all / unknown tenant / no open roles) yields no cards — keep probing the
      // remaining path variants in case another path fronts the listings, then fall through
      // to a valid empty result.
      if (jobs.length > 0) {
        return { jobs, companyName: brand || lastBrand };
      }
    }

    // No path yielded role cards — a valid "no open roles" result (empty board / unknown
    // tenant catch-all). Return an empty set rather than null so the caller logs it as an
    // empty board, not an unreachable host.
    return { jobs: [], companyName: lastBrand };
  }

  /**
   * GET a board URL as text. Returns `{ data, hostReachable }`:
   *  - `data` is the body, or null when the response carried no usable text / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the tenant host itself is unreachable and the
   *    caller should stop probing further path variations.
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
        // The host answered an HTTP status (4xx path-not-found / 5xx) — it is reachable,
        // so the caller may still try other path variations.
        this.logger.warn(`HR Partner board returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`HR Partner board fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Extract the open-roles set from the server-rendered board HTML. Each role is emitted
   * as a `.job-listing` card carrying a `/jobs/{slug}` title link, a `job-content` summary,
   * and `rounded-full` location / category pills. Returns the parsed cards (possibly empty
   * — an empty board is a valid "no roles" result).
   */
  private extractJobs(html: string, origin: string): HrPartnerJobItem[] {
    const items: HrPartnerJobItem[] = [];
    HRPARTNER_CARD_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HRPARTNER_CARD_REGEX.exec(html)) !== null) {
      const card = match[1];
      if (!card) continue;
      const item = this.parseCard(card);
      if (item) items.push(item);
    }
    return items;
  }

  /**
   * Parse a single `.job-listing` card's inner HTML into a HrPartnerJobItem. Reads the
   * `/jobs/{slug}` title link (slug + title), the `job-content` summary, and the
   * `rounded-full` pill tags (first = location, rest = category). Returns null when no
   * role href is present (not a real role card).
   */
  private parseCard(card: string): HrPartnerJobItem | null {
    let href: string | null = null;
    let title: string | null = null;

    HRPARTNER_TITLE_LINK_REGEX.lastIndex = 0;
    const titleLink = HRPARTNER_TITLE_LINK_REGEX.exec(card);
    if (titleLink) {
      href = titleLink[1] ?? null;
      title = this.cleanText(this.stripTags(titleLink[2]));
    } else {
      // Title-link shape drifted — fall back to any role href on the card.
      HRPARTNER_HREF_REGEX.lastIndex = 0;
      const hrefOnly = HRPARTNER_HREF_REGEX.exec(card);
      href = hrefOnly ? hrefOnly[1] ?? null : null;
    }

    if (!href) return null;
    const slug = this.slugFromHref(href);
    if (!slug) return null;

    let summaryHtml: string | null = null;
    HRPARTNER_SUMMARY_REGEX.lastIndex = 0;
    const summary = HRPARTNER_SUMMARY_REGEX.exec(card);
    if (summary) summaryHtml = this.cleanText(summary[1]);

    const tags = this.parseTags(card);

    return {
      slug,
      href,
      title,
      summaryHtml,
      location: tags.length > 0 ? tags[0] : null,
      category: tags.length > 1 ? tags.slice(1).join(', ') : null,
    };
  }

  /** Collect the `rounded-full` pill tag texts from a card (first = location, rest = category). */
  private parseTags(card: string): string[] {
    const tags: string[] = [];
    HRPARTNER_TAG_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HRPARTNER_TAG_REGEX.exec(card)) !== null) {
      const text = this.cleanText(this.stripTags(match[1]));
      if (text) tags.push(text);
    }
    return tags;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: HrPartnerJobItem,
    tenant: string,
    brandName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, tenant, brandName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised HrPartnerJob from a parsed role. */
  private normaliseItem(item: HrPartnerJobItem, tenant: string, brandName: string): HrPartnerJob | null {
    const atsId = this.cleanText(item.slug);
    if (!atsId) return null;

    const url = this.buildJobUrl(tenant, atsId);
    const title = this.cleanText(item.title);
    const locationText = this.cleanText(item.location);
    const department = this.cleanText(item.category);

    return {
      atsId,
      url,
      // The HR Partner detail page hosts the apply flow inline; the canonical apply URL is
      // the detail URL itself.
      applyUrl: url,
      title,
      companyName: brandName || this.deriveSlugName(tenant),
      locationText,
      descriptionHtml: this.cleanText(item.summaryHtml),
      department,
      isRemote: this.detectRemote(title, locationText, department),
    };
  }

  /** Map a normalised HrPartnerJob → JobPostDto. */
  private processJob(job: HrPartnerJob, tenant: string, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveSlugName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `hrpartner-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.HRPARTNER,
      atsId,
      atsType: 'hrpartner',
      department: job.department ?? null,
      employmentType: null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role summary body per `descriptionFormat`. HR Partner board cards expose
   * the summary as HTML when present, so HTML returns it as-is, Markdown converts it, and
   * Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare board URL
   * passed as the slug is reduced to its tenant token); a `companyUrl` on a `hrpartner.io`
   * host has the tenant taken from its leading sub-domain label. Returns an empty string
   * when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full board URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(HRPARTNER_ROOT_DOMAIN)) {
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
   * Derive the tenant token from an HR Partner board URL. The candidate-facing host is
   * `{tenant}.hrpartner.io`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(HRPARTNER_CAREER_HOST_SUFFIX)) {
        // Not a hosted board host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - HRPARTNER_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` / `workplace` / `help` label (non-tenant hosts).
      if (!label || label === 'www' || label === 'workplace' || label === 'help') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Assemble the canonical `{origin}/jobs/{slug}` public detail URL for a role. */
  private buildJobUrl(tenant: string, slug: string): string {
    const origin = hrpartnerCareerOrigin(tenant);
    return `${origin}/${HRPARTNER_JOB_PATH}/${slug}`;
  }

  /** Reduce a `/jobs/{slug}` href to its trailing slug segment. */
  private slugFromHref(href: string): string | null {
    const cleaned = this.cleanText(href);
    if (!cleaned) return null;
    // Strip any query / fragment, then take the final non-empty path segment.
    const noQuery = cleaned.split(/[?#]/)[0];
    const segments = noQuery.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return null;
    const slug = segments[segments.length - 1];
    // Guard against the bare board path (`/jobs`) being mistaken for a role slug.
    if (slug.toLowerCase() === HRPARTNER_JOB_PATH) return null;
    return slug;
  }

  /**
   * Derive the tenant brand name from the board HTML: prefer the `<h1>`, then `og:title`,
   * then the `<title>` (`{Company} | Job Board`), ignoring HR Partner's generic catch-all
   * titles. Returns an empty string when nothing usable is present.
   */
  private deriveCompanyName(html: string): string {
    HRPARTNER_H1_REGEX.lastIndex = 0;
    const h1 = HRPARTNER_H1_REGEX.exec(html);
    const h1Text = h1 ? this.cleanText(this.stripTags(h1[1])) : null;
    if (h1Text && !this.isGenericTitle(h1Text)) return h1Text;

    HRPARTNER_OG_TITLE_REGEX.lastIndex = 0;
    const og = HRPARTNER_OG_TITLE_REGEX.exec(html);
    const ogText = og ? this.cleanText(og[1] ?? og[2]) : null;
    if (ogText && !this.isGenericTitle(ogText)) return ogText;

    HRPARTNER_TITLE_REGEX.lastIndex = 0;
    const title = HRPARTNER_TITLE_REGEX.exec(html);
    const titleText = title ? this.cleanText(this.stripTags(title[1])) : null;
    if (titleText && !this.isGenericTitle(titleText)) {
      // `{Company} | Job Board` → take the leading segment as the brand.
      const lead = this.cleanText(titleText.split('|')[0]);
      if (lead && !this.isGenericTitle(lead)) return lead;
    }
    return '';
  }

  /** True when a candidate brand string is one of HR Partner's generic catch-all titles. */
  private isGenericTitle(value: string): boolean {
    const v = value.trim().toLowerCase();
    return HRPARTNER_GENERIC_TITLES.includes(v);
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location as a LocationDto, leaving location null when nothing
   * usable is present. HR Partner pills are a single free-text location line (e.g.
   * `Adelaide, South Australia, Australia`); the trailing comma-separated part is taken as
   * the country, the leading part as the city, and any middle part as the state.
   */
  private extractLocation(job: HrPartnerJob): LocationDto | null {
    const text = job.locationText;
    if (!text) return null;
    const parts = text
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length === 0) return null;
    let city: string | null = null;
    let state: string | null = null;
    let country: string | null = null;
    if (parts.length === 1) {
      city = parts[0];
    } else if (parts.length === 2) {
      city = parts[0];
      country = parts[1];
    } else {
      city = parts[0];
      country = parts[parts.length - 1];
      state = parts.slice(1, parts.length - 1).join(', ');
    }
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the title, location, or category text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (HRPARTNER_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Strip HTML tags from a fragment, collapsing whitespace. */
  private stripTags(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const text = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    return text.trim().length > 0 ? text.trim() : null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
