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
  toDateOnly,
} from '@ever-jobs/common';
import {
  DARWINBOX_HOST_TEMPLATES,
  DARWINBOX_CAREERS_PATH,
  DARWINBOX_API_BASE,
  DARWINBOX_JOB_LIST_PATHS,
  DARWINBOX_HOST_SUFFIXES,
  DARWINBOX_DEFAULT_RESULTS,
  DARWINBOX_HEADERS,
} from './darwinbox.constants';
import { DarwinboxApiResponse, DarwinboxJob, DarwinboxJobListData } from './darwinbox.types';

/**
 * Darwinbox ATS careers scraper — generic, multi-tenant.
 *
 * Darwinbox (darwinbox.com, India) serves every customer's open roles through a
 * branded public careers portal on its own sub-domain
 * (`https://{tenant}.darwinbox.in/ms/candidate/careers`). That portal is an
 * Angular SPA whose candidate backend (`/ms/candidateapi/...`) returns the
 * tenant's open roles in a `{status, data}` JSON envelope. We fetch once and
 * slice client-side to honour `resultsWanted`.
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g.
 * `dbox`) or by `companyUrl`. The candidate backend sits behind a Cloudflare
 * WAF / Turnstile bot gate, so an anonymous request may return an HTTP 403
 * challenge interstitial instead of JSON; that, an unknown sub-domain (HTTP
 * 4xx), or a malformed payload all degrade to an empty result rather than
 * throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.DARWINBOX,
  name: 'Darwinbox',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class DarwinboxService implements IScraper {
  private readonly logger = new Logger(DarwinboxService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Darwinbox scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Darwinbox tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(DARWINBOX_HEADERS);

    const resultsWanted = input.resultsWanted ?? DARWINBOX_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      // Resolve the live host (region) for this tenant, then fetch its jobs.
      const host = await this.resolveHost(client, tenant);
      if (!host) {
        this.logger.warn(`Could not resolve a live Darwinbox host for "${tenant}"`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Fetching Darwinbox jobs for tenant: ${tenant} (${host})`);

      const { jobs, companyName } = await this.fetchJobs(client, host, tenant);
      this.collect(jobs, companyName, host, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Darwinbox total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Darwinbox scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Resolve the live regional host for a tenant. Most tenants live on
   * `.darwinbox.in`; some global tenants live on `.darwinbox.com`. We probe the
   * public careers portal on each host and accept the first that responds 2xx.
   */
  private async resolveHost(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<string | null> {
    const encoded = encodeURIComponent(tenant);
    for (const template of DARWINBOX_HOST_TEMPLATES) {
      const host = template.replace('{tenant}', encoded);
      try {
        const response = await client.get<string>(`${host}${DARWINBOX_CAREERS_PATH}`, {
          responseType: 'text',
        });
        const status = (response as any)?.status;
        if (status === undefined || (status >= 200 && status < 300)) {
          return host;
        }
      } catch (err: any) {
        const status = err?.response?.status;
        // A 403 is the Cloudflare bot gate, not "tenant missing": the host is
        // live, so still treat it as resolvable and let fetchJobs try the API.
        if (status === 403) return host;
        if (status && status >= 400 && status < 500) {
          this.logger.warn(`Darwinbox host ${host} not found for "${tenant}" (HTTP ${status})`);
          continue;
        }
        // Network / DNS error on this region — try the next host template.
        this.logger.warn(`Darwinbox host ${host} unreachable: ${err.message}`);
      }
    }
    return null;
  }

  /**
   * Fetch the tenant's open roles from the candidate API. Tries each candidate
   * job-list path until one yields a well-formed envelope; returns an empty
   * list (never throws) on bot-gate / 4xx / malformed responses.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    tenant: string,
  ): Promise<{ jobs: DarwinboxJob[]; companyName: string }> {
    for (const path of DARWINBOX_JOB_LIST_PATHS) {
      const url = `${host}${DARWINBOX_API_BASE}${path}?subdomain=${encodeURIComponent(tenant)}`;
      try {
        const response = await client.get<DarwinboxApiResponse>(url, {
          headers: { Referer: `${host}${DARWINBOX_CAREERS_PATH}` },
        });
        const envelope = response.data;
        const jobs = this.extractJobs(envelope);
        if (jobs.length > 0 || this.isSuccessEnvelope(envelope)) {
          const companyName = this.deriveCompanyName(this.extractCompanyName(envelope), tenant);
          return { jobs, companyName };
        }
      } catch (err: any) {
        const status = err?.response?.status;
        // 403 = Cloudflare bot gate; 4xx = wrong endpoint/tenant. Both are
        // soft failures: try the next candidate path, then degrade to empty.
        if (status && status >= 400 && status < 500) {
          this.logger.warn(`Darwinbox ${path} for "${tenant}" returned HTTP ${status}`);
          continue;
        }
        throw err;
      }
    }
    this.logger.warn(`Darwinbox: no job-list endpoint yielded jobs for "${tenant}"`);
    return { jobs: [], companyName: this.deriveCompanyName(null, tenant) };
  }

  /** Pull the jobs array out of the (loosely-typed) candidate-API envelope. */
  private extractJobs(envelope: DarwinboxApiResponse | null | undefined): DarwinboxJob[] {
    if (!envelope) return [];
    const data = envelope.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const d = data as DarwinboxJobListData;
      const candidates = [d.jobs, d.jobList, d.job_list, d.data, d.results];
      for (const c of candidates) {
        if (Array.isArray(c)) return c;
      }
    }
    return [];
  }

  private isSuccessEnvelope(envelope: DarwinboxApiResponse | null | undefined): boolean {
    const status = envelope?.status;
    return typeof status === 'string' && status.toLowerCase() === 'success';
  }

  private extractCompanyName(envelope: DarwinboxApiResponse | null | undefined): string | null {
    const data = envelope?.data;
    if (data && !Array.isArray(data) && typeof data === 'object') {
      const d = data as DarwinboxJobListData;
      return d.company_name ?? d.companyName ?? null;
    }
    return null;
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: DarwinboxJob[],
    companyName: string,
    host: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of jobs) {
      try {
        const post = this.processJob(job, companyName, host, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Darwinbox job ${job?.id}: ${err.message}`);
      }
    }
  }

  private processJob(
    job: DarwinboxJob,
    companyName: string,
    host: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title =
      job.job_title ?? job.jobTitle ?? job.title ?? job.name ?? job.designation ?? null;
    if (!title) return null;

    const atsId = String(
      job.id ?? job.job_id ?? job.jobId ?? job.vacancy_id ?? job.job_key ?? job.jobKey ?? '',
    );
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(job, host, atsId);
    if (!jobUrl) return null;

    const rawHtml =
      job.description_html ??
      job.descriptionHtml ??
      job.job_description ??
      job.jobDescription ??
      job.description ??
      null;
    const rawText = job.description_text ?? job.descriptionText ?? null;
    const description = this.formatDescription(rawHtml, rawText, format);

    return new JobPostDto({
      id: `darwinbox-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(
        job.posted_on ??
          job.postedOn ??
          job.job_posted_on ??
          job.created_at ??
          job.createdAt ??
          job.updated_at ??
          job.updatedAt,
      ),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.DARWINBOX,
      atsId,
      atsType: 'darwinbox',
      department: this.extractDepartment(job),
      employmentType:
        job.employment_type ?? job.employmentType ?? job.job_type ?? job.jobType ?? null,
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. Darwinbox roles carry an
   * HTML body; we prefer HTML so markdown / plain conversion is consistent,
   * falling back to a plain-text body when only that is present.
   */
  private formatDescription(
    html: string | null,
    text: string | null,
    format?: DescriptionFormat,
  ): string | null {
    if (html) {
      if (format === DescriptionFormat.HTML) return html;
      if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
      return htmlToPlainText(html);
    }
    if (text) {
      // Only a plain-text body is available; surface it as-is for every format.
      return text;
    }
    return null;
  }

  /**
   * Resolve the Darwinbox tenant sub-domain label from an explicit
   * `companySlug` or from a `companyUrl` (the leading host label of a
   * `*.darwinbox.in` / `*.darwinbox.com` URL, else the first meaningful label).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const host = u.host.split(':')[0];
        const labels = host.split('.').filter(Boolean);
        const first = labels[0];
        // For a `{tenant}.darwinbox.in` host the first non-`www` label is the
        // tenant; for a bare `darwinbox.in` URL there is no tenant.
        if (first && first !== 'www' && !DARWINBOX_HOST_SUFFIXES.includes(host)) {
          if (first !== 'darwinbox') return first;
        }
        if (labels[1] && labels[1] !== 'darwinbox') return labels[1];
        // Fall back to the trailing path segment for embed-style URLs.
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments.length > 0) return segments[segments.length - 1];
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  /** Build the public apply / job-detail page URL. */
  private buildJobUrl(job: DarwinboxJob, host: string, atsId: string): string | null {
    const explicit =
      job.apply_url ??
      job.applyUrl ??
      job.job_url ??
      job.jobUrl ??
      job.url ??
      job.link ??
      null;
    if (typeof explicit === 'string' && explicit.trim()) {
      const trimmed = explicit.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
      return `${host}${path}`;
    }
    // Reconstruct the canonical careers detail URL from the job id/key.
    const key = job.job_key ?? job.jobKey ?? atsId;
    if (key) {
      return `${host}${DARWINBOX_CAREERS_PATH}/${encodeURIComponent(String(key))}`;
    }
    return null;
  }

  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : tenant) || tenant;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Darwinbox exposes a free-text `location` string plus optional structured
   * `city`/`state`/`country` parts. `region` maps to the state/region slot.
   */
  private extractLocation(job: DarwinboxJob): LocationDto | null {
    const city = typeof job.city === 'string' && job.city.trim() ? job.city.trim() : null;
    const state =
      typeof job.state === 'string' && job.state.trim()
        ? job.state.trim()
        : typeof job.region === 'string' && job.region.trim()
          ? job.region.trim()
          : null;
    const country =
      typeof job.country === 'string' && job.country.trim() ? job.country.trim() : null;
    if (!city && !state && !country) {
      const loc =
        (typeof job.location === 'string' && job.location.trim()) ||
        (typeof job.job_location === 'string' && job.job_location.trim()) ||
        (typeof job.jobLocation === 'string' && job.jobLocation.trim()) ||
        '';
      if (loc) return new LocationDto({ city: loc });
      return null;
    }
    return new LocationDto({ city, state, country });
  }

  /** Use the structured department / function label as the department. */
  private extractDepartment(job: DarwinboxJob): string | null {
    const dept =
      job.department ?? job.department_name ?? job.departmentName ?? job.function ?? null;
    if (typeof dept === 'string' && dept.trim()) return dept.trim();
    return null;
  }

  /** Detect remote roles from the work-mode flag, location text, or title. */
  private detectRemote(job: DarwinboxJob): boolean {
    const flag = job.is_remote ?? job.isRemote;
    if (flag === true) return true;
    if (typeof flag === 'string' && /^(true|yes|1)$/i.test(flag.trim())) return true;

    const haystacks: Array<string | null | undefined> = [
      job.work_mode,
      job.workMode,
      job.location,
      job.job_location,
      job.jobLocation,
      job.city,
      job.job_title ?? job.jobTitle ?? job.title ?? job.name,
      job.employment_type ?? job.employmentType ?? job.job_type ?? job.jobType,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) {
        return true;
      }
    }
    return false;
  }

  /** Parse an ISO-8601 / `YYYY-MM-DD` string into a YYYY-MM-DD string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
