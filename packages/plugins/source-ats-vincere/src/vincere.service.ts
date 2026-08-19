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
  VINCERE_HOST_TEMPLATE,
  VINCERE_CAREERS_PATH,
  VINCERE_SEARCH_PATH,
  VINCERE_JOB_PAGE_TEMPLATE,
  VINCERE_PAGE_SIZE,
  VINCERE_MAX_CONCURRENCY,
  VINCERE_REQUEST_DELAY_MS,
  VINCERE_DEFAULT_RESULTS,
  VINCERE_HEADERS,
  VINCERE_AJAX_HEADERS,
} from './vincere.constants';
import { VincereJob, VincereSearchResponse } from './vincere.types';

/**
 * Vincere Instant Job Board scraper — generic, multi-tenant.
 *
 * Vincere serves every tenant's public job board from its own sub-domain under
 * the shared apex `vincere.io` at the `/careers/` path (e.g.
 * `https://nordicjobsworldwide.vincere.io/careers/`). The board's own front-end
 * fetches listings from a CSRF-protected AJAX endpoint —
 * `POST /careers/ajax/search-jobs` — which returns
 * `{ items: [...], total, more }` with fully structured job objects embedded
 * (including `public_description` HTML). We obtain the per-session CSRF token
 * from the initial GET of the careers page, then page the AJAX endpoint with a
 * bounded concurrent fan-out; the first response yields the true total `total`.
 *
 * The tenant sub-domain is taken from `companySlug` or derived from a custom
 * `companyUrl` (its first sub-domain label). A fetch error, an unknown tenant
 * (HTTP 4xx), or a malformed payload degrades to an empty/partial result rather
 * than throwing, so a single tenant never aborts a batch run. The private
 * `/api/v2/job/search/` endpoint that requires `x-api-key` and `id-token`
 * credentials is deliberately not used.
 */
@SourcePlugin({
  site: Site.VINCERE,
  name: 'Vincere',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class VincereService implements IScraper {
  private readonly logger = new Logger(VincereService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Vincere scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a Vincere tenant slug from input');
      return new JobResponseDto([]);
    }

    const host = VINCERE_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
    const companyName = this.deriveCompanyName(slug);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(VINCERE_HEADERS);

    const resultsWanted = input.resultsWanted ?? VINCERE_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Vincere jobs for tenant: ${slug}`);

      // Step 1: GET the careers listing page to obtain the CSRF token and
      // session cookie. The Laravel framework requires these for all POST calls.
      const { csrfToken, sessionCookie } = await this.fetchCsrfToken(client, host);
      if (!csrfToken) {
        this.logger.warn(`Vincere: could not obtain CSRF token for ${slug} — aborting`);
        return new JobResponseDto([]);
      }

      // Step 2: Fetch the first page to get the true total count.
      const first = await this.fetchPage(client, host, csrfToken, sessionCookie, 1);
      this.collect(first.items, host, companyName, input.descriptionFormat, seen, jobPosts);

      const total = Math.min(first.total ?? jobPosts.length, resultsWanted);

      // Step 3: Fan out remaining pages with bounded concurrency.
      if (jobPosts.length < total && first.more === true) {
        const pages: number[] = [];
        for (let page = 2; (page - 1) * VINCERE_PAGE_SIZE < total; page += 1) {
          pages.push(page);
        }

        for (let i = 0; i < pages.length; i += VINCERE_MAX_CONCURRENCY) {
          const chunk = pages.slice(i, i + VINCERE_MAX_CONCURRENCY);
          const settled = await Promise.allSettled(
            chunk.map((page) =>
              this.fetchPage(client, host, csrfToken, sessionCookie, page),
            ),
          );
          for (const result of settled) {
            if (result.status === 'fulfilled') {
              this.collect(
                result.value.items,
                host,
                companyName,
                input.descriptionFormat,
                seen,
                jobPosts,
              );
            } else {
              this.logger.warn(
                `Vincere page fetch failed: ${result.reason?.message ?? result.reason}`,
              );
            }
          }
          if (i + VINCERE_MAX_CONCURRENCY < pages.length) {
            await randomSleep(VINCERE_REQUEST_DELAY_MS, VINCERE_REQUEST_DELAY_MS * 2);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Vincere total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Vincere scrape error for ${slug}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * GET the careers listing page and extract the CSRF token from the
   * `<meta name="csrf-token">` element. The `Set-Cookie` header is also
   * captured so we can include the session cookie in subsequent AJAX POSTs.
   * Returns empty strings if the page is unavailable or malformed.
   */
  private async fetchCsrfToken(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<{ csrfToken: string; sessionCookie: string }> {
    const url = `${host}${VINCERE_CAREERS_PATH}`;
    try {
      const response = await client.get<string>(url, {
        // We need the raw HTML and the response headers (for cookies).
        responseType: 'text',
        maxRedirects: 5,
      });

      const html: string = typeof response.data === 'string' ? response.data : '';
      const csrfMatch = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
      const csrfToken = csrfMatch ? csrfMatch[1] : '';

      // Extract laravel_session from the Set-Cookie header (if present).
      // The axios header may be a string[], a single string, or undefined.
      const rawCookieHeader: unknown = response.headers?.['set-cookie'];
      const cookieValues: string[] = Array.isArray(rawCookieHeader)
        ? (rawCookieHeader as string[])
        : typeof rawCookieHeader === 'string'
          ? [rawCookieHeader]
          : [];
      let sessionCookie = '';
      for (const cookie of cookieValues) {
        const m = cookie.match(/laravel_session=([^;]+)/);
        if (m) {
          sessionCookie = `laravel_session=${m[1]}`;
          break;
        }
      }

      return { csrfToken, sessionCookie };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 410) {
        this.logger.warn(`Vincere tenant not found (HTTP ${status}) for ${host}`);
      } else {
        this.logger.warn(`Vincere CSRF fetch error for ${host}: ${err.message}`);
      }
      return { csrfToken: '', sessionCookie: '' };
    }
  }

  /**
   * POST to the AJAX search endpoint for a single page.
   * Returns the structured items and total count.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    csrfToken: string,
    sessionCookie: string,
    page: number,
  ): Promise<{ items: VincereJob[]; total: number; more: boolean }> {
    const url = `${host}${VINCERE_SEARCH_PATH}`;
    try {
      const response = await client.post<VincereSearchResponse>(
        url,
        new URLSearchParams({ page: String(page) }).toString(),
        {
          headers: {
            ...VINCERE_AJAX_HEADERS,
            'X-CSRF-TOKEN': csrfToken,
            ...(sessionCookie ? { Cookie: sessionCookie } : {}),
          },
        },
      );
      const data = response.data ?? {};
      return {
        items: Array.isArray(data.items) ? data.items : [],
        total: data.total ?? 0,
        more: data.more === true,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 404 || status === 410) {
        this.logger.warn(`Vincere tenant search not found (HTTP ${status}) for ${host}`);
        return { items: [], total: 0, more: false };
      }
      throw err;
    }
  }

  /** Map raw job items → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    items: VincereJob[],
    host: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of items) {
      try {
        const post = this.processJob(job, host, companyName, format);
        if (!post) continue;
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(
          `Error processing Vincere job ${job?.id}: ${err.message}`,
        );
      }
    }
  }

  private processJob(
    job: VincereJob,
    host: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.job_title ?? job.jobTitle;
    if (!title) return null;

    const atsId = String(job.id ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(host, job, atsId);

    const rawDescription = job.public_description ?? job.job_summary ?? null;
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

    // Derive department from employment/job type strings.
    const department = this.normaliseDepartment(
      job.job_type ?? null,
      job.employment_type ?? null,
    );

    return new JobPostDto({
      id: `vincere-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.published_date ?? job.open_date),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.VINCERE,
      atsId,
      atsType: 'vincere',
      department,
      applyUrl: `${host}/careers/apply/${atsId}`,
    });
  }

  /**
   * Build the public job-detail page URL.
   * The canonical form is `/careers/job/{id}` — the trailing slug segment is
   * appended when available for human-readability but is not required by the
   * server.
   */
  private buildJobUrl(host: string, job: VincereJob, atsId: string): string {
    const title = job.job_title ?? job.jobTitle ?? '';
    const locationName = job.location?.location_name ?? '';
    const slugPart = this.titleToSlug(
      locationName ? `${title} ${locationName}` : title,
    );
    return VINCERE_JOB_PAGE_TEMPLATE.replace('{id}', encodeURIComponent(atsId))
      .replace('{slug}', slugPart)
      .replace(/^/, host);
  }

  /** Resolve the tenant sub-domain slug from an explicit slug or a custom URL. */
  private resolveSlug(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostLabel = u.host.split(':')[0];
        const labels = hostLabel.split('.').filter(Boolean);
        // For `{slug}.vincere.io` the slug is the first label. For a custom
        // domain we still fall back to the first sub-domain label.
        const label = labels[0];
        if (label && label !== 'www') return label;
      } catch {
        // Malformed URL — no slug recoverable.
      }
    }
    return '';
  }

  /** Derive a display company name from the slug. */
  private deriveCompanyName(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Convert a title/location string to a URL-safe slug. */
  private titleToSlug(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Prefer the structured `location` object; fall back to free-text
   * `location_name` splitting.
   */
  private extractLocation(job: VincereJob): LocationDto | null {
    const loc = job.location;
    if (loc && typeof loc === 'object') {
      const city = loc.city && loc.city.trim() ? loc.city.trim() : null;
      const state = loc.state && loc.state.trim() ? loc.state.trim() : null;
      const country = loc.country && loc.country.trim() ? loc.country.trim() : null;
      if (city || state || country) {
        return new LocationDto({ city, state, country });
      }
      if (loc.location_name && loc.location_name.trim()) {
        return this.locationFromLabel(loc.location_name.trim());
      }
    }
    return null;
  }

  /** Split a free-text "City, Country" label into a LocationDto. */
  private locationFromLabel(label: string): LocationDto | null {
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
    return new LocationDto({ city, state, country });
  }

  /**
   * Normalise the Vincere `job_type` / `employment_type` strings into a
   * human-readable department label.
   * Observed values: job_type → "PERMANENT"|"CONTRACT"|"TEMPORARY";
   *                  employment_type → "FULL_TIME"|"PART_TIME"|"CASUAL".
   */
  private normaliseDepartment(
    jobType: string | null,
    employmentType: string | null,
  ): string | null {
    const JOB_TYPE_LABELS: Record<string, string> = {
      PERMANENT: 'Permanent',
      CONTRACT: 'Contract',
      TEMPORARY: 'Temporary',
      TEMP: 'Temporary',
    };
    const EMP_TYPE_LABELS: Record<string, string> = {
      FULL_TIME: 'Full-time',
      PART_TIME: 'Part-time',
      CASUAL: 'Casual',
    };
    const jt = jobType ? JOB_TYPE_LABELS[jobType.toUpperCase()] ?? null : null;
    const et = employmentType
      ? EMP_TYPE_LABELS[employmentType.toUpperCase()] ?? null
      : null;
    if (jt && et) return `${jt} / ${et}`;
    return jt ?? et ?? null;
  }

  /** Detect remote roles from the employment type or title keywords. */
  private detectRemote(job: VincereJob): boolean {
    const haystacks = [job.job_title ?? job.jobTitle, job.location?.location_name];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) {
        return true;
      }
    }
    // Vincere uses CASUAL as an employment type sometimes tied to remote work,
    // but that alone is not a reliable remote signal — only title/location keywords.
    return false;
  }

  /** Parse ISO-8601 timestamps or date strings into a YYYY-MM-DD string. */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
