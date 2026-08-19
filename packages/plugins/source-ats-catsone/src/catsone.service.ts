import * as cheerio from 'cheerio';
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
  randomSleep,
} from '@ever-jobs/common';
import {
  CATSONE_HOST_TEMPLATE,
  CATSONE_ROOT_CAREERS_PATH,
  CATSONE_PORTAL_PATH_RE,
  CATSONE_JOB_PATH_RE,
  CATSONE_PAGE_SIZE,
  CATSONE_MAX_LISTING_PAGES,
  CATSONE_DETAIL_CONCURRENCY,
  CATSONE_REQUEST_DELAY_MS,
  CATSONE_DEFAULT_RESULTS,
  CATSONE_HEADERS,
} from './catsone.constants';
import { CatsoneJobStub, CatsoneJobDetail, CatsoneTenantContext } from './catsone.types';

/**
 * CATS (catsone.com) hosted recruiting portal scraper — generic, multi-tenant.
 *
 * CATS powers public career portals for staffing agencies and employers. Each
 * tenant has its own sub-domain under `catsone.com`
 * (e.g. `https://authoritypartnersinc.catsone.com`). All portal pages are
 * server-rendered HTML; there is no anonymous public JSON feed. The
 * authenticated REST API (`/v3/portals/{id}/jobs`) requires a per-tenant
 * secret token and is deliberately not used.
 *
 * The adapter:
 *  1. Resolves the tenant host from `companySlug` or `companyUrl`.
 *  2. Discovers the portal listing path from the tenant root (`/careers/`), or
 *     uses the path embedded in `companyUrl` when it already points at a portal.
 *  3. Pages the portal listing (`?page=N`) to collect job stubs from the
 *     `.cats-job` HTML elements — bounded by `resultsWanted`.
 *  4. Fans out per-job detail requests (bounded concurrency via
 *     `Promise.allSettled`) to fetch the HTML description from each job page.
 *  5. Maps each enriched stub to `JobPostDto` and returns a `JobResponseDto`.
 *
 * A fetch error at any level degrades to partial/empty results — never throws.
 */
@SourcePlugin({
  site: Site.CATSONE,
  name: 'CATS',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class CatsoneService implements IScraper {
  private readonly logger = new Logger(CatsoneService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for CATS scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(input.companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a CATS tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(CATSONE_HEADERS);

    const resultsWanted = input.resultsWanted ?? CATSONE_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const stubs: CatsoneJobStub[] = [];

    try {
      this.logger.log(`Fetching CATS jobs for tenant: ${tenant.host}`);

      // Step 1 — resolve the portal listing path.
      const portalPath = tenant.portalPath ?? (await this.discoverPortalPath(client, tenant.host));
      if (!portalPath) {
        this.logger.warn(`No portal found for CATS tenant: ${tenant.host}`);
        return new JobResponseDto([]);
      }

      // Step 2 — collect job stubs from listing pages.
      for (let page = 1; page <= CATSONE_MAX_LISTING_PAGES; page++) {
        if (stubs.length >= resultsWanted) break;

        const listingUrl =
          page === 1
            ? `${tenant.host}${portalPath}`
            : `${tenant.host}${portalPath}?page=${page}`;

        let html: string;
        try {
          const response = await client.get<string>(listingUrl);
          html =
            typeof response.data === 'string'
              ? response.data
              : String(response.data ?? '');
        } catch (err: any) {
          const status = err?.response?.status;
          if (status === 400 || status === 404) {
            this.logger.warn(`CATS portal not found (HTTP ${status}) at ${listingUrl}`);
          } else {
            this.logger.warn(`CATS listing fetch failed (${listingUrl}): ${err.message}`);
          }
          break;
        }

        const pageStubs = this.parseListingPage(html, tenant.host, seen);
        if (pageStubs.length === 0) break;

        for (const stub of pageStubs) {
          if (stubs.length >= resultsWanted) break;
          stubs.push(stub);
        }

        // A short page signals the final page.
        if (pageStubs.length < CATSONE_PAGE_SIZE) break;

        if (page < CATSONE_MAX_LISTING_PAGES) {
          await randomSleep(CATSONE_REQUEST_DELAY_MS, CATSONE_REQUEST_DELAY_MS * 2);
        }
      }

      if (stubs.length === 0) {
        this.logger.log(`CATS: no jobs found for ${tenant.companyName}`);
        return new JobResponseDto([]);
      }

      // Step 3 — fan out description fetches when caller wants descriptions.
      const wantsDescription = input.descriptionFormat !== undefined;
      const details = wantsDescription
        ? await this.fetchDescriptions(client, stubs)
        : stubs.map((s) => ({ ...s, descriptionHtml: null } as CatsoneJobDetail));

      // Step 4 — map to JobPostDto.
      const jobPosts: JobPostDto[] = [];
      for (const detail of details) {
        try {
          const post = this.processJob(detail, tenant.companyName, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing CATS job ${detail.atsId}: ${err.message}`);
        }
      }

      this.logger.log(`CATS total: ${jobPosts.length} jobs for ${tenant.companyName}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted));
    } catch (err: any) {
      this.logger.error(`CATS scrape error for ${tenant.host}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Fetch the tenant root `/careers/` page and extract the first portal path.
   * Returns `null` when no portal link is found.
   */
  private async discoverPortalPath(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<string | null> {
    const rootUrl = `${host}${CATSONE_ROOT_CAREERS_PATH}`;
    try {
      const response = await client.get<string>(rootUrl);
      const html =
        typeof response.data === 'string'
          ? response.data
          : String(response.data ?? '');
      return this.extractPortalPath(html) ?? null;
    } catch (err: any) {
      this.logger.warn(`CATS root careers fetch failed (${rootUrl}): ${err.message}`);
      return null;
    }
  }

  /**
   * Extract the first portal listing path from a CATS root careers page HTML.
   * Portal links follow the pattern `/careers/{portalID}-{name}` and do NOT
   * contain `/jobs/` (those are direct job links, not portal pages).
   */
  private extractPortalPath(html: string): string | null {
    const $ = cheerio.load(html);
    let found: string | null = null;
    $('a[href]').each((_i, el) => {
      if (found) return;
      const href = $(el).attr('href') ?? '';
      const match = href.match(CATSONE_PORTAL_PATH_RE);
      if (match && !href.includes('/jobs/')) {
        // href may be relative or absolute — normalise to the path only.
        try {
          const u = new URL(href, 'https://x.catsone.com');
          found = u.pathname;
        } catch {
          found = href.split('?')[0];
        }
      }
    });
    return found;
  }

  /**
   * Parse one portal listing page and return job stubs.
   * De-duplicates by `atsId` against `seen`.
   */
  private parseListingPage(
    html: string,
    host: string,
    seen: Set<string>,
  ): CatsoneJobStub[] {
    const $ = cheerio.load(html);
    const stubs: CatsoneJobStub[] = [];

    // Primary selector: `.cats-job` elements (documented widget class names).
    let jobElements = $('.cats-job');

    // Fallback: table rows that contain a job link via the `/jobs/` path pattern.
    if (jobElements.length === 0) {
      const rows: any[] = [];
      $('tr, li').each((_i, el) => {
        if ($(el).find('a[href*="/jobs/"]').length > 0) rows.push(el);
      });
      jobElements = $(rows as any);
    }

    // Second fallback: any anchor whose href contains `/jobs/`.
    if (jobElements.length === 0) {
      $('a[href*="/jobs/"]').each((_i, el) => {
        const href = $(el).attr('href') ?? '';
        const idMatch = href.match(CATSONE_JOB_PATH_RE);
        if (!idMatch) return;
        const atsId = idMatch[1];
        if (seen.has(atsId)) return;
        seen.add(atsId);
        const title = $(el).text().trim();
        if (!title) return;
        const jobUrl = href.startsWith('http') ? href : `${host}${href}`;
        stubs.push({ atsId, title, jobUrl, location: null, category: null });
      });
      return stubs;
    }

    jobElements.each((_i, el) => {
      const $el = $(el);

      // Title + URL.
      const $titleLink = $el.find('.cats-job-title a, a').first();
      const href = $titleLink.attr('href') ?? '';
      if (!href) return;

      const idMatch = href.match(CATSONE_JOB_PATH_RE);
      if (!idMatch) return;
      const atsId = idMatch[1];
      if (seen.has(atsId)) return;
      seen.add(atsId);

      const title =
        $el.find('.cats-job-title').first().text().trim() ||
        $titleLink.text().trim();
      if (!title) return;

      const jobUrl = href.startsWith('http') ? href : `${host}${href}`;

      // Location.
      const locationText = $el.find('.cats-job-location').first().text().trim() || null;

      // Category / department.
      const categoryText = $el.find('.cats-job-category').first().text().trim() || null;

      stubs.push({
        atsId,
        title,
        jobUrl,
        location: locationText,
        category: categoryText,
      });
    });

    return stubs;
  }

  /**
   * Fan out per-job detail requests for the description. Uses a bounded
   * `Promise.allSettled` so a single failure never drops other results.
   */
  private async fetchDescriptions(
    client: ReturnType<typeof createHttpClient>,
    stubs: CatsoneJobStub[],
  ): Promise<CatsoneJobDetail[]> {
    const results: CatsoneJobDetail[] = [];

    for (let i = 0; i < stubs.length; i += CATSONE_DETAIL_CONCURRENCY) {
      const chunk = stubs.slice(i, i + CATSONE_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map((stub) => this.fetchJobDetail(client, stub)),
      );
      for (let j = 0; j < settled.length; j++) {
        const outcome = settled[j];
        if (outcome.status === 'fulfilled') {
          results.push(outcome.value);
        } else {
          this.logger.warn(
            `CATS detail fetch failed: ${outcome.reason?.message ?? outcome.reason}`,
          );
          // Push the stub with null description so the job still appears.
          const stub = chunk[j];
          if (stub) results.push({ ...stub, descriptionHtml: null });
        }
      }
      if (i + CATSONE_DETAIL_CONCURRENCY < stubs.length) {
        await randomSleep(CATSONE_REQUEST_DELAY_MS, CATSONE_REQUEST_DELAY_MS * 2);
      }
    }

    return results;
  }

  /** Fetch one job detail page and extract the description HTML. */
  private async fetchJobDetail(
    client: ReturnType<typeof createHttpClient>,
    stub: CatsoneJobStub,
  ): Promise<CatsoneJobDetail> {
    try {
      const response = await client.get<string>(stub.jobUrl);
      const html =
        typeof response.data === 'string'
          ? response.data
          : String(response.data ?? '');
      const descriptionHtml = this.extractDescriptionHtml(html);
      return { ...stub, descriptionHtml };
    } catch (err: any) {
      this.logger.warn(
        `CATS detail fetch error for job ${stub.atsId} (${stub.jobUrl}): ${err.message}`,
      );
      return { ...stub, descriptionHtml: null };
    }
  }

  /**
   * Extract the main job description HTML block from a CATS job detail page.
   *
   * The CATS detail page wraps the description in a container with classes such
   * as `.job-description`, `#job-description`, or `.cats-job-description`.
   * A broad fallback tries common container selectors before giving up.
   */
  private extractDescriptionHtml(html: string): string | null {
    const $ = cheerio.load(html);

    // Try the most specific known CATS selectors first.
    const candidates = [
      '#job-description',
      '.job-description',
      '.cats-job-description',
      '.job-details',
      '.job-detail-description',
      // Generic fallback: the largest `<div>` inside `main` or `article`.
      'main article',
      'article.job-detail',
      '#main-content',
      '.main-content',
    ];

    for (const selector of candidates) {
      const $el = $(selector).first();
      if ($el.length > 0) {
        const inner = $el.html();
        if (inner && inner.trim().length > 50) return inner.trim();
      }
    }

    return null;
  }

  /** Map a fully enriched job stub to the canonical `JobPostDto`. */
  private processJob(
    detail: CatsoneJobDetail,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const { atsId, title, jobUrl, location, category, descriptionHtml } = detail;

    if (!title || !atsId) return null;

    let description: string | null = null;
    if (descriptionHtml) {
      if (format === DescriptionFormat.HTML) {
        description = descriptionHtml;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(descriptionHtml) ?? htmlToPlainText(descriptionHtml);
      } else {
        description = htmlToPlainText(descriptionHtml);
      }
    }

    return new JobPostDto({
      id: `catsone-${atsId}`,
      title,
      companyName: fallbackCompanyName,
      jobUrl,
      location: location ? this.parseLocation(location) : null,
      description,
      datePosted: null,
      isRemote: this.detectRemote(title, location),
      emails: extractEmails(description),
      site: Site.CATSONE,
      atsId,
      atsType: 'catsone',
      department: category,
      applyUrl: jobUrl,
    });
  }

  /**
   * Resolve a `CatsoneTenantContext` from `companySlug` and/or `companyUrl`.
   * Returns `null` when neither provides a usable host.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): CatsoneTenantContext | null {
    // Prefer an explicit URL — it may already carry the portal path.
    if (companyUrl && companyUrl.trim()) {
      try {
        const u = new URL(companyUrl.trim());
        const labels = u.host.split(':')[0].split('.').filter(Boolean);
        const slug = labels[0] && labels[0] !== 'www' ? labels[0] : null;
        if (!slug) return null;

        const host = `${u.protocol}//${u.host}`;
        const companyName = this.deriveCompanyName(slug);

        // If the URL already contains a portal path, extract it.
        const portalMatch = u.pathname.match(CATSONE_PORTAL_PATH_RE);
        const portalPath = portalMatch ? `/${portalMatch[0].replace(/^\//, '')}` : null;
        // Normalise: keep only the portal segment (strip deeper /jobs/... suffix).
        const cleanPortalPath = portalPath
          ? portalPath.replace(/\/jobs\/.+$/, '')
          : null;

        return { host, portalPath: cleanPortalPath, companyName };
      } catch {
        // Malformed URL — fall through to slug.
      }
    }

    const slug = companySlug?.trim();
    if (slug) {
      const host = CATSONE_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
      return { host, portalPath: null, companyName: this.deriveCompanyName(slug) };
    }

    return null;
  }

  /** Derive a human-readable company name from a URL slug. */
  private deriveCompanyName(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse a free-text location label into a `LocationDto`.
   *
   * CATS location labels typically follow `"City, State"` or
   * `"City (qualifier), Country"` patterns. We split on commas and map the
   * parts to city / state / country heuristically.
   */
  private parseLocation(label: string): LocationDto | null {
    const clean = label.replace(/\s*\([^)]*\)/g, '').trim(); // strip parenthetical qualifiers
    const parts = clean
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
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the title or location text. */
  private detectRemote(title: string, location: string | null): boolean {
    const hay = `${title} ${location ?? ''}`.toLowerCase();
    return hay.includes('remote') || hay.includes('work from home') || hay.includes('wfh');
  }
}
