import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  DescriptionFormat,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
  classifyScrapeError,
  looksLikeChallenge,
} from '@ever-jobs/models';
import {
  BrowserPool,
  extractEmails,
  htmlToPlainText,
  jobPostingLdToCompensation,
  markdownConverter,
  parseJobPostingLd,
  parseLocationList,
  toDateOnly,
} from '@ever-jobs/common';
import {
  GUSTO_HOSTED_BOARD_READY_SELECTOR,
  GUSTO_HOSTED_DEFAULT_RESULTS,
  GUSTO_HOSTED_DEFAULT_TIMEOUT_SECONDS,
  GUSTO_HOSTED_READY_TIMEOUT_SECONDS,
  GUSTO_HOSTED_DETAIL_CONCURRENCY,
  GUSTO_HOSTED_MAX_DETAIL_FETCHES,
  GUSTO_HOSTED_ORIGIN,
  GUSTO_HOSTED_POSTING_LINK_RE,
  GUSTO_HOSTED_REMOTE_REGEX,
  GUSTO_HOSTED_UUID_SUFFIX_RE,
  gustoHostedBoardUrl,
  gustoHostedPostingUrl,
} from './gusto-hosted.constants';
import { GustoHostedDetailData, GustoHostedListItem } from './gusto-hosted.types';

/**
 * Gusto-hosted multi-tenant job-board scraper.
 *
 * Scrapes the per-company boards Gusto HOSTS at `https://jobs.gusto.com` — NOT
 * Gusto, Inc.'s own careers (that is `source-company-gusto`, a single employer
 * on Greenhouse). Every tenant is addressable by its board slug
 * (`<company>-<uuid>`), so this plugin's output is keyed on the input slug — two
 * different slugs yield two different boards (the correctness contract the
 * vendor company plugin violated by hardcoding one board; see Spec 5054).
 *
 * Flow:
 *   board  GET /boards/{slug}          → enumerate /postings/{postingSlug} links
 *   detail GET /postings/{postingSlug} → parseJobPostingLd (Spec 5022) for
 *                                        title/description/date/location/salary
 *
 * Both pages sit behind a Cloudflare managed challenge, so they are loaded with
 * the shared stealth headless browser (`BrowserPool`), the same approach as
 * `source-company-desktopmetal`. The fetch methods are isolated (protected) so
 * tests can substitute captured HTML without a browser.
 */
@SourcePlugin({
  site: Site.GUSTO_HOSTED,
  name: 'Gusto (hosted boards)',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class GustoHostedService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(GustoHostedService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn(
        'No companySlug or companyUrl provided for Gusto-hosted scraper',
      );
      return new JobResponseDto([], {
        reason: 'bad_input',
        detail: 'no companySlug or companyUrl provided',
      });
    }

    const slug = this.resolveTenant(input.companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a Gusto-hosted board slug from input');
      return new JobResponseDto([], {
        reason: 'bad_input',
        detail: 'could not resolve a board slug from companySlug/companyUrl',
      });
    }

    const resultsWanted = input.resultsWanted ?? GUSTO_HOSTED_DEFAULT_RESULTS;

    try {
      this.logger.log(`Fetching Gusto-hosted board for tenant: ${slug}`);

      const boardHtml = await this.fetchBoardHtml(slug, input);
      const items = this.parseBoard(boardHtml);
      if (items.length === 0) {
        if (looksLikeChallenge(boardHtml)) {
          this.logger.warn(`Gusto-hosted board "${slug}" served a bot challenge`);
          return new JobResponseDto([], {
            reason: 'blocked',
            detail: 'board response looks like a bot challenge',
          });
        }
        this.logger.log(`Gusto-hosted board "${slug}" has no postings`);
        return new JobResponseDto([], { reason: 'empty' });
      }

      const wanted = Math.min(resultsWanted, GUSTO_HOSTED_MAX_DETAIL_FETCHES);
      const selected = items.slice(0, wanted);

      const detailMap = await this.fetchDetails(selected, input);

      const companyFallback = this.deriveCompanyName(slug);
      const jobPosts: JobPostDto[] = [];

      for (const item of selected) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const detail = detailMap.get(item.postingSlug) ?? null;
          jobPosts.push(
            this.toJobPost(
              item,
              companyFallback,
              detail,
              input.descriptionFormat,
            ),
          );
        } catch (err: unknown) {
          this.logger.warn(
            `Error processing Gusto-hosted posting ${item.postingSlug}: ${this.errorLabel(err)}`,
          );
        }
      }

      this.logger.log(`Gusto-hosted total: ${jobPosts.length} jobs for ${slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: unknown) {
      const diagnostics = classifyScrapeError(err);
      this.logger.error(
        `Gusto-hosted scrape failed for ${slug} [${diagnostics.reason}]: ${diagnostics.detail ?? this.errorLabel(err)}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close().catch(() => undefined);
  }

  /**
   * Load the tenant board HTML through a stealth headless browser (the page is
   * Cloudflare-challenged). Isolated so tests can substitute captured HTML.
   */
  protected async fetchBoardHtml(
    slug: string,
    input: ScraperInputDto,
  ): Promise<string> {
    return this.fetchRenderedHtml(gustoHostedBoardUrl(slug), input, {
      waitForSelector: GUSTO_HOSTED_BOARD_READY_SELECTOR,
    });
  }

  /**
   * Load a posting detail HTML through a stealth headless browser. Isolated so
   * tests can substitute captured HTML.
   */
  protected async fetchPostingHtml(
    postingSlug: string,
    input: ScraperInputDto,
  ): Promise<string> {
    // Gate on `h1` (present immediately), NOT the JSON-LD block — Gusto posting
    // pages carry no `application/ld+json`, so waiting for it burned the full
    // navigation timeout on every detail fetch. `parseDetail` still tries JSON-LD
    // first and falls back to the rendered HTML, so output is unchanged.
    return this.fetchRenderedHtml(gustoHostedPostingUrl(postingSlug), input, {
      waitForSelector: 'h1',
    });
  }

  /** Shared stealth-browser navigation → rendered HTML. */
  private async fetchRenderedHtml(
    url: string,
    input: ScraperInputDto,
    opts: { waitForSelector?: string },
  ): Promise<string> {
    const proxy = input.proxies?.[0];
    const timeoutMs =
      (input.requestTimeout ?? GUSTO_HOSTED_DEFAULT_TIMEOUT_SECONDS) * 1000;
    const readyMs = GUSTO_HOSTED_READY_TIMEOUT_SECONDS * 1000;
    const page = await BrowserPool.getPage({ proxy, stealth: true, headful: true });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      if (opts.waitForSelector) {
        await page
          .waitForSelector(opts.waitForSelector, { timeout: readyMs })
          .catch(() => undefined);
      }
      return await page.content();
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Enumerate postings from the board HTML: every `/postings/{postingSlug}`
   * anchor, de-duped by posting slug (first occurrence wins).
   */
  private parseBoard(html: string): GustoHostedListItem[] {
    const $ = cheerio.load(html);

    const items: GustoHostedListItem[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      const match = GUSTO_HOSTED_POSTING_LINK_RE.exec(href);
      if (!match) return;

      const postingSlug = this.cleanPostingSlug(match[1]);
      if (!postingSlug || seen.has(postingSlug)) return;
      seen.add(postingSlug);

      const headingText = this.cleanText(
        $(el).find('h1, h2, h3, h4, h5, h6').first().text(),
      );
      const anchorText = this.cleanText($(el).text());
      items.push({
        postingSlug,
        title:
          headingText ??
          anchorText ??
          this.deriveTitle(postingSlug),
        jobUrl: gustoHostedPostingUrl(postingSlug),
      });
    });

    return items;
  }

  /**
   * Fan out to posting detail pages in bounded batches, extracting the JSON-LD
   * `JobPosting` fields. A failed/missing page just omits detail for that role.
   */
  private async fetchDetails(
    items: GustoHostedListItem[],
    input: ScraperInputDto,
  ): Promise<Map<string, GustoHostedDetailData>> {
    const result = new Map<string, GustoHostedDetailData>();

    for (let i = 0; i < items.length; i += GUSTO_HOSTED_DETAIL_CONCURRENCY) {
      const batch = items.slice(i, i + GUSTO_HOSTED_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (item) => {
          const html = await this.fetchPostingHtml(item.postingSlug, input);
          return {
            postingSlug: item.postingSlug,
            data: html ? this.parseDetail(html) : null,
          };
        }),
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value.data) {
          result.set(r.value.postingSlug, r.value.data);
        }
      }
    }

    return result;
  }

  /** Extract posting details from JSON-LD, falling back to rendered HTML. */
  private parseDetail(html: string): GustoHostedDetailData | null {
    const posting = parseJobPostingLd(html)[0];
    if (posting) {
      const loc = posting.locations[0] ?? null;
      return {
        title: posting.title,
        descriptionHtml: posting.description,
        datePosted: posting.datePosted,
        employmentType: posting.employmentType,
        hiringOrganizationName: posting.hiringOrganizationName,
        isRemote: posting.remote,
        city: loc?.city ?? null,
        state: loc?.region ?? null,
        country: loc?.country ?? null,
        compensation: jobPostingLdToCompensation(posting.baseSalary),
        workFromHomeType: null,
      };
    }
    return this.parseDetailFromHtml(html);
  }

  /** Parse a rendered Gusto posting page when JSON-LD is absent. */
  private parseDetailFromHtml(html: string): GustoHostedDetailData | null {
    const $ = cheerio.load(html);
    const h1 = $('h1').first();
    if (!h1.length) return null;

    const companyName = this.cleanText(
      h1.find('[class*="text-indigo-600"]').first().text(),
    );
    const title =
      this.cleanText(h1.find('[class*="text-3xl"]').first().text()) ??
      this.cleanText($('title').text()?.split(' at ')[0]);

    const metaSpan = h1
      .find('span')
      .filter((_, el) => $(el).text().includes('·'))
      .first();

    let employmentType: string | null = null;
    const locationTexts: string[] = [];
    const metaHtml = metaSpan.html();
    if (metaHtml) {
      const [locationHtml, employmentHtml] = metaHtml.split('·');
      if (employmentHtml) {
        employmentType = this.cleanText(
          employmentHtml.replace(/<[^>]+>/g, ' '),
        );
      }
      if (locationHtml) {
        const parts = locationHtml
          .split(/<br\s*\/?>/i)
          .map((part) => this.cleanText(part.replace(/<[^>]+>/g, ' ')))
          .filter((part): part is string => !!part);
        locationTexts.push(...parts);
      }
    }

    const parsedLocations = parseLocationList(locationTexts);
    const location = parsedLocations.location;

    const descriptionHtml = this.extractDescriptionHtml($);

    const isRemote =
      parsedLocations.remoteMentioned ||
      GUSTO_HOSTED_REMOTE_REGEX.test(title ?? '') ||
      GUSTO_HOSTED_REMOTE_REGEX.test(descriptionHtml ?? '');

    return {
      title,
      descriptionHtml,
      datePosted: null,
      employmentType,
      hiringOrganizationName: companyName,
      isRemote,
      city: location?.city ?? null,
      state: location?.state ?? null,
      country: location?.country ?? null,
      compensation: null,
      workFromHomeType: parsedLocations.workFromHomeType ?? null,
    };
  }

  /** Find the job-description rich-text container on a Gusto posting page. */
  private extractDescriptionHtml($: cheerio.CheerioAPI): string | null {
    const headingEl = $('h1, h2, h3, h4, h5, h6')
      .toArray()
      .find((el) => /Description|About the Role|Role overview/i.test($(el).text().trim()));
    if (headingEl) {
      const container = $(headingEl)
        .next('[data-controller="rich-text"]')
        .find('.rich-text-container')
        .first();
      if (container.length) return container.html() ?? null;
    }
    const fallback = $('.rich-text-container').first();
    return fallback.length ? (fallback.html() ?? null) : null;
  }

  /** Map a board item + detail data → JobPostDto. */
  private toJobPost(
    item: GustoHostedListItem,
    companyName: string,
    detail: GustoHostedDetailData | null,
    format: DescriptionFormat | undefined,
  ): JobPostDto {
    const title = detail?.title ?? item.title;
    const isRemote =
      (detail?.isRemote ?? false) ||
      GUSTO_HOSTED_REMOTE_REGEX.test(title) ||
      GUSTO_HOSTED_REMOTE_REGEX.test(item.title);

    const employmentType = detail?.employmentType ?? null;
    // schema.org employmentType is underscore-cased (e.g. `FULL_TIME`);
    // getJobTypeFromString strips spaces/hyphens but not underscores.
    const jobType = employmentType
      ? getJobTypeFromString(employmentType.replace(/_/g, ' '))
      : null;

    return new JobPostDto({
      id: `gusto-hosted-${item.postingSlug}`,
      title,
      companyName: detail?.hiringOrganizationName ?? companyName,
      jobUrl: item.jobUrl,
      location: this.buildLocation(detail, isRemote),
      description: this.formatDescription(detail?.descriptionHtml ?? null, format),
      datePosted: detail?.datePosted ? toDateOnly(detail.datePosted) : null,
      isRemote,
      emails: extractEmails(detail?.descriptionHtml ?? ''),
      site: Site.GUSTO_HOSTED,
      atsId: item.postingSlug,
      atsType: 'gusto-hosted',
      employmentType,
      ...(jobType ? { jobType: [jobType] } : {}),
      compensation: detail?.compensation ?? null,
      applyUrl: item.jobUrl,
      workFromHomeType: detail?.workFromHomeType ?? null,
    });
  }

  /** Structured location from detail JSON-LD, bare Remote marker as fallback. */
  private buildLocation(
    detail: GustoHostedDetailData | null,
    isRemote: boolean,
  ): LocationDto | null {
    if (detail && (detail.city || detail.state || detail.country)) {
      return new LocationDto({
        city: detail.city,
        state: detail.state,
        country: detail.country,
      });
    }
    return isRemote ? new LocationDto({ city: 'Remote' }) : null;
  }

  /** Convert the HTML job-ad body per `descriptionFormat`. */
  private formatDescription(
    html: string | null,
    format?: DescriptionFormat,
  ): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the board slug from `companySlug` or `companyUrl`. Accepts a bare
   * slug (`<company>-<uuid>`) or any `jobs.gusto.com/boards/{slug}` URL.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    const slug = companySlug?.trim();
    if (slug) {
      if (/^https?:\/\//i.test(slug) || slug.includes('gusto.com')) {
        const fromUrl = this.slugFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.replace(/^\/+|\/+$/g, '');
    }
    if (companyUrl) {
      const fromUrl = this.slugFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /** Extract the board slug from a `jobs.gusto.com/boards/{slug}` URL. */
  private slugFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      if (!/(^|\.)gusto\.com$/i.test(u.hostname)) return '';
      const parts = u.pathname.split('/').filter(Boolean);
      const anchor = parts.indexOf('boards');
      if (anchor !== -1 && parts[anchor + 1]) {
        return decodeURIComponent(parts[anchor + 1]);
      }
      // a /postings/{slug} URL cannot name a board — ignore.
      return '';
    } catch {
      return '';
    }
  }

  /** Strip a trailing `/applicants/new` etc. from a captured posting slug. */
  private cleanPostingSlug(raw: string): string {
    return decodeURIComponent(raw).replace(/^\/+|\/+$/g, '').split('/')[0] ?? '';
  }

  /** De-slugify a board slug (minus its UUID) into a display company name. */
  private deriveCompanyName(slug: string): string {
    return this.deriveTitle(slug.replace(GUSTO_HOSTED_UUID_SUFFIX_RE, ''));
  }

  /** De-slugify + title-case a token (drops a trailing UUID first). */
  private deriveTitle(token: string): string {
    return token
      .replace(GUSTO_HOSTED_UUID_SUFFIX_RE, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Trim + collapse whitespace; null for empty. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.replace(/\s+/g, ' ').trim();
    return v.length > 0 ? v : null;
  }

  private errorLabel(error: unknown): string {
    if (!error || typeof error !== 'object') return 'unknown error';
    const status = (error as { response?: { status?: unknown } }).response
      ?.status;
    if (typeof status === 'number') return `HTTP ${status}`;
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : 'request error';
  }
}
