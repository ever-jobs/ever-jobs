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
} from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';
import {
  JIBE_PAGE_SIZE,
  JIBE_DEFAULT_RESULTS,
  JIBE_MAX_PAGES,
  JIBE_HEADERS,
  JIBE_REMOTE_REGEX,
  JIBE_REMOTE_LOCATION_TYPES,
  JIBE_JOBS_SEGMENT,
  buildJibeApiUrl,
  buildJibeJobUrl,
} from './jibe.constants';
import { JibeJobData, JibeJobsPage, JibeTarget } from './jibe.types';

/**
 * Jibe (iCIMS Talent Cloud) tenant scraper. The careers SPA lists jobs from a
 * same-origin JSON API — `{origin}/api/jobs?page=N` — which returns
 * `{ jobs: [{data: {...}}], totalCount }`, a fixed 10 jobs per page.
 *
 * The caller addresses a tenant by `companyUrl` (any page on the Jibe site;
 * its directory is used as the mount for detail URLs) or by `companySlug`
 * (the site host, or a full/partial URL). A fetch error or an unknown tenant
 * degrades to an empty/partial result rather than throwing, so a single
 * tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.JIBE,
  name: 'Jibe',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class JibeService implements IScraper {
  private readonly logger = new Logger(JibeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const target = this.resolveTarget(input.companySlug, input.companyUrl);
    if (!target) {
      this.logger.warn('Could not resolve a Jibe site from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JIBE_HEADERS);

    const resultsWanted = input.resultsWanted ?? JIBE_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];
    const seen = new Set<string>();

    try {
      for (let page = 1; page <= JIBE_MAX_PAGES; page++) {
        const envelope = await this.fetchJobsPage(client, target.origin, page);
        if (!envelope) break;
        const entries = envelope.jobs ?? [];
        if (entries.length === 0) break;

        for (const entry of entries) {
          const data = entry.data;
          const reqId = data?.req_id ?? data?.slug;
          if (!reqId || seen.has(reqId)) continue;
          seen.add(reqId);
          const post = this.toJobPost(data!, target);
          if (post) jobPosts.push(post);
          if (jobPosts.length >= resultsWanted) break;
        }

        if (jobPosts.length >= resultsWanted) break;
        if (entries.length < JIBE_PAGE_SIZE) break;
        const total = envelope.totalCount ?? envelope.count;
        if (total != null && page * JIBE_PAGE_SIZE >= total) break;
      }

      this.logger.log(`Jibe total: ${jobPosts.length} jobs for ${target.host}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted));
    } catch (err: any) {
      this.logger.error(`Jibe scrape error for ${target.host}: ${err.message}`);
      return new JobResponseDto(jobPosts, jobPosts.length ? undefined : classifyScrapeError(err)); // partial results
    }
  }

  /** Fetch one `/api/jobs` page; non-2xx, HTML, or a shape without `jobs` degrades to null. */
  private async fetchJobsPage(
    client: ReturnType<typeof createHttpClient>,
    origin: string,
    page: number,
  ): Promise<JibeJobsPage | null> {
    const url = buildJibeApiUrl(origin, page);
    try {
      const response = await client.get<string | JibeJobsPage>(url);
      const body = typeof response.data === 'string' ? (this.tryJson(response.data) as JibeJobsPage | null) : response.data;
      if (!body || !Array.isArray(body.jobs)) return null;
      return body;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Jibe API returned HTTP ${status} for ${origin} page=${page}`);
        return null;
      }
      throw err;
    }
  }

  private tryJson(text: string): unknown | null {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** Map one `jobs[].data` entry to a JobPostDto. */
  private toJobPost(data: JibeJobData, target: JibeTarget): JobPostDto | null {
    const slug = (data.slug ?? data.req_id ?? '').trim();
    if (!slug) return null;
    const title = (data.title ?? '').trim();
    if (!title) return null;

    const location = this.buildLocation(data);
    const applyUrl = this.clean(data.apply_url);
    const remote =
      JIBE_REMOTE_LOCATION_TYPES.has((data.location_type ?? '').toUpperCase()) ||
      JIBE_REMOTE_REGEX.test(data.full_location ?? '') ||
      JIBE_REMOTE_REGEX.test(title);

    return new JobPostDto({
      id: `jibe-${target.host}-${data.req_id ?? slug}`,
      title,
      companyName: this.clean(data.hiring_organization) ?? this.companyFromHost(target.host),
      jobUrl: buildJibeJobUrl(target.detailBase, slug),
      jobUrlDirect: applyUrl,
      location,
      description: data.description ?? null,
      isRemote: remote,
      site: Site.JIBE,
      atsId: (data.req_id ?? slug).trim(),
      atsType: 'jibe',
      department: this.department(data),
      employmentType: this.clean(data.employment_type),
      datePosted: this.clean(data.posted_date) ?? this.clean(data.create_date),
      applyUrl,
      companyUrl: target.origin,
    });
  }

  /** city/state/country from the job's location fields, else a Remote marker. */
  private buildLocation(data: JibeJobData): LocationDto | null {
    const city = this.clean(data.city);
    const state = this.clean(data.state);
    const country = this.clean(data.country);
    if (city || state || country) return new LocationDto({ city, state, country });
    return null;
  }

  /** `category` arrives as a string or a one-element list of display names. */
  private department(data: JibeJobData): string | null {
    const raw = data.category ?? data.categories;
    const value = Array.isArray(raw) ? raw[0] : raw;
    return this.clean(value);
  }

  /**
   * Resolve the tenant origin + detail-URL mount from a `companyUrl` (any Jibe
   * page — its directory is the mount, e.g. `…/careers-home/jobs` →
   * `…/careers-home`) or a `companySlug` (site host or full/partial URL).
   */
  private resolveTarget(companySlug: string | undefined, companyUrl: string | undefined): JibeTarget | null {
    const candidates = [companyUrl, companySlug];
    for (const candidate of candidates) {
      const target = this.targetFrom(candidate);
      if (target) return target;
    }
    return null;
  }

  private targetFrom(value: string | undefined): JibeTarget | null {
    const raw = (value ?? '').trim();
    if (!raw) return null;
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let parsed: URL;
    try {
      parsed = new URL(withScheme);
    } catch {
      return null;
    }
    if (!parsed.hostname || parsed.hostname.includes(' ') || !parsed.hostname.includes('.')) return null;
    const origin = parsed.origin;
    const mount = this.mountFromPath(parsed.pathname);
    return { origin, detailBase: `${origin}${mount}`, host: parsed.hostname.toLowerCase() };
  }

  /**
   * Site mount = everything before the last `jobs` path segment:
   * `/careers-home/jobs` and `/careers-home/jobs/33835` → `/careers-home`,
   * `/jobs` or `/` → `''`, a path with no `jobs` segment stays whole.
   */
  private mountFromPath(pathname: string): string {
    const segments = pathname.split('/').filter((s) => s.length > 0);
    const idx = segments.lastIndexOf(JIBE_JOBS_SEGMENT);
    const mount = idx >= 0 ? segments.slice(0, idx) : segments;
    return mount.length > 0 ? `/${mount.join('/')}` : '';
  }

  /** Display name from the site host: `careers.rivian.com` → `Rivian`. */
  private companyFromHost(host: string): string {
    const labels = host.split('.').filter(Boolean);
    const skip = new Set(['www', 'careers', 'jobs', 'careers-home', 'work', 'com', 'net', 'org', 'co', 'us', 'io']);
    const name = labels.find((l) => !skip.has(l)) ?? labels[0] ?? host;
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  private clean(value: string | null | undefined): string | null {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}
