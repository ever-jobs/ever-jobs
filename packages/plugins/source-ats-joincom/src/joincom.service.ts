import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  DescriptionFormat,
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { createHttpClient, htmlToPlainText, parseLocationList } from '@ever-jobs/common';
import {
  JOINCOM_API_BASE_URL,
  JOINCOM_BASE_URL,
  JOINCOM_COMPANY_ID_FALLBACK_REGEX,
  JOINCOM_COMPANY_ID_PRIMARY_REGEX,
  JOINCOM_DEFAULT_LOCALE,
  JOINCOM_DEFAULT_RESULTS_WANTED,
  JOINCOM_HTML_HEADERS,
  JOINCOM_JSON_HEADERS,
  JOINCOM_MAX_PAGES,
  JOINCOM_PAGE_SIZE,
} from './joincom.constants';
import {
  JoinComJobItem,
  JoinComJobsPage,
  JoinComTenantContext,
} from './joincom.types';

/**
 * Spec 006 / T07 — Join.com REST two-step implementation.
 *
 * Two-step scrape:
 *   1. `GET https://join.com/companies/<slug>` returns HTML with an
 *      embedded JSON blob; a regex extracts the numeric `companyId`.
 *      Two regex shapes are tried in order — the canonical
 *      `"company":{"id":12345` and the fallback `"companyId":12345`
 *      that some skinned tenants render.
 *   2. `GET https://join.com/api/public/companies/<id>/jobs?...`
 *      paginated at `pageSize=50` until `pagination.totalPages` or
 *      an empty `items[]` array. `>= 0.5 s` polite-pacing between
 *      pages matches upstream Python's `time.sleep(0.5)`.
 *
 * Behavioural parity with `OTHERS/Ats-scrapers/join_com/api_client.py`:
 *   - Same regex pair (primary + fallback) for company-id extraction.
 *   - Same pagination cap and pageSize.
 *   - Same polite-pacing of 0.5 s between paginated calls.
 *   - HTTP errors on EITHER step → empty `JobResponseDto`. Never throws.
 *   - Honours `input.resultsWanted` mid-page; defaults to
 *     `JOINCOM_DEFAULT_RESULTS_WANTED` (= 100).
 *   - `descriptionFormat=PLAIN` runs the HTML description through
 *     `htmlToPlainText`; HTML / MARKDOWN preserve the upstream
 *     content as-is (Join.com already serves Markdown-friendly HTML).
 *
 * Departures from upstream Python (intentional):
 *   - We don't expose a separate `get_job_details(job_id)` surface;
 *     the canonical `JobPostDto.description` is populated directly
 *     from `items[i].description` when present.
 *   - `posting.id` becomes `joincom-${item.id}` — same `<vendor>-<id>`
 *     prefix convention as `gem-`, `avature-`, `greenhouse-`, etc.
 */
@SourcePlugin({
  site: Site.JOIN_COM,
  name: 'Join.com',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class JoinComService implements IScraper {
  private readonly logger = new Logger(JoinComService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const slug = input.companySlug?.trim();
    if (!slug) {
      this.logger.warn('Join.com scrape requires `companySlug` — unset');
      return new JobResponseDto([]);
    }

    const resultsWanted =
      input.resultsWanted ?? JOINCOM_DEFAULT_RESULTS_WANTED;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
      // Polite pacing — applied to all GETs, including the Step 1
      // HTML request. Matches upstream Python's `time.sleep(0.5)`
      // between paginated calls.
      rateDelayMin: 0.5,
    });

    const tenant = await this.resolveTenant(client, slug);
    if (!tenant) {
      this.logger.warn(
        `Join.com: company slug "${slug}" did not resolve to a numeric id (regex miss / HTTP error)`,
      );
      return new JobResponseDto([]);
    }

    const items = await this.collectJobItems(client, tenant, resultsWanted);
    const format = input.descriptionFormat;

    const jobs: JobPostDto[] = [];
    for (const item of items) {
      const mapped = this.toJobPost(item, tenant, format);
      if (mapped) jobs.push(mapped);
    }

    this.logger.log(
      `Join.com: ${jobs.length} jobs for ${slug} (companyId=${tenant.companyId}, resultsWanted=${resultsWanted})`,
    );
    return new JobResponseDto(jobs);
  }

  /**
   * Step 1 — `GET /companies/<slug>` → regex-extract `companyId`.
   *
   * Tries the canonical `"company":{"id":(\d+)` shape first, then
   * the `"companyId":(\d+)` fallback. A miss on both (or any HTTP
   * error) returns `null`, which collapses the scrape to an empty
   * `JobResponseDto`.
   */
  private async resolveTenant(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
  ): Promise<JoinComTenantContext | null> {
    client.setHeaders(JOINCOM_HTML_HEADERS);
    const url = `${JOINCOM_BASE_URL}/companies/${slug}`;

    let html: string;
    try {
      const response = await client.get<string>(url);
      html =
        typeof response.data === 'string'
          ? response.data
          : String(response.data ?? '');
    } catch (err: any) {
      this.logger.warn(
        `Join.com: company HTML fetch failed for "${slug}": ${err.message ?? String(err)}`,
      );
      return null;
    }

    const primary = JOINCOM_COMPANY_ID_PRIMARY_REGEX.exec(html);
    const idStr = primary?.[1] ?? JOINCOM_COMPANY_ID_FALLBACK_REGEX.exec(html)?.[1];
    if (!idStr) return null;
    const companyId = Number.parseInt(idStr, 10);
    if (!Number.isFinite(companyId) || companyId <= 0) return null;

    return {
      companyId,
      companySlug: slug,
      companyName: this.deriveCompanyName(slug),
    };
  }

  /**
   * Step 2 — paginated GETs against
   * `${API_BASE}/companies/<id>/jobs?...` until
   * `pagination.totalPages` is reached, an empty `items[]` is seen,
   * or `resultsWanted` is hit.
   */
  private async collectJobItems(
    client: ReturnType<typeof createHttpClient>,
    tenant: JoinComTenantContext,
    resultsWanted: number,
  ): Promise<JoinComJobItem[]> {
    client.setHeaders(JOINCOM_JSON_HEADERS);

    const collected: JoinComJobItem[] = [];
    let currentPage = 1;
    let totalPages = 1;

    while (currentPage <= JOINCOM_MAX_PAGES) {
      if (collected.length >= resultsWanted) break;

      const url = this.buildJobsPageUrl(tenant.companyId, currentPage);
      let page: JoinComJobsPage;
      try {
        const response = await client.get<JoinComJobsPage>(url);
        page = response.data ?? {};
      } catch (err: any) {
        this.logger.warn(
          `Join.com: jobs page ${currentPage} failed for companyId=${tenant.companyId}: ${err.message ?? String(err)}`,
        );
        break;
      }

      const items = page.items ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        if (collected.length >= resultsWanted) break;
        collected.push(item);
      }

      totalPages = page.pagination?.totalPages ?? totalPages;
      if (currentPage >= totalPages) break;
      currentPage += 1;
    }

    return collected;
  }

  /** Build the `GET /companies/<id>/jobs?...` URL with the canonical query params. */
  private buildJobsPageUrl(companyId: number, page: number): string {
    const params = new URLSearchParams({
      locale: JOINCOM_DEFAULT_LOCALE,
      page: String(page),
      pageSize: String(JOINCOM_PAGE_SIZE),
      withAggregations: 'true',
      sort: '+title',
    });
    return `${JOINCOM_API_BASE_URL}/companies/${companyId}/jobs?${params.toString()}`;
  }

  /**
   * Map a single `JoinComJobItem` to the canonical `JobPostDto`.
   * Returns `null` for items missing both an `id` and a `title` —
   * synthetic ids would break downstream dedup keying.
   */
  private toJobPost(
    item: JoinComJobItem,
    tenant: JoinComTenantContext,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const id = item.id;
    if (id === undefined || id === null || id === '') return null;
    const title = item.title?.trim();
    if (!title) return null;

    const firstLocation = item.locations?.[0];
    const locationName =
      firstLocation?.name?.trim() ?? firstLocation?.city?.trim() ?? null;
    const locationParsed = parseLocationList([locationName]);
    const location = locationName ? locationParsed.location : null;
    const isRemote =
      firstLocation?.isRemote === true ||
      (locationName?.toLowerCase().includes('remote') ?? false) ||
      (item.remoteOption?.toLowerCase().includes('remote') ?? false);

    const department =
      typeof item.department === 'string'
        ? item.department
        : item.department?.name ?? item.category?.name ?? null;

    const description = this.formatDescription(item.description, format);

    const jobUrl =
      item.shareableUrl ?? `${JOINCOM_BASE_URL}/jobs/${id}`;

    return new JobPostDto({
      id: `joincom-${id}`,
      title,
      companyName: tenant.companyName,
      jobUrl,
      location,
      ...(locationParsed.locations.length > 0 ? { locations: locationParsed.locations } : {}),
      isRemote,
      site: Site.JOIN_COM,
      atsId: String(id),
      atsType: 'join_com',
      department,
      description,
      employmentType: item.employmentType ?? null,
      datePosted: item.publishedAt ?? null,
    });
  }

  /**
   * Apply the requested `DescriptionFormat` to a raw HTML description.
   * `PLAIN` runs the HTML through `htmlToPlainText`; everything else
   * (HTML / MARKDOWN / undefined) preserves the upstream content,
   * since Join.com already serves a Markdown-friendly subset of HTML.
   */
  private formatDescription(
    raw: string | undefined,
    format: DescriptionFormat | undefined,
  ): string | null {
    if (!raw) return null;
    if (format === DescriptionFormat.PLAIN) {
      return htmlToPlainText(raw);
    }
    return raw;
  }

  /**
   * Derive a presentable company name from a Join.com slug. Mirrors
   * `acme-corp` → `Acme Corp`. Join.com doesn't surface a canonical
   * `companyName` field on the public API; the upstream Python falls
   * back to the slug verbatim, but title-casing reads better in
   * downstream UIs.
   */
  private deriveCompanyName(slug: string): string {
    return slug
      .replace(/-+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}
