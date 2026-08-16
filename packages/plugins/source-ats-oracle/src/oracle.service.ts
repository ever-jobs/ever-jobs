import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  Site,
  classifyScrapeError,
  ScrapeDiagnostics,
} from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';
import {
  ORACLE_DEFAULT_EXPAND,
  ORACLE_DEFAULT_FACETS,
  ORACLE_DEFAULT_HOST_SEGMENT,
  ORACLE_DEFAULT_RESULTS_WANTED,
  ORACLE_DEFAULT_SITE_NUMBER,
  ORACLE_DEFAULT_SORT_BY,
  ORACLE_ERR_BAD_TENANT,
  ORACLE_ERR_FINDER_REJECTED,
  ORACLE_FINDER_NAME,
  ORACLE_HEADERS,
  ORACLE_MAX_PAGES,
  ORACLE_RECORDS_PER_PAGE,
  ORACLE_REST_PATH,
} from './oracle.constants';
import {
  OracleJobsResponse,
  OracleRequisition,
  OracleTenantContext,
} from './oracle.types';

/**
 * Spec 013 / T03 — Oracle HCM Cloud REST + finder-string scraper.
 *
 * Works against any Oracle Recruiting Cloud (Oracle HCM
 * CandidateExperience) tenant. URL pattern:
 * `https://{subdomain}.fa.{region}.oraclecloud.com`.
 *
 * Tenant resolution (Spec 013 / FR-3, updated Spec 5037):
 *   1. `input.companyUrl` (full CandidateExperience URL) is canonical.
 *      `siteNumber` is extracted from the URL path (`/sites/{CX_…}`).
 *   2. `input.companySlug` accepts three forms (see `parseSlug`):
 *      a. `{fullHost}:{siteNumber}` — preferred; no host guessing.
 *      b. `{subdomain}:{siteNumber}` — host completed with `.fa.ocs.`
 *         (works for modern SaaS pods; region-code tenants need form a).
 *      c. `{subdomain}-{region}` — legacy compose (back-compat).
 *   3. `input.siteNumber` overrides slug/URL-derived values when set.
 *   4. If neither is supplied, the scrape returns an empty
 *      `JobResponseDto` with sentinel `ERR_ORACLE_BAD_TENANT`.
 *
 * Wire format (Spec 013 / FR-2 — matches upstream Python's exact
 * separator scheme inside
 * `OTHERS/Ats-scrapers/oracle/scripts/oracle_ats_client/api_client.py`):
 *   - Outer query string: `?onlyData=true&expand=<…>&finder=findReqs;<finder-string>`
 *   - Inner finder string: `siteNumber=CX_45001,facetsList=<facets>,limit=100,offset=N,sortBy=POSTING_DATES_DESC`
 *     (commas between params, semicolons between facets — the live
 *     Oracle API rejects the all-semicolon variant suggested by
 *     spec.md / FR-2; we follow the upstream Python's wire format
 *     which is known to work against the production endpoint.
 *     Decision logged in spec.md § 10.)
 *   - `offset=` is omitted on the first page (offset=0) to match
 *     upstream Python's conditional append.
 *
 * Pagination (FR-2):
 *   - Increment `offset` by `100` (= `ORACLE_RECORDS_PER_PAGE`)
 *     until `requisitionList[]` empty OR `resultsWanted` cap reached.
 *   - Hard ceiling at `ORACLE_MAX_PAGES` (50) prevents runaway loops.
 *
 * Error handling (FR-12 / `AGENTS.md §10`):
 *   - Any thrown HTTP error is caught; service logs at `warn` with
 *     the matching sentinel code (`ERR_ORACLE_BAD_TENANT` or
 *     `ERR_ORACLE_FINDER_REJECTED`) and returns whatever has been
 *     collected so far (empty `JobResponseDto` on the first page).
 *   - The aggregator's circuit breaker (Spec 005 / FR-1) sees the
 *     successful resolution and will not trip from a single bad
 *     tenant.
 */
@SourcePlugin({
  site: Site.ORACLE,
  name: 'Oracle HCM Cloud',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class OracleService implements IScraper {
  private readonly logger = new Logger(OracleService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resolved = this.resolveTenant(input);
    if (!resolved) {
      this.logger.warn(
        `OracleService: ${ORACLE_ERR_BAD_TENANT} — both companyUrl and companySlug unset`,
      );
      return new JobResponseDto([]);
    }
    const { tenant } = resolved;

    const resultsWanted =
      input.resultsWanted ?? ORACLE_DEFAULT_RESULTS_WANTED;
    // Precedence: explicit input.siteNumber > site parsed from the
    // slug/URL (`…:CX_1` / `/sites/CX_1`) > the CX_45001 default.
    const siteNumber =
      input.siteNumber?.trim() || resolved.siteNumber || ORACLE_DEFAULT_SITE_NUMBER;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout,
    });
    client.setHeaders(ORACLE_HEADERS);

    const collected: OracleRequisition[] = [];
    let totalJobsCount: number | null = null;
    let diagnostics: ScrapeDiagnostics | undefined;

    for (let page = 0; page < ORACLE_MAX_PAGES; page++) {
      if (collected.length >= resultsWanted) break;

      const offset = page * ORACLE_RECORDS_PER_PAGE;
      const url = this.buildPageUrl(tenant.baseUrl, siteNumber, offset);

      let payload: OracleJobsResponse;
      try {
        const response = await client.get<OracleJobsResponse>(url);
        payload = (response.data ?? {}) as OracleJobsResponse;
      } catch (err: any) {
        const status = err?.response?.status;
        const code =
          status && status >= 400 && status < 500
            ? ORACLE_ERR_FINDER_REJECTED
            : ORACLE_ERR_BAD_TENANT;
        this.logger.warn(
          `OracleService: ${code} — page fetch failed (${tenant.domain} offset=${offset}, status=${status ?? 'n/a'}): ${err?.message ?? err}`,
        );
        diagnostics = classifyScrapeError(err);
        break;
      }

      const wrapper = payload?.items?.[0];
      if (totalJobsCount === null && typeof wrapper?.TotalJobsCount === 'number') {
        totalJobsCount = wrapper.TotalJobsCount;
      }

      const requisitions = wrapper?.requisitionList ?? [];
      if (requisitions.length === 0) {
        this.logger.debug(
          `OracleService: empty page at offset=${offset} for ${tenant.domain}`,
        );
        break;
      }

      for (const req of requisitions) {
        if (collected.length >= resultsWanted) break;
        collected.push(req);
      }

      // Oracle returns SHORT pages mid-run (offset 0→100, 100→99,
      // 200→44 for a 244-job board), so `page.length < limit` is NOT a
      // last-page signal. Terminate on `TotalJobsCount` (or an empty
      // page, handled above) instead — otherwise the scrape stops early.
      const target =
        totalJobsCount !== null
          ? Math.min(totalJobsCount, resultsWanted)
          : resultsWanted;
      if (collected.length >= target) break;
    }

    const jobs: JobPostDto[] = collected.map((r) =>
      this.toJobPost(r, tenant),
    );
    this.logger.log(
      `OracleService: ${jobs.length} jobs from ${tenant.domain} (resultsWanted=${resultsWanted}, siteNumber=${siteNumber})`,
    );
    return new JobResponseDto(jobs, jobs.length ? undefined : diagnostics);
  }

  /**
   * Resolve `companyUrl` / `companySlug` into an `OracleTenantContext`
   * plus the `siteNumber` carried alongside it (if any). `companyUrl`
   * is canonical; `companySlug` is the fallback.
   */
  private resolveTenant(
    input: ScraperInputDto,
  ): { tenant: OracleTenantContext; siteNumber: string | null } | null {
    const fromUrl = input.companyUrl?.trim();
    if (fromUrl) {
      try {
        return {
          tenant: this.tenantFromUrl(fromUrl),
          siteNumber: this.siteNumberFromUrl(fromUrl),
        };
      } catch (err: any) {
        this.logger.warn(
          `OracleService: invalid companyUrl=${fromUrl} — ${err?.message}; trying companySlug fallback`,
        );
      }
    }

    const slug = input.companySlug?.trim();
    if (slug) {
      const parsed = this.parseSlug(slug);
      if (parsed) {
        try {
          return {
            tenant: this.tenantFromUrl(parsed.baseUrl),
            siteNumber: parsed.siteNumber,
          };
        } catch (err: any) {
          this.logger.warn(
            `OracleService: composed URL ${parsed.baseUrl} invalid — ${err?.message}`,
          );
        }
      }
    }

    return null;
  }

  /**
   * Parse a `companySlug` into a base URL + optional `siteNumber`.
   * Accepted forms (Spec 5037):
   *   - `{fullHost}:{siteNumber}` — e.g.
   *     `fa-esbv-saasfaprod1.fa.ocs.oraclecloud.com:CX_1` (preferred —
   *     no host reconstruction, region/pod preserved).
   *   - `{fullHost}` — host only, siteNumber falls back to default.
   *   - `{subdomain}:{siteNumber}` — e.g. `fa-esbv-saasfaprod1:CX_1`;
   *     host completed with the default `.fa.ocs.` segment (works for
   *     modern SaaS pods; region-code tenants need the full-host form).
   *   - `{subdomain}-{region}` — legacy compose (e.g. `eeho-us2`), kept
   *     for back-compat.
   */
  private parseSlug(
    slug: string,
  ): { baseUrl: string; siteNumber: string | null } | null {
    const colon = slug.indexOf(':');
    const left = (colon >= 0 ? slug.slice(0, colon) : slug).trim();
    const siteNumber =
      colon >= 0 ? slug.slice(colon + 1).trim() || null : null;
    if (!left) return null;

    // Full host (has a dot) — use verbatim; strip any scheme/path.
    if (left.includes('.')) {
      const host = left.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      return { baseUrl: `https://${host}`, siteNumber };
    }

    // Bare pod subdomain via the colon form: the WHOLE left side is the
    // subdomain — complete it with the default host segment.
    if (colon >= 0) {
      return {
        baseUrl: `https://${left}.fa.${ORACLE_DEFAULT_HOST_SEGMENT}.oraclecloud.com`,
        siteNumber,
      };
    }

    // Legacy `{subdomain}-{region}` form.
    const composed = this.composeUrlFromSlug(left);
    return composed ? { baseUrl: composed, siteNumber: null } : null;
  }

  /** Extract the Oracle `siteNumber` from a CandidateExperience URL path. */
  private siteNumberFromUrl(rawUrl: string): string | null {
    const match = /\/sites\/([^/?#]+)/i.exec(rawUrl);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Compose a tenant URL from a `<subdomain>-<region>` slug. Returns
   * `null` if the slug doesn't carry both halves — Oracle requires
   * BOTH the careers-site subdomain AND the cloud region.
   */
  private composeUrlFromSlug(slug: string): string | null {
    const lastDash = slug.lastIndexOf('-');
    if (lastDash <= 0 || lastDash === slug.length - 1) return null;
    const subdomain = slug.slice(0, lastDash);
    const region = slug.slice(lastDash + 1);
    return `https://${subdomain}.fa.${region}.oraclecloud.com`;
  }

  /** Build a tenant context from any Oracle-shaped URL. */
  private tenantFromUrl(rawUrl: string): OracleTenantContext {
    const parsed = new URL(rawUrl);
    const baseUrl = `${parsed.protocol}//${parsed.host}`;
    const domain = parsed.host;
    const companyName = this.extractCompanyName(domain);
    return { baseUrl, domain, companyName };
  }

  /**
   * `eeho.fa.us2.oraclecloud.com` → `Eeho` (first hostname segment).
   * Best-effort fallback used only when `requisition.EmployerName` is
   * absent. Real Oracle tenants nearly always populate `EmployerName`.
   */
  private extractCompanyName(domain: string): string {
    const head = domain.split('.')[0] ?? domain;
    return head
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Build the per-page URL using upstream Python's exact wire format. */
  private buildPageUrl(
    baseUrl: string,
    siteNumber: string,
    offset: number,
  ): string {
    const facetsStr = ORACLE_DEFAULT_FACETS.join(';');

    const finderParams: string[] = [
      `siteNumber=${siteNumber}`,
      `facetsList=${facetsStr}`,
      `limit=${ORACLE_RECORDS_PER_PAGE}`,
    ];
    if (offset > 0) {
      finderParams.push(`offset=${offset}`);
    }
    finderParams.push(`sortBy=${ORACLE_DEFAULT_SORT_BY}`);

    const finderString = finderParams.join(',');

    const queryString =
      `?onlyData=true` +
      `&expand=${ORACLE_DEFAULT_EXPAND}` +
      `&finder=${ORACLE_FINDER_NAME};${finderString}`;

    return `${baseUrl}${ORACLE_REST_PATH}${queryString}`;
  }

  /** Map a single requisition into the canonical `JobPostDto`. */
  private toJobPost(
    req: OracleRequisition,
    tenant: OracleTenantContext,
  ): JobPostDto {
    const location = req.PrimaryLocation
      ? new LocationDto({ city: req.PrimaryLocation })
      : null;
    const isRemote =
      req.PrimaryLocation?.toLowerCase().includes('remote') ?? false;

    const jobUrl = this.buildJobUrl(req, tenant.baseUrl);

    return new JobPostDto({
      id: `oracle-${req.Id}`,
      title: req.Title,
      companyName: req.EmployerName ?? tenant.companyName,
      jobUrl,
      location,
      isRemote,
      site: Site.ORACLE,
      atsId: req.Id,
      atsType: 'oracle',
      datePosted: req.PostedDate ?? null,
    });
  }

  /**
   * Build a job-detail URL. Oracle exposes a SEO-friendly path under
   * `/careers/job/<id>` that all CandidateExperience tenants honour;
   * we fall back to that pattern unless the upstream payload provided
   * an explicit `ExternalUrl` (rare).
   */
  private buildJobUrl(
    req: OracleRequisition,
    baseUrl: string,
  ): string {
    if (req.ExternalUrl) return req.ExternalUrl;
    const slug = req.ExternalUrlSeo ?? req.Id;
    return `${baseUrl}/careers/job/${slug}`;
  }
}
