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
  RECOOTY_HOST,
  RECOOTY_WIDGET_PATH_TEMPLATE,
  RECOOTY_DEFAULT_LANGUAGE,
  RECOOTY_CAREER_PAGE_BASE,
  RECOOTY_DEFAULT_RESULTS,
  RECOOTY_HEADERS,
} from './recooty.constants';
import { RecootyJobPost, RecootyTeam, RecootyWidgetResponse } from './recooty.types';

/**
 * Recooty ATS careers scraper — generic, multi-tenant.
 *
 * Recooty serves every customer's open roles through one shared public Job
 * Widget feed (`GET https://standaloneapi.recooty.app/api/widget/{widgetId}`).
 * The widget id is a dashboard-issued token that acts as the tenant's public
 * read API key; the feed returns the full open-roles list in one envelope
 * (`team.jobPosts`) — there is no server-side pagination, so we fetch once and
 * slice client-side to honour `resultsWanted`.
 *
 * The tenant widget id is taken from `companySlug` or derived from a custom
 * `companyUrl` (its last path segment or first sub-domain label). A single fetch
 * error, an unknown widget id (HTTP 422/400/404 from the feed), or a malformed
 * payload degrades to an empty result rather than throwing, so a single tenant
 * never nukes a batch run.
 */
@SourcePlugin({
  site: Site.RECOOTY,
  name: 'Recooty',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class RecootyService implements IScraper {
  private readonly logger = new Logger(RecootyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Recooty scraper');
      return new JobResponseDto([]);
    }

    const widgetId = this.resolveWidgetId(companySlug, input.companyUrl);
    if (!widgetId) {
      this.logger.warn('Could not resolve a Recooty widget id from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(RECOOTY_HEADERS);

    const resultsWanted = input.resultsWanted ?? RECOOTY_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Recooty jobs for widget: ${widgetId}`);

      // The feed returns every open role for the tenant in a single envelope.
      const envelope = await this.fetchWidget(client, widgetId);
      const team = envelope?.team ?? null;
      const careerBase = this.normalizeBase(envelope?.career_page_url) ?? RECOOTY_CAREER_PAGE_BASE;
      const companyName = this.deriveCompanyName(team, widgetId);
      const jobs = Array.isArray(team?.jobPosts) ? team!.jobPosts! : [];

      this.collect(jobs, team, careerBase, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Recooty total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Recooty scrape error for ${widgetId}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /** Fetch the tenant's widget envelope from the public feed. */
  private async fetchWidget(
    client: ReturnType<typeof createHttpClient>,
    widgetId: string,
  ): Promise<RecootyWidgetResponse | null> {
    const path = RECOOTY_WIDGET_PATH_TEMPLATE.replace('{widgetId}', encodeURIComponent(widgetId));
    const url = `${RECOOTY_HOST}${path}?language=${encodeURIComponent(RECOOTY_DEFAULT_LANGUAGE)}`;
    try {
      const response = await client.get<RecootyWidgetResponse>(url);
      const data = response.data;
      // An invalid widget id returns HTTP 422 with { error: true, message }.
      if (!data || data.error) {
        this.logger.warn(`Recooty widget "${widgetId}" rejected: ${data?.message ?? 'no payload'}`);
        return null;
      }
      return data;
    } catch (err: any) {
      // An unknown / dead widget id returns HTTP 422 (or 400/404); treat that as
      // "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status === 422 || status === 400 || status === 404) {
        this.logger.warn(`Recooty widget "${widgetId}" not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: RecootyJobPost[],
    team: RecootyTeam | null,
    careerBase: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of jobs) {
      try {
        const post = this.processJob(job, team, careerBase, companyName, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Recooty job ${job?.id}: ${err.message}`);
      }
    }
  }

  private processJob(
    job: RecootyJobPost,
    team: RecootyTeam | null,
    careerBase: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title ?? job.job_title;
    if (!title) return null;

    const atsId = String(job.id ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(job, team, careerBase, atsId);
    const applyUrl = job.apply_url ?? `${jobUrl}/apply`;

    const rawDescription = job.description ?? job.job_description ?? null;
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

    return new JobPostDto({
      id: `recooty-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.published_at ?? job.created_at),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.RECOOTY,
      atsId,
      atsType: 'recooty',
      department: this.extractDepartment(job),
      employmentType: job.employment_type ?? null,
      applyUrl,
    });
  }

  /**
   * Resolve the Recooty widget id from an explicit `companySlug` or from a
   * custom `companyUrl` (its last meaningful path segment, else the first
   * sub-domain label).
   */
  private resolveWidgetId(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const segments = u.pathname.split('/').filter(Boolean);
        // A widget id is the trailing path segment of a custom widget/embed URL.
        const widgetIdx = segments.indexOf('widget');
        if (widgetIdx >= 0 && segments[widgetIdx + 1]) return segments[widgetIdx + 1];
        if (segments.length > 0) return segments[segments.length - 1];
        // Otherwise fall back to the first sub-domain label.
        const host = u.host.split(':')[0];
        const label = host.split('.')[0];
        if (label && label !== 'www') return label;
      } catch {
        // Malformed URL — no widget id recoverable.
      }
    }
    return '';
  }

  /** Build the public job-detail page URL (`{careerBase}{teamSlug}/{jobSlug}`). */
  private buildJobUrl(
    job: RecootyJobPost,
    team: RecootyTeam | null,
    careerBase: string,
    atsId: string,
  ): string {
    const teamSlug = team?.slug ? encodeURIComponent(team.slug) : '';
    const jobSlug = job.slug ? encodeURIComponent(job.slug) : encodeURIComponent(atsId);
    const base = careerBase.endsWith('/') ? careerBase : `${careerBase}/`;
    if (teamSlug) return `${base}${teamSlug}/${jobSlug}`;
    return `${base}${jobSlug}`;
  }

  /** Normalise the feed's `career_page_url`, guarding against empties/whitespace. */
  private normalizeBase(careerPageUrl: string | null | undefined): string | null {
    if (typeof careerPageUrl !== 'string') return null;
    const trimmed = careerPageUrl.trim();
    return trimmed || null;
  }

  private deriveCompanyName(team: RecootyTeam | null, widgetId: string): string {
    const base = team?.name ?? team?.slug ?? widgetId;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Recooty splits location into `city`/`state` (free text); country is rare. */
  private extractLocation(job: RecootyJobPost): LocationDto | null {
    const city = typeof job.city === 'string' && job.city.trim() ? job.city.trim() : null;
    const state = typeof job.state === 'string' && job.state.trim() ? job.state.trim() : null;
    const country =
      typeof job.country === 'string' && job.country.trim() ? job.country.trim() : null;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** `department` may be a plain string or a structured `{ name }` object. */
  private extractDepartment(job: RecootyJobPost): string | null {
    const dept = job.department;
    if (typeof dept === 'string' && dept.trim()) return dept.trim();
    if (dept && typeof dept === 'object' && typeof dept.name === 'string' && dept.name.trim()) {
      return dept.name.trim();
    }
    if (typeof job.department_name === 'string' && job.department_name.trim()) {
      return job.department_name.trim();
    }
    return null;
  }

  /** Detect remote roles from `location_type` or the city/title text. */
  private detectRemote(job: RecootyJobPost): boolean {
    if (typeof job.location_type === 'string' && job.location_type.toUpperCase() === 'REMOTE') {
      return true;
    }
    const haystacks = [job.city, job.title ?? job.job_title];
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
