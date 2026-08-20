import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  IScraper,
  classifyScrapeError,
  ScrapeDiagnostics,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';
import {
  AVATURE_APPLY_DECOY_TEXTS,
  AVATURE_DEFAULT_RESULTS_WANTED,
  AVATURE_HEADERS,
  AVATURE_LOCALE_PREFIXES,
  AVATURE_MAX_PAGES,
  AVATURE_RECORDS_PER_PAGE,
} from './avature.constants';
import { AvatureParsedJob, AvatureTenantContext } from './avature.types';

/**
 * Spec 006 / T03 — Avature HTML-scrape implementation.
 *
 * Works against any Avature-powered career portal — both the default
 * subdomain pattern (`https://<slug>.avature.net`, e.g. Bloomberg)
 * and custom-domain tenants (e.g. `https://careers.ibm.com`).
 *
 * Tenant resolution rules (Q-022 / Option A, pinned in run #28):
 *   1. `input.companyUrl` overrides everything if present.
 *   2. Otherwise fall back to `https://<companySlug>.avature.net`.
 *   3. If neither is supplied, the scrape returns an empty
 *      `JobResponseDto` and logs at `warn` level.
 *
 * Behavioural parity with `OTHERS/Ats-scrapers/avature/api_client.py`:
 *   - Pagination via
 *     `${base}/careers/SearchJobs/?jobOffset=N&jobRecordsPerPage=12`.
 *   - Five-selector chain plus a link-text fallback for resilience
 *     against Avature theme variations.
 *   - Apply-link decoys (anchors whose text matches
 *     `AVATURE_APPLY_DECOY_TEXTS`) are skipped, not yielded.
 *   - HTTP errors are caught and surface as an empty
 *     `JobResponseDto` — never throw.
 *   - Honours `input.resultsWanted` mid-page; defaults to
 *     `AVATURE_DEFAULT_RESULTS_WANTED` (= 100).
 */
@SourcePlugin({
  site: Site.AVATURE,
  name: 'Avature',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class AvatureService implements IScraper {
  private readonly logger = new Logger(AvatureService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const tenant = this.resolveTenant(input);
    if (!tenant) {
      this.logger.warn(
        'Avature scrape requires either `companyUrl` or `companySlug` — both unset',
      );
      return new JobResponseDto([]);
    }

    const resultsWanted = input.resultsWanted ?? AVATURE_DEFAULT_RESULTS_WANTED;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
      // Polite pacing matches upstream Python's `rate_limit=0.5`.
      rateDelayMin: 0.5,
    });
    client.setHeaders(AVATURE_HEADERS);

    const collected: AvatureParsedJob[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;

    for (let page = 0; page < AVATURE_MAX_PAGES; page++) {
      if (collected.length >= resultsWanted) break;

      const offset = page * AVATURE_RECORDS_PER_PAGE;
      const url = `${tenant.baseUrl}/careers/SearchJobs/?jobOffset=${offset}&jobRecordsPerPage=${AVATURE_RECORDS_PER_PAGE}`;

      let html: string;
      try {
        const response = await client.get<string>(url);
        html =
          typeof response.data === 'string'
            ? response.data
            : String(response.data ?? '');
      } catch (err: any) {
        this.logger.warn(
          `Avature page fetch failed (${tenant.domain} offset=${offset}): ${err.message}`,
        );
        // Match upstream behaviour: a single failed page collapses
        // the entire scrape to an empty response (`get_jobs_page`
        // returns `[]` and `get_all_jobs` breaks the loop). Record WHY
        // first - the break discards the reason otherwise.
        diagnostics = classifyScrapeError(err);
        break;
      }

      const parsed = this.parseListings(html, tenant.baseUrl);
      if (parsed.length === 0) {
        this.logger.debug(
          `Avature reached empty page at offset=${offset} for ${tenant.domain}`,
        );
        break;
      }

      for (const job of parsed) {
        if (collected.length >= resultsWanted) break;
        collected.push(job);
      }

      // Short page = no more results.
      if (parsed.length < AVATURE_RECORDS_PER_PAGE) {
        break;
      }
    }

    const jobs: JobPostDto[] = collected.map((j) => this.toJobPost(j, tenant));
    this.logger.log(
      `Avature: ${jobs.length} jobs from ${tenant.domain} (resultsWanted=${resultsWanted})`,
    );
    return new JobResponseDto(jobs, diagnostics);
  }

  /** Resolve `companyUrl` / `companySlug` into a `AvatureTenantContext`. */
  private resolveTenant(input: ScraperInputDto): AvatureTenantContext | null {
    const fromUrl = input.companyUrl?.trim();
    if (fromUrl) {
      try {
        return this.tenantFromUrl(fromUrl);
      } catch (err: any) {
        this.logger.warn(
          `Avature: invalid companyUrl=${fromUrl} — ${err.message}; trying companySlug fallback`,
        );
      }
    }

    const slug = input.companySlug?.trim();
    if (slug) {
      return this.tenantFromUrl(`https://${slug}.avature.net`);
    }

    return null;
  }

  /**
   * Build a tenant context from any Avature-shaped URL. Mirrors
   * upstream Python's `extract_base_url` + `extract_company_name`
   * helpers.
   */
  private tenantFromUrl(rawUrl: string): AvatureTenantContext {
    const parsed = new URL(rawUrl);
    let baseUrl = `${parsed.protocol}//${parsed.host}`;

    // Preserve a recognised locale prefix (e.g. `/en_US`) so paginated
    // GETs target the same locale the operator pointed at.
    const firstSegment = parsed.pathname.split('/').filter(Boolean)[0];
    if (firstSegment && AVATURE_LOCALE_PREFIXES.has(firstSegment)) {
      baseUrl += `/${firstSegment}`;
    }

    const domain = parsed.host;
    const companyName = this.extractCompanyName(domain);
    return { baseUrl, domain, companyName };
  }

  /**
   * `bloomberg.avature.net` → `Bloomberg`.
   * `careers.ibm.com`        → `Ibm` (custom-domain — first segment after `careers.`).
   * `careers-eu.tesla.com`   → `Tesla` (handles `careers-*` prefixes too).
   */
  private extractCompanyName(domain: string): string {
    const parts = domain.split('.');
    let candidate = parts[0] ?? domain;
    if (
      (candidate === 'careers' || candidate.startsWith('careers-')) &&
      parts.length > 2
    ) {
      candidate = parts[1];
    }
    return candidate
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse a Avature search-results HTML page.
   *
   * Matches the upstream Python's five-selector cascade plus the
   * `'/JobDetail/'`-link fallback. Each selector group is treated as
   * exclusive — once one finds elements, the others are skipped.
   */
  private parseListings(
    html: string,
    baseUrl: string,
  ): AvatureParsedJob[] {
    const $ = cheerio.load(html);

    const cascades: Array<() => cheerio.Cheerio<any>> = [
      () => $('article.job'),
      () => $('div.job-item'),
      () => $('li.job-listing'),
      () => $('tr.job'),
      () => $('div[data-job-id]'),
    ];

    let elements: cheerio.Cheerio<any> | null = null;
    for (const cascade of cascades) {
      const found = cascade();
      if (found.length > 0) {
        elements = found;
        break;
      }
    }

    // Fallback: anchor-link search for `/JobDetail/`.
    if (!elements || elements.length === 0) {
      elements = $('a').filter((_i, el) =>
        ($(el).attr('href') ?? '').includes('/JobDetail/'),
      );
    }

    if (!elements || elements.length === 0) return [];

    const jobs: AvatureParsedJob[] = [];
    elements.each((_i, el) => {
      const parsed = this.parseElement($, $(el), baseUrl);
      if (parsed) jobs.push(parsed);
    });
    return jobs;
  }

  private parseElement(
    $: cheerio.CheerioAPI,
    $el: cheerio.Cheerio<any>,
    baseUrl: string,
  ): AvatureParsedJob | null {
    const isAnchor = ($el.get(0) as any)?.tagName?.toLowerCase() === 'a';
    const $link = isAnchor ? $el : $el.find('a').first();
    const href = $link.attr('href') ?? '';
    if (!href) return null;

    const linkText = ($link.text() ?? '').trim().toLowerCase();
    if (AVATURE_APPLY_DECOY_TEXTS.has(linkText)) return null;

    const jobUrl = href.startsWith('http') ? href : `${baseUrl}${href}`;
    const tail = href.split('?')[0].split('/').filter(Boolean).pop() ?? 'unknown';
    const jobId = tail;

    let title = '';
    const $h2 = $el.find('h2').first();
    const $h3 = $el.find('h3').first();
    const $titled = $el.find('.job-title, .position-title, .title').first();
    if ($h2.length > 0) title = $h2.text().trim();
    else if ($h3.length > 0) title = $h3.text().trim();
    else if ($titled.length > 0) title = $titled.text().trim();
    else title = $link.text().trim();
    if (!title) title = 'No title';

    if (AVATURE_APPLY_DECOY_TEXTS.has(title.toLowerCase())) return null;

    const $loc = $el
      .find('.location, .job-location, span[class*="location" i]')
      .first();
    const location = $loc.length > 0 ? $loc.text().trim() : null;

    const $dept = $el.find('.department, .job-department, .category').first();
    const department = $dept.length > 0 ? $dept.text().trim() : null;

    return { jobId, title, location, department, jobUrl };
  }

  /** Map the parsed job into the canonical `JobPostDto`. */
  private toJobPost(
    parsed: AvatureParsedJob,
    tenant: AvatureTenantContext,
  ): JobPostDto {
    const location = parsed.location
      ? new LocationDto({ city: parsed.location })
      : null;
    const isRemote =
      parsed.location?.toLowerCase().includes('remote') ?? false;

    return new JobPostDto({
      id: `avature-${parsed.jobId}`,
      title: parsed.title,
      companyName: tenant.companyName,
      jobUrl: parsed.jobUrl,
      location,
      isRemote,
      site: Site.AVATURE,
      atsId: parsed.jobId,
      atsType: 'avature',
      department: parsed.department,
    });
  }
}
