import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  Site,
  DescriptionFormat,
  getCompensationInterval,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
  parseLocationList,
} from '@ever-jobs/common';
import {
  SUBMIT4JOBS_HOST_SUFFIX,
  SUBMIT4JOBS_DEFAULT_RESULTS,
  SUBMIT4JOBS_DETAIL_CONCURRENCY,
  SUBMIT4JOBS_DEFAULT_TIMEOUT_SECONDS,
  SUBMIT4JOBS_SESSION_COOKIES,
  SUBMIT4JOBS_HEADERS,
  SUBMIT4JOBS_EMBED_REGEX,
  isAllowedSubmit4jobsApiHost,
  SUBMIT4JOBS_SALARY_TYPE_MAP,
  submit4jobsBoardUrl,
  submit4jobsJobUrl,
  submit4jobsIframeUrl,
  submit4jobsApiUrl,
  submit4jobsFilters,
} from './submit4jobs.constants';
import { Submit4jobsApiCoords, Submit4jobsJob } from './submit4jobs.types';

/**
 * Submit4Jobs / Pereless ATS careers scraper.
 *
 * Submit4Jobs boards live at `https://{slug}.submit4jobs.com/` and are white-
 * label careers sites from Pereless Systems. The board is a ColdFusion-hosted
 * Angular SPA embedded via an iframe; the job list is served by a JSON API
 * rather than server-rendered, but the adapter needs no headless browser:
 *
 *   1. Discover: fetch the board home page and read the embed `<script src>`
 *      (`//{apiHost}/templates/{template}/embed/iframe.cfm?cid={cid}`) for the
 *      API host, template, and company id. Tenants live on different Pereless
 *      hosts/templates (`apps.submit4jobs.com`/`magneto`,
 *      `devapps.pereless.com`/`magnetolive`), so these are read per tenant.
 *   2. Prime: GET the embed iframe to obtain the ColdFusion session cookies
 *      (`CFID`, `CFTOKEN`, `CFCLIENT_CAREERHOSTING`). The API returns an error
 *      page unless these are replayed.
 *   3. Enumerate: `POST .../api/?action=getJobs` (header `cid`, the primed
 *      cookies, and the template's default empty-filter body) → a JSON array of
 *      job objects.
 *   4. Describe: the `magnetolive` template omits the description from the list,
 *      so rows with an empty body are enriched by re-issuing `getJobs` with
 *      `filters.jid` set (bounded fan-out) to fetch the body.
 */
@SourcePlugin({
  site: Site.SUBMIT4JOBS,
  name: 'Submit4Jobs',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class Submit4jobsService implements IScraper {
  private readonly logger = new Logger(Submit4jobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Submit4Jobs scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveTenant(input.companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a Submit4Jobs tenant slug from input');
      return new JobResponseDto([]);
    }

    const timeoutSeconds = Math.min(
      input.requestTimeout ?? SUBMIT4JOBS_DEFAULT_TIMEOUT_SECONDS,
      SUBMIT4JOBS_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(SUBMIT4JOBS_HEADERS);

    const resultsWanted = input.resultsWanted ?? SUBMIT4JOBS_DEFAULT_RESULTS;

    try {
      this.logger.log(`Fetching Submit4Jobs jobs for tenant: ${slug}`);

      const coords = await this.discover(client, slug);
      if (!coords) {
        this.logger.log(`Submit4Jobs: could not discover API coordinates for "${slug}"`);
        return new JobResponseDto([]);
      }

      const cookie = await this.primeSession(client, coords);
      if (!cookie) {
        this.logger.log(`Submit4Jobs: could not prime a session for "${slug}"`);
        return new JobResponseDto([]);
      }

      const filters = submit4jobsFilters(coords.template);
      const jobs = await this.getJobs(client, coords, cookie, filters);
      if (!jobs || jobs.length === 0) {
        this.logger.log(`Submit4Jobs tenant "${slug}" has no open roles`);
        return new JobResponseDto([]);
      }

      const deduped = this.dedupe(jobs);
      const selected = deduped.slice(0, resultsWanted);

      await this.fetchDescriptions(client, coords, cookie, filters, selected);

      const jobPosts: JobPostDto[] = [];
      for (const job of selected) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          jobPosts.push(this.toJobPost(job, slug, input.descriptionFormat));
        } catch (err: any) {
          this.logger.warn(`Error processing Submit4Jobs role ${job.jid}: ${err.message}`);
        }
      }

      this.logger.log(`Submit4Jobs total: ${jobPosts.length} jobs for ${slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Submit4Jobs scrape error for ${slug}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /** Fetch the board page and read the embed script for the API coordinates. */
  private async discover(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
  ): Promise<Submit4jobsApiCoords | null> {
    const html = await this.fetchText(client, submit4jobsBoardUrl(slug), slug);
    if (!html) return null;
    const match = SUBMIT4JOBS_EMBED_REGEX.exec(html);
    if (!match) return null;
    const [, apiHost, template, cid] = match;

    // 🛑 SSRF gate. `apiHost` is read out of the tenant board's own HTML and is
    // about to be interpolated into the URLs we request WITH the ColdFusion
    // session cookies attached. The embed regex only constrains the host's
    // shape, so without this check a tenant who can edit their board page could
    // redirect our scraper at an internal address or their own collector.
    // Fail closed: an unrecognised host yields no coordinates, so the scrape
    // returns [] exactly as it does for a board with no embed at all.
    if (!isAllowedSubmit4jobsApiHost(apiHost)) {
      this.logger.warn(
        `Submit4Jobs: refusing embed API host \`${apiHost}\` for ${slug} — not on an allowed domain`,
      );
      return null;
    }

    return { apiHost, template, cid };
  }

  /**
   * GET the embed iframe to obtain the ColdFusion session cookies, then build a
   * Cookie header from the three session cookies (deletion cookies dropped).
   */
  private async primeSession(
    client: ReturnType<typeof createHttpClient>,
    coords: Submit4jobsApiCoords,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(
        submit4jobsIframeUrl(coords.apiHost, coords.template, coords.cid),
        { responseType: 'text' },
      );
      const setCookies = this.readSetCookies(response.headers);
      const cookie = this.buildCookieHeader(setCookies);
      return cookie || null;
    } catch (err: any) {
      this.logger.warn(`Submit4Jobs session prime failed: ${err?.message ?? err}`);
      return null;
    }
  }

  /** Read the `set-cookie` response header as an array. */
  private readSetCookies(headers: unknown): string[] {
    if (!headers || typeof headers !== 'object') return [];
    const raw = (headers as Record<string, unknown>)['set-cookie'];
    if (Array.isArray(raw)) return raw.filter((c): c is string => typeof c === 'string');
    if (typeof raw === 'string') return [raw];
    return [];
  }

  /** Build a Cookie header from the CF session cookies (skip deletions). */
  private buildCookieHeader(setCookies: string[]): string {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const raw of setCookies) {
      const first = raw.split(';')[0];
      const eq = first.indexOf('=');
      if (eq < 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!SUBMIT4JOBS_SESSION_COOKIES.includes(name)) continue;
      if (!value || seen.has(name)) continue;
      seen.add(name);
      parts.push(`${name}=${value}`);
    }
    return parts.join('; ');
  }

  /** POST the `getJobs` API and return the parsed job array (null on error). */
  private async getJobs(
    client: ReturnType<typeof createHttpClient>,
    coords: Submit4jobsApiCoords,
    cookie: string,
    filters: Record<string, unknown>,
  ): Promise<Submit4jobsJob[] | null> {
    try {
      const response = await client.post<string>(
        submit4jobsApiUrl(coords.apiHost, coords.template),
        JSON.stringify({ filters }),
        {
          responseType: 'text',
          headers: {
            cid: coords.cid,
            Cookie: cookie,
            'Content-Type': 'application/json;charset=UTF-8',
          },
        },
      );
      return this.parseJobsPayload(response.data);
    } catch (err: any) {
      this.logger.warn(`Submit4Jobs getJobs failed: ${err?.message ?? err}`);
      return null;
    }
  }

  /** Parse the `getJobs` text payload; non-array (e.g. error HTML) → null. */
  private parseJobsPayload(data: unknown): Submit4jobsJob[] | null {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    if (!text || !text.trim().startsWith('[')) return null;
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as Submit4jobsJob[]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Fill descriptions for rows the list left empty (the `magnetolive` template).
   * Bounded fan-out; a failed detail leaves the row's description null.
   */
  private async fetchDescriptions(
    client: ReturnType<typeof createHttpClient>,
    coords: Submit4jobsApiCoords,
    cookie: string,
    filters: Record<string, unknown>,
    jobs: Submit4jobsJob[],
  ): Promise<void> {
    const bodyless = jobs.filter((j) => !this.hasBody(j) && j.jid != null);
    for (let i = 0; i < bodyless.length; i += SUBMIT4JOBS_DETAIL_CONCURRENCY) {
      const batch = bodyless.slice(i, i + SUBMIT4JOBS_DETAIL_CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (job) => {
          const detail = await this.getJobs(client, coords, cookie, {
            ...filters,
            jid: String(job.jid),
          });
          const found = detail?.find((d) => String(d.jid) === String(job.jid)) ?? detail?.[0];
          if (found) {
            job.jobdescription = found.jobdescription ?? job.jobdescription;
            job.reqsexp = found.reqsexp ?? job.reqsexp;
          }
        }),
      );
    }
  }

  /** De-dupe jobs by `jid` (first occurrence wins). */
  private dedupe(jobs: Submit4jobsJob[]): Submit4jobsJob[] {
    const seen = new Set<string>();
    const out: Submit4jobsJob[] = [];
    for (const job of jobs) {
      const key = String(job.jid ?? '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(job);
    }
    return out;
  }

  /** Map a raw API job → JobPostDto. */
  private toJobPost(
    job: Submit4jobsJob,
    slug: string,
    format: DescriptionFormat | undefined,
  ): JobPostDto {
    const jid = String(job.jid ?? '');
    const title = this.cleanText(job.job_title) ?? this.cleanText(job.jobkeyword) ?? 'Role';
    const jobUrl = submit4jobsJobUrl(slug, jid, title);
    const descriptionHtml = this.assembleDescription(job);
    const { location, isRemote } = this.buildLocation(job, title);

    return new JobPostDto({
      id: `submit4jobs-${slug}-${jid}`,
      title,
      companyName: this.cleanText(job.companyname) ?? this.deriveCompanyName(slug),
      jobUrl,
      location,
      description: this.formatDescription(descriptionHtml, format),
      datePosted: job.postingdate ? toDateOnly(job.postingdate) : null,
      isRemote,
      emails: extractEmails(descriptionHtml ?? ''),
      site: Site.SUBMIT4JOBS,
      atsId: jid,
      atsType: 'submit4jobs',
      department: this.cleanText(job.dname),
      employmentType: this.cleanText(job.jobtype),
      compensation: this.buildCompensation(job),
      applyUrl: jobUrl,
    });
  }

  /** True when the list row carries a description body. */
  private hasBody(job: Submit4jobsJob): boolean {
    return Boolean((job.jobdescription ?? '').trim() || (job.reqsexp ?? '').trim());
  }

  /** Concatenate the job body + requirements HTML. */
  private assembleDescription(job: Submit4jobsJob): string | null {
    const parts = [job.jobdescription, job.reqsexp]
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter((p) => p.length > 0);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  /** Build a LocationDto (+ remote signal) from the structured location fields. */
  private buildLocation(
    job: Submit4jobsJob,
    title: string,
  ): { location: LocationDto | null; isRemote: boolean } {
    const composed = [
      this.cleanText(job.city),
      this.cleanText(job.state),
      this.cleanText(job.fullCountryName) ?? this.cleanText(job.country),
    ]
      .filter((p): p is string => Boolean(p))
      .join(', ');

    const parsed = parseLocationList([composed || this.cleanText(job.location) || null]);
    const isRemote = parsed.remoteMentioned || /\bremote\b/i.test(title);

    if (parsed.location) return { location: parsed.location, isRemote };
    if (job.city || job.state) {
      return {
        location: new LocationDto({
          city: this.cleanText(job.city),
          state: this.cleanText(job.state),
        }),
        isRemote,
      };
    }
    return { location: isRemote ? new LocationDto({ city: 'Remote' }) : null, isRemote };
  }

  /** Build CompensationDto from salary / salaryrange + salarytype. */
  private buildCompensation(job: Submit4jobsJob): CompensationDto | null {
    const min = this.parseAmount(job.salary);
    const max = this.parseAmount(job.salaryrange);
    if (min == null && max == null) return null;

    const code = String(job.salarytype ?? '').trim().toUpperCase();
    const period = SUBMIT4JOBS_SALARY_TYPE_MAP[code];
    const interval = period ? getCompensationInterval(period) : null;

    return new CompensationDto({
      minAmount: min ?? undefined,
      maxAmount: max ?? undefined,
      currency: this.cleanText(job.jobcurrency) ?? undefined,
      interval: interval ?? undefined,
    });
  }

  /** Parse a salary value (`"52,000"`, `21.0`, `45000`) → number or null. */
  private parseAmount(value: string | number | undefined): number | null {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    const num = parseFloat(value.replace(/[^0-9.]/g, ''));
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  /** Convert the HTML job-ad body per `descriptionFormat`. */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * GET a URL as text. Does NOT follow redirects: a live tenant serves a
   * direct 200; a moved tenant degrades to null.
   */
  private async fetchText(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    slug: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, {
        responseType: 'text',
        maxRedirects: 0,
      });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        this.logger.warn(`Submit4Jobs board returned HTTP ${status} for ${slug}`);
        return null;
      }
      this.logger.warn(`Submit4Jobs board fetch failed for ${slug}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Resolve the tenant slug from companySlug or companyUrl.
   *
   * Accepts a bare slug (the subdomain, e.g. `ams`), a full board URL, or a
   * companyUrl on the `*.submit4jobs.com` host (the subdomain is the slug).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    const slug = companySlug?.trim();
    if (slug) {
      if (/^https?:\/\//i.test(slug) || slug.includes(SUBMIT4JOBS_HOST_SUFFIX)) {
        const fromUrl = this.slugFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.replace(/^\/+|\/+$/g, '').toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.slugFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /** Extract the subdomain (the slug) from a `*.submit4jobs.com` URL. */
  private slugFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (!host.endsWith(SUBMIT4JOBS_HOST_SUFFIX)) return '';
      const sub = host.slice(0, -SUBMIT4JOBS_HOST_SUFFIX.length);
      return sub || '';
    } catch {
      return '';
    }
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(slug: string): string {
    return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }

  /** Trim + collapse whitespace; null for empty. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.replace(/\s+/g, ' ').trim();
    return v.length > 0 ? v : null;
  }
}
