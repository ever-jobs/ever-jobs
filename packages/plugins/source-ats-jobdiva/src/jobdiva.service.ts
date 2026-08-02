import * as cheerio from 'cheerio';
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
  toDateOnly,
} from '@ever-jobs/common';
import {
  JOBDIVA_DEFAULT_HOST,
  JOBDIVA_CANDIDATE_FEED_PATH,
  JOBDIVA_EMPLOYER_FEED_PATH,
  JOBDIVA_PORTAL_PATH,
  JOBDIVA_PORTAL_PARAM,
  JOBDIVA_PORTAL_KEY_REGEX,
  JOBDIVA_DEFAULT_RESULTS,
  JOBDIVA_HEADERS,
} from './jobdiva.constants';
import { JobDivaFeed, JobDivaJob } from './jobdiva.types';

/**
 * JobDiva ATS / staffing portal scraper — generic, multi-tenant.
 *
 * JobDiva (jobdiva.com, USA) serves every customer's open roles through public
 * candidate-portal XML feeds on the shared portal cluster
 * (`www1`/`www2`/`www3.jobdiva.com`). Each tenant is addressed by one opaque
 * portal key passed as `?a={portalId}` — the tenant's public read key. The feed
 * returns the full open-roles list in one `<outertag>` envelope (`<jobs>/<job>`)
 * — there is no server-side pagination, so we fetch once and slice client-side
 * to honour `resultsWanted`.
 *
 * The caller addresses a tenant by `companySlug` (the bare portal key, or a
 * `{host}|{portalId}` pair) or by `companyUrl` (a portal / feed URL whose `a`
 * query parameter is the portal key). The adapter fetches the candidate feed
 * first (full `<jobdescription>` body) and falls back to the employer "connect"
 * feed (richer structured location) when the first yields no roles.
 *
 * A single fetch error, an unknown / dead portal key (HTTP 4xx), or a malformed
 * payload degrades to an empty result rather than throwing, so a single tenant
 * never nukes a batch run. De-duplication is by `atsId` within the run.
 */
@SourcePlugin({
  site: Site.JOBDIVA,
  name: 'JobDiva',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class JobDivaService implements IScraper {
  private readonly logger = new Logger(JobDivaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for JobDiva scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant || !tenant.portalId) {
      this.logger.warn('Could not resolve a JobDiva portal key from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JOBDIVA_HEADERS);

    const resultsWanted = input.resultsWanted ?? JOBDIVA_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching JobDiva jobs for portal key: ${tenant.portalId}`);

      // Primary: the candidate feed (full <jobdescription> body). Fall back to
      // the employer "connect" feed (richer structured location) when the
      // candidate feed yields no roles.
      let feed = await this.fetchFeed(client, tenant.host, JOBDIVA_CANDIDATE_FEED_PATH, tenant.portalId);
      if (!feed || feed.jobs.length === 0) {
        feed = await this.fetchFeed(client, tenant.host, JOBDIVA_EMPLOYER_FEED_PATH, tenant.portalId);
      }

      const jobs = feed?.jobs ?? [];
      const companyName = this.deriveCompanyName(jobs, tenant.portalId);

      this.collect(jobs, tenant, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`JobDiva total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`JobDiva scrape error for ${tenant.portalId}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /**
   * Fetch and parse one public XML jobs feed for a tenant. Returns null when the
   * portal key is unknown (HTTP 4xx) or the payload is unparseable; an empty
   * `jobs[]` is returned for a valid-but-empty feed.
   */
  private async fetchFeed(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    path: string,
    portalId: string,
  ): Promise<JobDivaFeed | null> {
    const url = `${host}${path}`;
    try {
      const response = await client.get<string>(url, {
        params: { [JOBDIVA_PORTAL_PARAM]: portalId },
        responseType: 'text',
      });
      const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (!xml) {
        this.logger.warn(`JobDiva feed "${path}" returned an empty body for ${portalId}`);
        return null;
      }
      return this.parseFeed(xml);
    } catch (err: any) {
      // An unknown / dead portal key returns HTTP 404 (or other 4xx); treat that
      // as "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`JobDiva feed "${path}" not found (HTTP ${status}) for ${portalId}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse the raw XML string into structured jobs. Uses cheerio in XML mode so
   * element names are preserved. Returns an empty feed on any parse failure.
   */
  private parseFeed(xml: string): JobDivaFeed {
    try {
      const $ = cheerio.load(xml, { xmlMode: true });

      const systemTime = $('outertag > systemtime').first().text().trim() || null;

      const jobs: JobDivaJob[] = [];
      $('outertag jobs > job').each((_i, el) => {
        const $el = $(el);
        const get = (tag: string): string | null => {
          const v = $el.find(tag).first().text().trim();
          return v || null;
        };
        jobs.push({
          ID: get('ID'),
          jobdivaid: get('jobdivaid'),
          jobdiva_no: get('jobdiva_no'),
          optional_ref: get('optional_ref'),
          portal_url: get('portal_url'),
          title: get('title'),
          location: get('location'),
          city: get('city'),
          state: get('state'),
          state_abbr: get('state_abbr'),
          countryid: get('countryid'),
          issuedate: get('issuedate'),
          startdate: get('startdate'),
          enddate: get('enddate') ?? get('endddate'),
          division: get('division'),
          division2: get('division2'),
          positiontype: get('positiontype'),
          experience_level: get('experience_level'),
          ratemin: get('ratemin'),
          ratemax: get('ratemax'),
          rateper: get('rateper'),
          onsiteflexibility: get('onsiteflexibility'),
          primary_recruiter: get('primary_recruiter'),
          jobdescription: get('jobdescription'),
          jobdescription_400char: get('jobdescription_400char'),
          company: get('company'),
        });
      });

      return { systemTime, jobs };
    } catch (err: any) {
      this.logger.warn(`JobDiva XML parse error: ${err.message}`);
      return { systemTime: null, jobs: [] };
    }
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: JobDivaJob[],
    tenant: ResolvedTenant,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of jobs) {
      try {
        const post = this.processJob(job, tenant, companyName, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing JobDiva job ${job?.jobdivaid}: ${err.message}`);
      }
    }
  }

  private processJob(
    job: JobDivaJob,
    tenant: ResolvedTenant,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title?.trim();
    if (!title) return null;

    const atsId = String(job.jobdivaid ?? job.jobDivaId ?? job.jobdiva_no ?? job.jobDivaNo ?? '').trim();
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(job, tenant);
    if (!jobUrl) return null;

    const rawHtml = job.jobdescription ?? job.jobDescription ?? null;
    const rawShort = job.jobdescription_400char ?? job.jobDescription400char ?? null;
    const description = this.formatDescription(rawHtml ?? rawShort, format);

    const resolvedCompany =
      (typeof job.company === 'string' && job.company.trim() ? job.company.trim() : '') || companyName;

    return new JobPostDto({
      id: `jobdiva-${atsId}`,
      title,
      companyName: resolvedCompany,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.issuedate ?? job.issueDate ?? job.startdate ?? job.startDate),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.JOBDIVA,
      atsId,
      atsType: 'jobdiva',
      department: this.extractDepartment(job),
      employmentType: job.positiontype ?? job.positionType ?? null,
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The candidate feed inlines
   * an HTML body (`<jobdescription>`); the employer feed offers only a truncated
   * body. We prefer HTML so markdown / plain conversion is consistent.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the JobDiva tenant from an explicit `companySlug` or from a
   * `companyUrl`. A tenant is a `{host, portalId}` pair: the opaque portal key
   * (`?a={portalId}`) plus the portal host that serves it.
   *
   * `companySlug` accepted forms:
   *  - bare portal key (`a7jdnw…`) → default host `www1.jobdiva.com`.
   *  - `{host}|{portalId}` pair (e.g. `www2.jobdiva.com|a7jdnw…`).
   *  - a full portal / feed URL with an `a=` query parameter.
   * `companyUrl`: any JobDiva portal / feed URL whose `a` query parameter is the
   * portal key; the URL's origin is used as the host when it is a JobDiva host.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): ResolvedTenant | null {
    // 1. companySlug first.
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();

      // Full URL passed as the slug.
      if (/^https?:\/\//i.test(slug)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }

      // `{host}|{portalId}` pair.
      if (slug.includes('|')) {
        const [hostPart, keyPart] = slug.split('|', 2).map((s) => s.trim());
        const portalId = this.extractPortalKey(keyPart);
        if (portalId) {
          return { host: this.normaliseHost(hostPart) ?? JOBDIVA_DEFAULT_HOST, portalId };
        }
      }

      // Bare portal key (or a `a=…` fragment).
      const portalId = this.extractPortalKey(slug);
      if (portalId) {
        return { host: JOBDIVA_DEFAULT_HOST, portalId };
      }
    }

    // 2. companyUrl.
    if (companyUrl && companyUrl.trim()) {
      const fromUrl = this.tenantFromUrl(companyUrl.trim());
      if (fromUrl) return fromUrl;
    }

    return null;
  }

  /** Resolve a tenant from a portal / feed URL carrying an `a=` query param. */
  private tenantFromUrl(raw: string): ResolvedTenant | null {
    try {
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const portalId = u.searchParams.get(JOBDIVA_PORTAL_PARAM) ?? this.extractPortalKey(raw);
      if (!portalId) return null;
      const host = /jobdiva\.com$/i.test(u.host) ? `${u.protocol}//${u.host}` : JOBDIVA_DEFAULT_HOST;
      return { host, portalId };
    } catch {
      return null;
    }
  }

  /**
   * Pull a portal key out of a bare token or a URL/query fragment. A bare key is
   * a long URL-safe alphanumeric token; otherwise we match the `a=` parameter.
   */
  private extractPortalKey(token: string | undefined): string | null {
    if (!token) return null;
    const trimmed = token.trim();
    if (!trimmed) return null;
    const match = trimmed.match(JOBDIVA_PORTAL_KEY_REGEX);
    if (match && match[1]) return match[1];
    // Bare key: alphanumeric, reasonably long (portal keys are ~40+ chars, but
    // accept ≥ 8 to tolerate cross-tenant variation).
    if (/^[A-Za-z0-9]{8,}$/.test(trimmed)) return trimmed;
    return null;
  }

  /** Normalise a bare host label into a `https://…jobdiva.com` origin. */
  private normaliseHost(host: string | undefined): string | null {
    if (!host) return null;
    const trimmed = host.trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const u = new URL(trimmed);
        return `${u.protocol}//${u.host}`;
      } catch {
        return null;
      }
    }
    return `https://${trimmed}`;
  }

  /**
   * Build the public apply / portal URL. Prefer the item's `<portal_url>`; else
   * reconstruct the canonical candidate-portal URL from the tenant portal key.
   */
  private buildJobUrl(job: JobDivaJob, tenant: ResolvedTenant): string | null {
    const link = job.portal_url ?? job.portalUrl;
    if (typeof link === 'string' && link.trim()) {
      const trimmed = link.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
      return `${tenant.host}${path}`;
    }
    // Fall back to the tenant candidate-portal landing page.
    return `${tenant.host}${JOBDIVA_PORTAL_PATH}?${JOBDIVA_PORTAL_PARAM}=${encodeURIComponent(tenant.portalId)}`;
  }

  /**
   * Derive a display company name: prefer the first item's `<company>` (employer
   * feed), else a readable label from the portal key.
   */
  private deriveCompanyName(jobs: JobDivaJob[], portalId: string): string {
    for (const job of jobs) {
      if (typeof job.company === 'string' && job.company.trim()) return job.company.trim();
    }
    return `JobDiva ${portalId.slice(0, 8)}`;
  }

  /**
   * Build a LocationDto. The employer feed exposes structured
   * `<city>`/`<state>`/`<state_abbr>`/`<countryid>`; the candidate feed exposes
   * only a free-text `<location>` ("City, STATE") which we split.
   */
  private extractLocation(job: JobDivaJob): LocationDto | null {
    const city = typeof job.city === 'string' && job.city.trim() ? job.city.trim() : null;
    const state =
      (typeof job.state === 'string' && job.state.trim() ? job.state.trim() : null) ??
      (typeof job.state_abbr === 'string' && job.state_abbr.trim() ? job.state_abbr.trim() : null);
    const country =
      typeof job.countryid === 'string' && job.countryid.trim() ? job.countryid.trim() : null;

    if (city || state || country) {
      return new LocationDto({ city, state, country });
    }

    // Fall back to the free-text "City, STATE" location label.
    const label = typeof job.location === 'string' ? job.location.trim() : '';
    if (!label) return null;
    const parts = label
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return new LocationDto({ city: parts[0] });
    return new LocationDto({ city: parts[0], state: parts[1], country: parts[2] ?? null });
  }

  /** Use the first advertising division as the department. */
  private extractDepartment(job: JobDivaJob): string | null {
    const div = job.division ?? job.division2;
    if (typeof div === 'string' && div.trim()) return div.trim();
    return null;
  }

  /**
   * Detect remote roles. JobDiva carries an `<onsiteflexibility>` percentage
   * (`0` = fully remote on some tenants, `100` = fully on-site) plus textual
   * remote signals in the location, title, or position type.
   */
  private detectRemote(job: JobDivaJob): boolean {
    const haystacks: Array<string | null | undefined> = [
      job.location,
      job.city,
      job.title,
      job.positiontype ?? job.positionType,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('work from home') ||
        v.includes('wfh') ||
        v.includes('telecommute')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Parse a JobDiva date value into a `YYYY-MM-DD` string. Accepts ISO-8601 /
   * RFC-1123 strings and numeric epoch milliseconds (JobDiva often emits epoch
   * timestamps in its feeds).
   */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    try {
      const trimmed = String(value).trim();
      // Numeric epoch (seconds or milliseconds).
      if (/^\d{10,13}$/.test(trimmed)) {
        const ms = trimmed.length <= 10 ? Number(trimmed) * 1000 : Number(trimmed);
        const d = new Date(ms);
        if (!isNaN(d.getTime())) return toDateOnly(ms);
      }
      const parsed = new Date(trimmed);
      if (!isNaN(parsed.getTime())) return toDateOnly(trimmed);
    } catch {
      // ignore
    }
    return null;
  }
}

/** A resolved JobDiva tenant: portal key plus the host that serves its feeds. */
interface ResolvedTenant {
  host: string;
  portalId: string;
}
