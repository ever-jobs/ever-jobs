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
  OORWIN_API_BASE,
  OORWIN_HOST_TEMPLATE,
  OORWIN_JOB_PAGE_TEMPLATE,
  OORWIN_JOB_LIST_PATH,
  OORWIN_JOB_VIEW_PATH,
  OORWIN_PAGE_SIZE,
  OORWIN_MAX_CONCURRENCY,
  OORWIN_REQUEST_DELAY_MS,
  OORWIN_DEFAULT_RESULTS,
  OORWIN_DEFAULT_ORDER,
  OORWIN_DEFAULT_SORT,
  OORWIN_LIST_TYPE_PUBLIC,
  OORWIN_HEADERS,
} from './oorwin.constants';
import {
  OorwinJobListItem,
  OorwinJobListResponse,
  OorwinJobDetail,
  OorwinJobViewResponse,
} from './oorwin.types';

/**
 * Oorwin career portal scraper — generic, multi-tenant.
 *
 * Oorwin is a cloud-based staffing and talent management platform. Every
 * customer tenant has a public career portal served from its own sub-domain
 * under the shared apex `oorwin.com`
 * (e.g. `https://purpledrive.oorwin.com/careers/`). The Angular SPA powering
 * that portal makes two anonymous, unauthenticated POST calls to the shared
 * Oorwin REST API to render listings:
 *
 *   1. `POST https://api.oorwin.ai/api/v2/careers/getJobList`
 *      Body: `{ sub_domain, limit, page, order, sort, list_type, getDefaultData }`
 *      Returns: `{ data: { list_details: { data: [...], total, last_page } } }`
 *      The listing rows are compact (no HTML description); a separate
 *      detail call is needed for the description.
 *
 *   2. `POST https://api.oorwin.ai/api/v2/careers/job_view`
 *      Body: `{ sub_domain, job_id: "{computed_sha1_job_id}", view_type: "1" }`
 *      Returns: `{ data: { job_details: { job_description: "<html>..." } } }`
 *
 * The tenant sub-domain is resolved from `input.companySlug` or from the
 * first sub-domain label of `input.companyUrl`. A single fetch error, an
 * unknown tenant (HTTP 404 or `status: 404`), or a malformed payload degrades
 * to an empty or partial result rather than throwing, so a single tenant never
 * aborts a batch run.
 */
@SourcePlugin({
  site: Site.OORWIN,
  name: 'Oorwin',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class OorwinService implements IScraper {
  private readonly logger = new Logger(OorwinService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Oorwin scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(input.companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve an Oorwin tenant from input');
      return new JobResponseDto([]);
    }

    const host = OORWIN_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
    const companyName = this.deriveCompanyName(tenant);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(OORWIN_HEADERS);

    const resultsWanted = input.resultsWanted ?? OORWIN_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Oorwin jobs for tenant: ${tenant}`);

      // First page → job summaries + true total count for this tenant.
      const firstResult = await this.fetchListPage(client, tenant, 1);
      if (!firstResult) {
        this.logger.warn(`Oorwin tenant not found or no jobs: ${tenant}`);
        return new JobResponseDto([]);
      }

      const { items: firstItems, total, lastPage } = firstResult;

      // Fetch descriptions for the first page.
      await this.fetchDescriptionsAndCollect(
        client,
        tenant,
        host,
        firstItems,
        companyName,
        input.descriptionFormat,
        seen,
        jobPosts,
      );

      const effectiveTotal = Math.min(total, resultsWanted);
      const maxPage = Math.min(
        lastPage,
        Math.ceil(effectiveTotal / OORWIN_PAGE_SIZE),
      );

      if (jobPosts.length < effectiveTotal && maxPage > 1) {
        const remainingPages: number[] = [];
        for (let page = 2; page <= maxPage; page += 1) {
          remainingPages.push(page);
        }

        // Bounded concurrent fan-out over additional listing pages.
        for (let i = 0; i < remainingPages.length; i += OORWIN_MAX_CONCURRENCY) {
          const chunk = remainingPages.slice(i, i + OORWIN_MAX_CONCURRENCY);
          const pageResults = await Promise.allSettled(
            chunk.map((page) => this.fetchListPage(client, tenant, page)),
          );

          // Collect all items from this chunk of pages, then resolve descriptions
          // concurrently within the chunk.
          const chunkItems: OorwinJobListItem[] = [];
          for (const result of pageResults) {
            if (result.status === 'fulfilled' && result.value) {
              chunkItems.push(...result.value.items);
            } else if (result.status === 'rejected') {
              this.logger.warn(
                `Oorwin listing page fetch failed: ${result.reason?.message ?? result.reason}`,
              );
            }
          }

          await this.fetchDescriptionsAndCollect(
            client,
            tenant,
            host,
            chunkItems,
            companyName,
            input.descriptionFormat,
            seen,
            jobPosts,
          );

          if (jobPosts.length >= effectiveTotal) break;

          if (i + OORWIN_MAX_CONCURRENCY < remainingPages.length) {
            await randomSleep(OORWIN_REQUEST_DELAY_MS, OORWIN_REQUEST_DELAY_MS * 2);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Oorwin total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Oorwin scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /**
   * Fetch a single listing page; returns its items plus the tenant totals, or
   * null when the tenant is unknown / the response is not status 1.
   */
  private async fetchListPage(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    page: number,
  ): Promise<{ items: OorwinJobListItem[]; total: number; lastPage: number } | null> {
    const url = `${OORWIN_API_BASE}${OORWIN_JOB_LIST_PATH}`;
    try {
      const response = await client.post<OorwinJobListResponse>(url, {
        sub_domain: tenant,
        limit: OORWIN_PAGE_SIZE,
        page,
        order: OORWIN_DEFAULT_ORDER,
        sort: OORWIN_DEFAULT_SORT,
        list_type: OORWIN_LIST_TYPE_PUBLIC,
        getDefaultData: true,
      });
      const body = response.data ?? {};
      // The API uses status:1 for success; 404 = unknown tenant
      if (body.status === 404 || (body.status !== 1 && body.success !== 1)) {
        this.logger.warn(`Oorwin: non-success status for tenant "${tenant}" (status=${body.status})`);
        return null;
      }
      const listDetails = body.data?.list_details;
      const items: OorwinJobListItem[] = Array.isArray(listDetails?.data)
        ? (listDetails!.data as OorwinJobListItem[])
        : [];
      const total = listDetails?.total ?? 0;
      const lastPage = listDetails?.last_page ?? 1;
      return { items, total, lastPage };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 400) {
        this.logger.warn(`Oorwin tenant not found (HTTP ${status}) for "${tenant}"`);
        return null;
      }
      throw err;
    }
  }

  /**
   * For a batch of listing items, concurrently fetch their job detail pages
   * (to get the HTML description), map each to a `JobPostDto`, de-duplicate,
   * and append to `out`. Individual detail-fetch failures degrade gracefully:
   * the job is still collected with a null description.
   */
  private async fetchDescriptionsAndCollect(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    host: string,
    items: OorwinJobListItem[],
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): Promise<void> {
    if (items.length === 0) return;

    const detailResults = await Promise.allSettled(
      items.map((item) => this.fetchJobDetail(client, tenant, item)),
    );

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const detailResult = detailResults[i];
      let detail: OorwinJobDetail | null = null;
      if (detailResult.status === 'fulfilled') {
        detail = detailResult.value;
      } else {
        this.logger.warn(
          `Oorwin detail fetch failed for job ${item.id}: ${detailResult.reason?.message ?? detailResult.reason}`,
        );
      }

      try {
        const post = this.processJob(item, detail, host, companyName, format);
        if (!post) continue;
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Oorwin job ${item.id}: ${err.message}`);
      }
    }
  }

  /**
   * Fetch the HTML description for one job from the `careers/job_view` endpoint.
   * Returns the job_details object, or null on failure.
   */
  private async fetchJobDetail(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    item: OorwinJobListItem,
  ): Promise<OorwinJobDetail | null> {
    const sha1Id = item.computed_sha1_job_id;
    if (!sha1Id) return null;
    const url = `${OORWIN_API_BASE}${OORWIN_JOB_VIEW_PATH}`;
    try {
      const response = await client.post<OorwinJobViewResponse>(url, {
        sub_domain: tenant,
        job_id: sha1Id,
        view_type: '1',
      });
      const body = response.data ?? {};
      if (body.status !== 1 && body.success !== 1) return null;
      return body.data?.job_details ?? null;
    } catch {
      return null;
    }
  }

  /** Map a listing row + optional detail into a `JobPostDto`. */
  private processJob(
    item: OorwinJobListItem,
    detail: OorwinJobDetail | null,
    host: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = item.title ?? detail?.title;
    if (!title) return null;

    const atsId = String(item.id ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(host, atsId);
    const rawDescription = detail?.job_description ?? null;
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

    const department = item.job_type ?? detail?.job_type ?? null;

    return new JobPostDto({
      id: `oorwin-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(item),
      description,
      datePosted: this.parseDate(item.cp_published_on),
      isRemote: this.detectRemote(item),
      emails: extractEmails(description),
      site: Site.OORWIN,
      atsId,
      atsType: 'oorwin',
      department,
      applyUrl: jobUrl,
    });
  }

  /** Resolve the tenant sub-domain from an explicit slug or a custom URL. */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.split(':')[0];
        const labels = hostname.split('.').filter(Boolean);
        // For `{tenant}.oorwin.com` the tenant is the first label;
        // for a custom domain we fall back to the first non-"www" label.
        const label = labels[0];
        if (label && label !== 'www') return label;
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  /** Build the public job-detail page URL for this tenant. */
  private buildJobUrl(host: string, atsId: string): string {
    const path = OORWIN_JOB_PAGE_TEMPLATE.replace('{id}', encodeURIComponent(atsId));
    return `${host}${path}`;
  }

  private deriveCompanyName(tenant: string): string {
    return tenant
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Extract a `LocationDto` from the listing row's city / state / country fields.
   * The `city` field is a free-text string that may include the state abbreviation
   * (e.g. "Plano, TX"); `state_format_name` and `country_format_name` provide the
   * full structured names.
   */
  private extractLocation(item: OorwinJobListItem): LocationDto | null {
    const cityRaw = item.city ?? null;
    const state = item.state_format_name ?? null;
    const country = item.country_format_name ?? null;

    if (!cityRaw && !state && !country) return null;

    // The `city` field often carries "City, ST" — strip the state abbreviation
    // if we have a full state name from the structured field.
    let city: string | null = cityRaw;
    if (cityRaw && state) {
      const commaIdx = cityRaw.lastIndexOf(',');
      if (commaIdx > 0) {
        city = cityRaw.substring(0, commaIdx).trim() || cityRaw;
      }
    }

    return new LocationDto({ city: city ?? null, state, country });
  }

  /** Detect remote roles from the `remote_status` field or the job title. */
  private detectRemote(item: OorwinJobListItem): boolean {
    const remoteStatus = item.remote_status?.toLowerCase() ?? '';
    if (remoteStatus === 'remote') return true;
    const title = item.title?.toLowerCase() ?? '';
    if (title.includes('remote') || title.includes('work from home') || title.includes('wfh')) {
      return true;
    }
    return false;
  }

  /**
   * Parse a timestamp string like "2026-06-02 20:01:19.000" or
   * "06/02/2026" (MM/DD/YYYY) into a YYYY-MM-DD string.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      // "2026-06-02 20:01:19.000" → ISO-like, just replace space with T
      const normalised = value.trim().replace(' ', 'T');
      const parsed = new Date(normalised);
      if (!isNaN(parsed.getTime())) return toDateOnly(normalised);
    } catch {
      // ignore
    }
    return null;
  }
}
