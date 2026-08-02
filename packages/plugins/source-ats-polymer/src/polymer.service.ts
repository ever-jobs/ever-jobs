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
  POLYMER_HOST,
  POLYMER_JOBS_PATH_TEMPLATE,
  POLYMER_JOB_DETAIL_PATH_TEMPLATE,
  POLYMER_JOB_PAGE_HOST,
  POLYMER_PAGE_SIZE,
  POLYMER_MAX_CONCURRENCY,
  POLYMER_REQUEST_DELAY_MS,
  POLYMER_DEFAULT_RESULTS,
  POLYMER_HEADERS,
} from './polymer.constants';
import { PolymerJob, PolymerJobDetail, PolymerJobsResponse } from './polymer.types';

/**
 * Polymer ATS careers scraper — generic, multi-tenant.
 *
 * Polymer serves every customer's public careers data from one shared Public
 * API host (`https://api.polymer.co/v1/hire`), with each tenant addressed by an
 * organization slug. The unauthenticated list feed
 * (`GET /organizations/{slug}/jobs?page={n}&per_page=50`) returns a paginated
 * `{ items, meta }` envelope; pages are walked via `meta.is_last`. The list rows
 * carry no description, so the full HTML body + department are hydrated from the
 * per-job detail endpoint (`GET .../jobs/{id}`) with a bounded concurrent
 * fan-out merged via `Promise.allSettled`.
 *
 * The tenant slug is taken from `companySlug` or derived from a `companyUrl`
 * (the `/organizations/{slug}` or `jobs.polymer.co/{slug}` path segment, else the
 * first sub-domain label). A fetch error, an unknown tenant (empty `items` or
 * HTTP 400/404), or a malformed payload degrades to an empty / partial result
 * rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.POLYMER,
  name: 'Polymer',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PolymerService implements IScraper {
  private readonly logger = new Logger(PolymerService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Polymer scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a Polymer tenant slug from input');
      return new JobResponseDto([]);
    }
    const companyName = this.deriveCompanyName(slug);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(POLYMER_HEADERS);

    const resultsWanted = input.resultsWanted ?? POLYMER_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Polymer jobs for tenant: ${slug}`);

      const rows = await this.fetchAllRows(client, slug, resultsWanted);

      // Hydrate descriptions + department from the per-job detail endpoint with a
      // bounded concurrent fan-out (the list rows carry no body).
      const details = await this.fetchDetails(client, slug, rows.slice(0, resultsWanted));

      this.collect(details, slug, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Polymer total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Polymer scrape error for ${slug}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** Walk the paginated list feed until `is_last` (or `resultsWanted` reached). */
  private async fetchAllRows(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    resultsWanted: number,
  ): Promise<PolymerJob[]> {
    const rows: PolymerJob[] = [];
    let page = 1;
    // Hard ceiling on pages so a misbehaving feed can never loop unboundedly.
    const maxPages = Math.max(1, Math.ceil(resultsWanted / POLYMER_PAGE_SIZE) + 1);

    for (let i = 0; i < maxPages; i++) {
      const { items, isLast } = await this.fetchPage(client, slug, page);
      rows.push(...items);
      if (rows.length >= resultsWanted) break;
      if (isLast || items.length === 0) break;
      page += 1;
    }
    return rows;
  }

  /** Fetch one list page; returns its rows and whether it is the final page. */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    page: number,
  ): Promise<{ items: PolymerJob[]; isLast: boolean }> {
    const base = `${POLYMER_HOST}${POLYMER_JOBS_PATH_TEMPLATE.replace(
      '{slug}',
      encodeURIComponent(slug),
    )}`;
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(POLYMER_PAGE_SIZE),
    });
    const url = `${base}?${params.toString()}`;
    try {
      const response = await client.get<PolymerJobsResponse>(url);
      const data = response.data ?? {};
      const items = Array.isArray(data.items) ? data.items : [];
      const isLast = data.meta?.is_last ?? data.meta?.next_page == null;
      return { items, isLast };
    } catch (err: any) {
      // An unknown / dead tenant returns HTTP 400/404; treat as "no jobs".
      const status = err?.response?.status;
      if (status === 400 || status === 404) {
        this.logger.warn(`Polymer tenant "${slug}" not found (HTTP ${status})`);
        return { items: [], isLast: true };
      }
      throw err;
    }
  }

  /**
   * Hydrate each list row with its detail document (HTML description +
   * department). A failed detail fetch falls back to the bare list row so the
   * job is still ingested (with a null description).
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    rows: PolymerJob[],
  ): Promise<PolymerJobDetail[]> {
    const details: PolymerJobDetail[] = [];

    for (let i = 0; i < rows.length; i += POLYMER_MAX_CONCURRENCY) {
      const chunk = rows.slice(i, i + POLYMER_MAX_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map((row) => this.fetchDetail(client, slug, row)),
      );
      for (let j = 0; j < settled.length; j++) {
        const result = settled[j];
        if (result.status === 'fulfilled') {
          details.push(result.value);
        } else {
          this.logger.warn(`Polymer detail fetch failed: ${result.reason?.message ?? result.reason}`);
          details.push(chunk[j]); // degrade to the list row (no description)
        }
      }
      if (i + POLYMER_MAX_CONCURRENCY < rows.length) {
        await randomSleep(POLYMER_REQUEST_DELAY_MS, POLYMER_REQUEST_DELAY_MS * 2);
      }
    }
    return details;
  }

  /** Fetch one job's detail document; falls back to the list row on 4xx. */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    row: PolymerJob,
  ): Promise<PolymerJobDetail> {
    const id = this.extractAtsId(row);
    if (!id) return row;
    const path = POLYMER_JOB_DETAIL_PATH_TEMPLATE.replace('{slug}', encodeURIComponent(slug)).replace(
      '{id}',
      encodeURIComponent(id),
    );
    const url = `${POLYMER_HOST}${path}`;
    try {
      const response = await client.get<PolymerJobDetail>(url);
      const detail = response.data;
      // Merge so any list-only fields survive even if the detail omits them.
      return detail && typeof detail === 'object' ? { ...row, ...detail } : row;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 404) return row;
      throw err;
    }
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: PolymerJobDetail[],
    slug: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of jobs) {
      try {
        const post = this.processJob(job, slug, companyName, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Polymer job ${job?.id ?? job?.hash_id}: ${err.message}`);
      }
    }
  }

  private processJob(
    job: PolymerJobDetail,
    slug: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = this.extractAtsId(job);
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(job, slug, atsId);
    const applyUrl = job.job_post_url ?? job.jobPostUrl ?? jobUrl;

    const rawDescription = job.description ?? null;
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

    const department = this.normalizeText(job.department) ?? null;

    return new JobPostDto({
      id: `polymer-${atsId}`,
      title,
      companyName: this.normalizeText(job.organization_name ?? job.organizationName) ?? companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(
        job.published_at ?? job.publishedAt ?? job.published_at_timestamp ?? job.created_at ?? job.createdAt ?? job.created_at_timestamp,
      ),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.POLYMER,
      atsId,
      atsType: 'polymer',
      department,
      employmentType: this.normalizeText(job.kind_pretty ?? job.kindPretty ?? job.kind) ?? null,
      applyUrl,
    });
  }

  /** Extract the stable ATS id (numeric `id`, else `hash_id`). */
  private extractAtsId(job: PolymerJob): string {
    const raw = job.id ?? job.job_id ?? job.jobId ?? job.hash_id ?? job.hashId ?? '';
    return String(raw ?? '');
  }

  /** Resolve the careers slug from an explicit slug or a Polymer careers URL. */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const segments = u.pathname.split('/').filter(Boolean);
        // API form: /v1/hire/organizations/{slug}/jobs
        const orgIdx = segments.indexOf('organizations');
        if (orgIdx >= 0 && segments[orgIdx + 1]) return segments[orgIdx + 1];
        // Hosted job-board form: jobs.polymer.co/{slug}/{id}
        const host = u.host.split(':')[0];
        if (host.endsWith('polymer.co') && segments[0]) return segments[0];
        // Otherwise fall back to the first sub-domain label (custom domains).
        const label = host.split('.')[0];
        if (label && label !== 'www' && label !== 'jobs' && label !== 'api') return label;
      } catch {
        // Malformed URL — no slug recoverable.
      }
    }
    return '';
  }

  /** Build the public job-detail page URL for the tenant. */
  private buildJobUrl(job: PolymerJob, slug: string, atsId: string): string {
    const posted = job.job_post_url ?? job.jobPostUrl;
    if (posted && posted.trim()) return posted;
    return `${POLYMER_JOB_PAGE_HOST}/${encodeURIComponent(slug)}/${encodeURIComponent(atsId)}`;
  }

  private deriveCompanyName(slug: string): string {
    return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private normalizeText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  /**
   * Polymer emits structured `city`/`state_region`/`country` plus a
   * pre-formatted `display_location`; prefer the structured parts and fall back
   * to splitting the display label.
   */
  private extractLocation(job: PolymerJob): LocationDto | null {
    const city = this.normalizeText(job.city);
    const state = this.normalizeText(job.state_region ?? job.stateRegion);
    const country = this.normalizeText(job.country);
    if (city || state || country) {
      return new LocationDto({ city, state, country });
    }
    const display = this.normalizeText(job.display_location ?? job.displayLocation);
    if (!display) return null;
    const parts = display
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    return new LocationDto({
      city: parts[0] ?? null,
      state: parts[1] ?? null,
      country: parts.length >= 3 ? parts[2] : null,
    });
  }

  /** Detect remote roles from `remoteness_pretty`, the location, or the title. */
  private detectRemote(job: PolymerJob): boolean {
    const haystacks = [
      job.remoteness_pretty ?? job.remotenessPretty,
      job.display_location ?? job.displayLocation,
      job.title,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }

  /** Parse epoch-seconds, epoch-ms, or ISO strings into a YYYY-MM-DD string. */
  private parseDate(value: string | number | null | undefined): string | null {
    if (value == null) return null;
    try {
      if (typeof value === 'number') {
        const ms = value > 1e12 ? value : value > 1e10 ? value : value * 1000;
        return toDateOnly(ms);
      }
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
