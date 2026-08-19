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
  toDateOnly,
} from '@ever-jobs/common';
import {
  DIGITALRECRUITERS_API_HOST,
  DIGITALRECRUITERS_APEX,
  DIGITALRECRUITERS_HOST_TEMPLATE,
  DIGITALRECRUITERS_SITE_CONFIG_PATH,
  DIGITALRECRUITERS_JOB_LIST_PATH,
  DIGITALRECRUITERS_JOB_DETAIL_PATH,
  DIGITALRECRUITERS_JOB_PAGE_TEMPLATE,
  DIGITALRECRUITERS_PAGE_SIZE,
  DIGITALRECRUITERS_MAX_CONCURRENCY,
  DIGITALRECRUITERS_REQUEST_DELAY_MS,
  DIGITALRECRUITERS_DEFAULT_RESULTS,
  DIGITALRECRUITERS_DEFAULT_LOCALE,
  DIGITALRECRUITERS_DEFAULT_LANG,
  DIGITALRECRUITERS_LOCALE_MAP,
  DIGITALRECRUITERS_HEADERS,
} from './digitalrecruiters.constants';
import {
  DigitalRecruitersSiteConfig,
  DigitalRecruitersJobListItem,
  DigitalRecruitersJobListResponse,
  DigitalRecruitersJobDetail,
} from './digitalrecruiters.types';

/**
 * DigitalRecruiters career-site scraper — generic, multi-tenant.
 *
 * DigitalRecruiters powers public career sites for multi-site / multi-brand /
 * international employers. Each tenant is served from
 * `https://{tenant}.digitalrecruiters.com/` (a Nuxt SPA) and usually also maps
 * a custom career domain (e.g. `careers.acme.com`). The SPA renders its listing
 * from two anonymous, unauthenticated JSON endpoints on a shared public API:
 *
 *   1. `GET  /careers/v1/careers-sites/{host}` resolves the canonical career
 *      `domain_name` + default locale for a tenant sub-domain or custom domain.
 *   2. `POST /public/v1/careers-site/job-ads?domainName=&limit=&page=&locale=`
 *      returns `{ count, items[] }` — listing rows without a description.
 *   3. `GET  /public/v1/careers-site/job-ads/{job_ad_id}?domainName=&locale=`
 *      returns the full record (HTML `description`/`profile`, structured
 *      address, `jsonld.datePosted`).
 *
 * Tenant resolution: `companySlug` is preferred (the sub-domain label of
 * `{slug}.digitalrecruiters.com`); otherwise the host of `companyUrl` is used.
 * The career-site config endpoint then resolves the canonical `domain_name`
 * required by the job-ads API. A single fetch error, an unknown tenant
 * (HTTP 4xx), or a malformed payload degrades to an empty/partial result rather
 * than throwing, so a single tenant never aborts a batch run.
 */
@SourcePlugin({
  site: Site.DIGITALRECRUITERS,
  name: 'DigitalRecruiters',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class DigitalRecruitersService implements IScraper {
  private readonly logger = new Logger(DigitalRecruitersService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for DigitalRecruiters scraper');
      return new JobResponseDto([]);
    }

    const resolved = this.resolveTenant(input.companySlug, input.companyUrl);
    if (!resolved) {
      this.logger.warn('Could not resolve a DigitalRecruiters tenant from input');
      return new JobResponseDto([]);
    }
    const { tenant, host } = resolved;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(DIGITALRECRUITERS_HEADERS);

    const resultsWanted = input.resultsWanted ?? DIGITALRECRUITERS_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching DigitalRecruiters jobs for tenant: ${tenant}`);

      // Resolve the canonical career domain + locale via the config endpoint.
      const config = await this.fetchSiteConfig(client, host);
      if (!config) {
        this.logger.warn(`DigitalRecruiters tenant not found or offline: ${tenant}`);
        return new JobResponseDto([]);
      }

      const domainName = config.domain_name?.trim();
      if (!domainName) {
        this.logger.warn(`DigitalRecruiters: no domain_name resolved for tenant ${tenant}`);
        return new JobResponseDto([]);
      }

      const locale = this.resolveLocale(config);
      const lang = this.resolveLang(config);
      const companyName = this.deriveCompanyName(config, tenant);

      // First page → listing rows + true total count for this tenant.
      const firstResult = await this.fetchListPage(client, domainName, locale, 1);
      if (!firstResult) {
        this.logger.warn(`DigitalRecruiters: no listing for ${domainName}`);
        return new JobResponseDto([]);
      }

      const { items: firstItems, count } = firstResult;
      await this.fetchDetailsAndCollect(
        client,
        domainName,
        locale,
        lang,
        tenant,
        firstItems,
        companyName,
        input.descriptionFormat,
        seen,
        jobPosts,
      );

      const effectiveTotal = Math.min(count || firstItems.length, resultsWanted);
      const maxPage = Math.ceil(effectiveTotal / DIGITALRECRUITERS_PAGE_SIZE);

      if (jobPosts.length < effectiveTotal && maxPage > 1) {
        const remainingPages: number[] = [];
        for (let page = 2; page <= maxPage; page += 1) {
          remainingPages.push(page);
        }

        // Bounded concurrent fan-out over additional listing pages.
        for (let i = 0; i < remainingPages.length; i += DIGITALRECRUITERS_MAX_CONCURRENCY) {
          const chunk = remainingPages.slice(i, i + DIGITALRECRUITERS_MAX_CONCURRENCY);
          const pageResults = await Promise.allSettled(
            chunk.map((page) => this.fetchListPage(client, domainName, locale, page)),
          );

          const chunkItems: DigitalRecruitersJobListItem[] = [];
          for (const result of pageResults) {
            if (result.status === 'fulfilled' && result.value) {
              chunkItems.push(...result.value.items);
            } else if (result.status === 'rejected') {
              this.logger.warn(
                `DigitalRecruiters listing page fetch failed: ${result.reason?.message ?? result.reason}`,
              );
            }
          }

          await this.fetchDetailsAndCollect(
            client,
            domainName,
            locale,
            lang,
            tenant,
            chunkItems,
            companyName,
            input.descriptionFormat,
            seen,
            jobPosts,
          );

          if (jobPosts.length >= effectiveTotal) break;

          if (i + DIGITALRECRUITERS_MAX_CONCURRENCY < remainingPages.length) {
            await randomSleep(
              DIGITALRECRUITERS_REQUEST_DELAY_MS,
              DIGITALRECRUITERS_REQUEST_DELAY_MS * 2,
            );
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`DigitalRecruiters total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`DigitalRecruiters scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Resolve the careers-site config for a tenant host. Returns null when the
   * tenant is unknown (HTTP 4xx) or the site is offline.
   */
  private async fetchSiteConfig(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<DigitalRecruitersSiteConfig | null> {
    const url =
      DIGITALRECRUITERS_API_HOST +
      DIGITALRECRUITERS_SITE_CONFIG_PATH.replace('{host}', encodeURIComponent(host));
    try {
      const response = await client.get<DigitalRecruitersSiteConfig>(url);
      const body = response.data ?? null;
      if (!body || body.is_online === false) return null;
      return body;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 403 || status === 404) {
        this.logger.warn(`DigitalRecruiters tenant config not found (HTTP ${status}) for ${host}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Fetch a single listing page; returns its items plus the tenant total count,
   * or null when the response is unusable.
   */
  private async fetchListPage(
    client: ReturnType<typeof createHttpClient>,
    domainName: string,
    locale: string,
    page: number,
  ): Promise<{ items: DigitalRecruitersJobListItem[]; count: number } | null> {
    const url = DIGITALRECRUITERS_API_HOST + DIGITALRECRUITERS_JOB_LIST_PATH;
    try {
      const response = await client.post<DigitalRecruitersJobListResponse>(
        url,
        {},
        {
          params: {
            domainName,
            limit: DIGITALRECRUITERS_PAGE_SIZE,
            page,
            locale,
          },
        },
      );
      const body = response.data ?? {};
      const items: DigitalRecruitersJobListItem[] = Array.isArray(body.items) ? body.items : [];
      const count = body.count ?? items.length;
      return { items, count };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 403 || status === 404) {
        this.logger.warn(
          `DigitalRecruiters listing not found (HTTP ${status}) for ${domainName}`,
        );
        return null;
      }
      throw err;
    }
  }

  /**
   * For a batch of listing items, concurrently fetch their detail records (for
   * the HTML description + structured address), map each to a `JobPostDto`,
   * de-duplicate by `atsId`, and append to `out`. Individual detail-fetch
   * failures degrade gracefully: the job is still collected from listing data.
   */
  private async fetchDetailsAndCollect(
    client: ReturnType<typeof createHttpClient>,
    domainName: string,
    locale: string,
    lang: string,
    tenant: string,
    items: DigitalRecruitersJobListItem[],
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): Promise<void> {
    if (items.length === 0) return;

    const detailResults = await Promise.allSettled(
      items.map((item) => this.fetchJobDetail(client, domainName, locale, item)),
    );

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const detailResult = detailResults[i];
      let detail: DigitalRecruitersJobDetail | null = null;
      if (detailResult.status === 'fulfilled') {
        detail = detailResult.value;
      } else {
        this.logger.warn(
          `DigitalRecruiters detail fetch failed for job ${item.job_ad_id}: ${detailResult.reason?.message ?? detailResult.reason}`,
        );
      }

      try {
        const post = this.processJob(item, detail, tenant, lang, companyName, format);
        if (!post) continue;
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(
          `Error processing DigitalRecruiters job ${item.job_ad_id}: ${err.message}`,
        );
      }
    }
  }

  /**
   * Fetch the full detail record for one job. Returns null on failure (the
   * listing row alone is sufficient to produce a partial JobPostDto).
   */
  private async fetchJobDetail(
    client: ReturnType<typeof createHttpClient>,
    domainName: string,
    locale: string,
    item: DigitalRecruitersJobListItem,
  ): Promise<DigitalRecruitersJobDetail | null> {
    const jobAdId = item.job_ad_id;
    if (jobAdId === null || jobAdId === undefined) return null;
    const url =
      DIGITALRECRUITERS_API_HOST +
      DIGITALRECRUITERS_JOB_DETAIL_PATH.replace('{id}', encodeURIComponent(String(jobAdId)));
    try {
      const response = await client.get<DigitalRecruitersJobDetail>(url, {
        params: {
          domainName,
          locale,
          withJsonld: 1,
        },
      });
      return response.data ?? null;
    } catch {
      return null;
    }
  }

  /** Map a listing row + optional detail into a `JobPostDto`. */
  private processJob(
    item: DigitalRecruitersJobListItem,
    detail: DigitalRecruitersJobDetail | null,
    tenant: string,
    lang: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = (item.title ?? detail?.title)?.trim();
    if (!title) return null;

    const jobAdId = item.job_ad_id ?? detail?.job_ad_id;
    if (jobAdId === null || jobAdId === undefined) return null;
    const atsId = String(jobAdId);

    const jobUrl = this.buildJobUrl(tenant, lang, item, detail);

    const description = this.buildDescription(detail, format);
    const department = this.extractDepartment(item, detail);

    return new JobPostDto({
      id: `digitalrecruiters-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(item, detail),
      description,
      datePosted: this.parseDate(detail),
      isRemote: this.detectRemote(item, detail),
      emails: extractEmails(description),
      site: Site.DIGITALRECRUITERS,
      atsId,
      atsType: 'digitalrecruiters',
      department,
      applyUrl: jobUrl,
    });
  }

  /**
   * Combine the HTML `description` and (when present) the `profile` fragment,
   * then convert per the requested `descriptionFormat`.
   */
  private buildDescription(
    detail: DigitalRecruitersJobDetail | null,
    format?: DescriptionFormat,
  ): string | null {
    const parts: string[] = [];
    if (detail?.description?.trim()) parts.push(detail.description.trim());
    if (detail?.profile?.trim()) parts.push(detail.profile.trim());
    if (parts.length === 0) return null;
    const rawHtml = parts.join('\n');

    if (format === DescriptionFormat.HTML) return rawHtml;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(rawHtml) ?? rawHtml;
    return htmlToPlainText(rawHtml);
  }

  /** Build the public job-detail page URL for this tenant/job. */
  private buildJobUrl(
    tenant: string,
    lang: string,
    item: DigitalRecruitersJobListItem,
    detail: DigitalRecruitersJobDetail | null,
  ): string {
    const jobAdId = String(item.job_ad_id ?? detail?.job_ad_id ?? '');
    // The listing `url` slug is already prefixed with the job_ad_id; the detail
    // `url` is the bare slug (prefix it) — prefer the listing form when present.
    let slug = item.url?.trim() ?? '';
    if (!slug && detail?.url?.trim()) {
      const bare = detail.url.trim();
      slug = jobAdId && !bare.startsWith(`${jobAdId}-`) ? `${jobAdId}-${bare}` : bare;
    }
    if (!slug) slug = jobAdId;

    return DIGITALRECRUITERS_JOB_PAGE_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant))
      .replace('{lang}', encodeURIComponent(lang))
      .replace('{slug}', slug);
  }

  /**
   * Resolve the tenant sub-domain label + the host to query the config endpoint
   * with. `companySlug` is preferred; otherwise the host of `companyUrl` is used.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): { tenant: string; host: string } | null {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      const host = DIGITALRECRUITERS_HOST_TEMPLATE.replace(
        '{tenant}',
        encodeURIComponent(slug),
      ).replace(/^https?:\/\//, '');
      return { tenant: slug, host };
    }
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.split(':')[0];
        // Tenant label = first sub-domain label of the host (drop "www").
        const labels = hostname.split('.').filter(Boolean);
        let tenant = labels[0] && labels[0] !== 'www' ? labels[0] : hostname;
        // For a DigitalRecruiters-hosted host the label may carry a "-careers"
        // suffix; keep the raw sub-domain label for the public page URL.
        if (hostname.endsWith(`.${DIGITALRECRUITERS_APEX}`)) {
          tenant = labels[0];
        }
        return { tenant, host: hostname };
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return null;
  }

  /**
   * Resolve a region-qualified locale accepted by the job-ads endpoint from the
   * config's default locale, expanding bare two-letter codes via the map.
   */
  private resolveLocale(config: DigitalRecruitersSiteConfig): string {
    const iso = config.default_locale?.iso_code?.trim();
    if (iso) {
      if (DIGITALRECRUITERS_LOCALE_MAP[iso]) return DIGITALRECRUITERS_LOCALE_MAP[iso];
      // Already region-qualified (e.g. "pt_BR", "zh_CN") → pass through.
      if (/^[a-z]{2}_[A-Z]{2}$/.test(iso)) return iso;
    }
    return DIGITALRECRUITERS_DEFAULT_LOCALE;
  }

  /** Resolve the two-letter language label used in the public job-page URL. */
  private resolveLang(config: DigitalRecruitersSiteConfig): string {
    const iso = config.default_locale?.iso_code?.trim();
    if (iso) {
      const lang = iso.split('_')[0];
      if (lang) return lang.toLowerCase();
    }
    return DIGITALRECRUITERS_DEFAULT_LANG;
  }

  /** Derive a display company name from the config or the tenant label. */
  private deriveCompanyName(config: DigitalRecruitersSiteConfig, tenant: string): string {
    const fromConfig = config.child_account_name?.trim() || config.name?.trim();
    if (fromConfig) {
      // Strip a trailing "careers" / "carrières" descriptor when present.
      return fromConfig.replace(/\s+(careers?|carri[eè]res?)\s*$/i, '').trim() || fromConfig;
    }
    return tenant
      .replace(/-?careers?$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Build a `LocationDto` from the detail's structured address, falling back to
   * the free-text listing/detail location label.
   */
  private extractLocation(
    item: DigitalRecruitersJobListItem,
    detail: DigitalRecruitersJobDetail | null,
  ): LocationDto | null {
    const addr = detail?.address;
    if (addr && (addr.city || addr.state || addr.country)) {
      return new LocationDto({
        city: addr.city?.trim() || null,
        state: addr.state?.trim() || null,
        country: addr.country?.trim() || null,
      });
    }

    const raw = (detail?.formatted_address ?? item.location ?? detail?.location)?.trim();
    if (!raw) return null;
    const parts = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    return new LocationDto({
      city: parts[0] || null,
      state: null,
      country: parts[parts.length - 1] || null,
    });
  }

  /** Department from the listing `job` label or the detail's first job-function entry. */
  private extractDepartment(
    item: DigitalRecruitersJobListItem,
    detail: DigitalRecruitersJobDetail | null,
  ): string | null {
    const fromList = item.job?.trim();
    if (fromList) return fromList;
    const fromDetail = detail?.job?.[0]?.label?.trim();
    return fromDetail || null;
  }

  /** Detect remote roles from working-time / contract / title keywords. */
  private detectRemote(
    item: DigitalRecruitersJobListItem,
    detail: DigitalRecruitersJobDetail | null,
  ): boolean {
    const haystacks = [
      item.title,
      item.contract,
      item.location,
      detail?.working_time,
      detail?.contract,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('télétravail') ||
        v.includes('teletravail') ||
        v.includes('work from home') ||
        v.includes('wfh')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Parse the posted date. Prefer `jsonld.datePosted` (ISO `YYYY-MM-DD`), then
   * `republished_at` ("YYYY-MM-DD HH:mm:ss"). Returns `YYYY-MM-DD` or null.
   */
  private parseDate(detail: DigitalRecruitersJobDetail | null): string | null {
    const candidates = [detail?.jsonld?.datePosted, detail?.republished_at];
    for (const value of candidates) {
      if (!value) continue;
      try {
        const normalised = value.trim().replace(' ', 'T');
        const parsed = new Date(normalised);
        if (!isNaN(parsed.getTime())) return toDateOnly(normalised);
      } catch {
        // try next candidate
      }
    }
    return null;
  }
}
