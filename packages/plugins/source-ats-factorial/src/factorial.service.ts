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
} from '@ever-jobs/common';
import {
  FACTORIAL_HOST_TEMPLATE,
  FACTORIAL_SITEMAP_PATH,
  FACTORIAL_JOB_DETAIL_PREFIX,
  FACTORIAL_APPLY_PREFIX,
  FACTORIAL_MAX_CONCURRENCY,
  FACTORIAL_REQUEST_DELAY_MS,
  FACTORIAL_DEFAULT_RESULTS,
  FACTORIAL_HEADERS,
} from './factorial.constants';
import { FactorialIndexJob, FactorialDetailJob } from './factorial.types';

/**
 * Factorial HRIS + ATS public career-page scraper — generic, multi-tenant.
 *
 * Factorial hosts a public career site for every tenant at
 * `https://{slug}.factorialhr.com`. The site is a server-rendered Rails
 * application; no anonymous JSON API is available. Job data is extracted from
 * two HTML surfaces:
 *
 *   1. The career-page index (`GET /`) — lists all open positions grouped by
 *      office, with job URL, title, remote flag, location ID and team ID
 *      embedded in `data-*` attributes on each `<li>` element. Lookup tables
 *      for ID → name are embedded in `<select>` elements.
 *
 *   2. Each job-detail page (`GET /job_posting/{slug}-{id}`) — contains the
 *      full HTML job description inside `<div class='styledText'>` and the
 *      apply link. Detail pages are fetched concurrently with a bounded
 *      `Promise.allSettled` fan-out.
 *
 *   3. The sitemap (`GET /sitemap.xml`) — provides `<lastmod>` dates for each
 *      job URL; used as the `datePosted` value.
 *
 * Tenant resolution: `companySlug` is used directly as the sub-domain label.
 * If absent, the first sub-domain label of `companyUrl` is used instead.
 *
 * A single fetch error, an unknown tenant (HTTP 400/404), or a malformed
 * page degrades to an empty/partial result rather than throwing, so a single
 * tenant never aborts a batch run.
 */
@SourcePlugin({
  site: Site.FACTORIAL,
  name: 'Factorial',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class FactorialService implements IScraper {
  private readonly logger = new Logger(FactorialService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Factorial scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(input.companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a Factorial tenant slug from input');
      return new JobResponseDto([]);
    }

    const host = FACTORIAL_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
    const companyName = this.deriveCompanyName(slug);
    const resultsWanted = input.resultsWanted ?? FACTORIAL_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(FACTORIAL_HEADERS);

    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Factorial career page for tenant: ${slug}`);

      // Fetch index page and sitemap concurrently.
      const [indexResult, sitemapResult] = await Promise.allSettled([
        this.fetchText(client, host + '/'),
        this.fetchText(client, host + FACTORIAL_SITEMAP_PATH),
      ]);

      const indexHtml =
        indexResult.status === 'fulfilled' ? indexResult.value : null;
      const sitemapXml =
        sitemapResult.status === 'fulfilled' ? sitemapResult.value : null;

      if (!indexHtml) {
        const reason =
          indexResult.status === 'rejected'
            ? String(indexResult.reason?.message ?? indexResult.reason)
            : 'empty response';
        this.logger.warn(`Factorial index page unavailable for ${slug}: ${reason}`);
        return new JobResponseDto([]);
      }

      // Build date map from sitemap (url → lastmod).
      const dateMap = sitemapXml ? this.parseSitemap(sitemapXml) : new Map<string, string>();

      // Parse all job entries from the index page.
      const indexJobs = this.parseIndexPage(indexHtml, host, dateMap);

      if (indexJobs.length === 0) {
        this.logger.log(`Factorial: no open positions found for ${slug}`);
        return new JobResponseDto([]);
      }

      const capped = indexJobs.slice(0, resultsWanted);

      // Fan out concurrent detail-page fetches.
      const seen = new Set<string>();
      const detailMap = await this.fetchDetails(client, capped);

      for (const indexJob of capped) {
        try {
          const detail = detailMap.get(indexJob.id) ?? null;
          const post = this.buildJobPost(
            indexJob,
            detail,
            host,
            companyName,
            input.descriptionFormat,
          );
          if (!post) continue;
          if (seen.has(post.atsId as string)) continue;
          seen.add(post.atsId as string);
          jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Factorial: error mapping job ${indexJob.id} for ${slug}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Factorial: ${jobPosts.length} jobs collected for ${companyName}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted));
    } catch (err: any) {
      this.logger.error(`Factorial scrape error for ${slug}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  /** Fetch a URL and return the response body as a string. */
  private async fetchText(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<string> {
    const response = await client.get<string>(url);
    return typeof response.data === 'string' ? response.data : String(response.data ?? '');
  }

  /**
   * Fetch all detail pages for the given jobs concurrently, in bounded chunks.
   * Returns a map from job id → FactorialDetailJob (only for successful fetches).
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    jobs: FactorialIndexJob[],
  ): Promise<Map<string, FactorialDetailJob>> {
    const result = new Map<string, FactorialDetailJob>();
    for (let i = 0; i < jobs.length; i += FACTORIAL_MAX_CONCURRENCY) {
      const chunk = jobs.slice(i, i + FACTORIAL_MAX_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map(async (job) => {
          const html = await this.fetchText(client, job.jobUrl);
          return { id: job.id, detail: this.parseDetailPage(html, job.jobUrl) };
        }),
      );
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          result.set(r.value.id, r.value.detail);
        } else {
          this.logger.warn(
            `Factorial detail fetch failed: ${r.reason?.message ?? r.reason}`,
          );
        }
      }
      if (i + FACTORIAL_MAX_CONCURRENCY < jobs.length) {
        await randomSleep(FACTORIAL_REQUEST_DELAY_MS, FACTORIAL_REQUEST_DELAY_MS * 2);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // HTML parsers
  // ---------------------------------------------------------------------------

  /**
   * Parse the career-page index HTML.
   *
   * Extracts job entries from `data-controller='job-postings'` elements grouped
   * under `data-target='job-filters.officeGroup'` headings. Builds ID-to-name
   * lookup maps from the `<select>` elements for locations and teams.
   */
  private parseIndexPage(
    html: string,
    host: string,
    dateMap: Map<string, string>,
  ): FactorialIndexJob[] {
    // Build location and team id→name lookup tables from <select> options.
    const locationMap = this.parseSelectOptions(html, 'location_filter');
    const teamMap = this.parseSelectOptions(html, 'team_filter');

    const jobs: FactorialIndexJob[] = [];

    // Split the page into office-group blocks.
    // Each block starts with data-target='job-filters.officeGroup' and
    // contains an h3 (office label) and one or more job list items.
    const groupPattern =
      /data-target='job-filters\.officeGroup'[^>]*>([\s\S]*?)(?=data-target='job-filters\.officeGroup'|<\/section>|<\/main>|<footer|<div id='footer')/g;

    let groupMatch: RegExpExecArray | null;
    while ((groupMatch = groupPattern.exec(html)) !== null) {
      const groupHtml = groupMatch[1];

      // Extract office label from the <h3> in this group.
      const h3Match = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(groupHtml);
      const officeLabel = h3Match ? this.stripTags(h3Match[1]).trim() : null;

      // Extract individual job entries within the group.
      const jobPattern =
        /data-controller='job-postings'\s+data-is-remote='([^']*)'\s+data-job-postings-url='([^']*)'\s+data-location-id='([^']*)'\s+data-target='[^']*'\s+data-team-id='([^']*)'\s+role='button'>([\s\S]*?)(?=<li\s+class='job-offer-item|<\/ul>)/g;

      let jobMatch: RegExpExecArray | null;
      while ((jobMatch = jobPattern.exec(groupHtml)) !== null) {
        const [, isRemoteRaw, jobUrl, locationId, teamId, innerHtml] = jobMatch;

        const id = this.extractIdFromUrl(jobUrl);
        if (!id) continue;

        const title = this.extractTitle(innerHtml);
        if (!title) continue;

        const contractType = this.extractDataAttr(
          html,
          jobUrl,
          'data-contract-type',
        );

        jobs.push({
          jobUrl,
          id,
          title,
          officeLabel: officeLabel ?? locationMap.get(locationId) ?? null,
          locationId: locationId || null,
          teamId: teamId || null,
          isRemote: isRemoteRaw === 'true',
          contractType: contractType ?? null,
          lastmod: dateMap.get(jobUrl) ?? null,
        });
      }
    }

    // Fallback: if the group-based approach yielded nothing (layout change),
    // fall back to a flat scan for data-controller='job-postings' elements.
    if (jobs.length === 0) {
      const flatPattern =
        /data-controller='job-postings'\s+data-is-remote='([^']*)'\s+data-job-postings-url='([^']*)'\s+data-location-id='([^']*)'\s+data-target='[^']*'\s+data-team-id='([^']*)'\s+role='button'>([\s\S]*?)(?=<li\s+class='job-offer-item|data-controller='job-postings'|<\/section>|<footer)/g;

      let flatMatch: RegExpExecArray | null;
      while ((flatMatch = flatPattern.exec(html)) !== null) {
        const [, isRemoteRaw, jobUrl, locationId, teamId, innerHtml] = flatMatch;
        const id = this.extractIdFromUrl(jobUrl);
        if (!id) continue;
        const title = this.extractTitle(innerHtml);
        if (!title) continue;
        const contractType = this.extractDataAttr(html, jobUrl, 'data-contract-type');
        jobs.push({
          jobUrl,
          id,
          title,
          officeLabel: locationMap.get(locationId) ?? null,
          locationId: locationId || null,
          teamId: teamId || null,
          isRemote: isRemoteRaw === 'true',
          contractType: contractType ?? null,
          lastmod: dateMap.get(jobUrl) ?? null,
        });
      }
    }

    // Attach team names from lookup map (when not already set via officeLabel).
    for (const job of jobs) {
      if (job.teamId && !teamMap.has(job.teamId)) continue;
    }

    return jobs;
  }

  /**
   * Parse a job-detail page HTML to extract description and apply URL.
   *
   * Description: the content of `<div class='styledText'>`.
   * Apply URL: the `href` of the first `<a>` whose text contains "Apply now".
   * Location label: text of the `<span>` sibling to a location icon `<li>`.
   * Team name: text inside `<li>` blocks in the sidebar.
   */
  private parseDetailPage(html: string, jobUrl: string): FactorialDetailJob {
    // Description: content of <div class='styledText'>
    const descMatch = /<div class='styledText'>([\s\S]*?)<\/div>/i.exec(html);
    const descriptionHtml = descMatch ? descMatch[1].trim() : null;

    // Apply URL: <a href='/apply/…'>Apply now</a>
    const applyMatch = /href='(\/apply\/[^']+)'/i.exec(html);
    let applyUrl: string | null = null;
    if (applyMatch) {
      const path = applyMatch[1];
      try {
        const base = new URL(jobUrl);
        applyUrl = `${base.protocol}//${base.host}${path}`;
      } catch {
        applyUrl = null;
      }
    }

    // Location label from sidebar: look for the location text after the
    // location icon svg. The sidebar has <li> rows with text after an <svg>.
    const locationMatch = /align-middle mr-2 ml-2'>([^<]{4,100})\s*<\/span>\s*<\/li>/g;
    let locationLabel: string | null = null;
    let teamName: string | null = null;
    let matchCount = 0;
    let m: RegExpExecArray | null;
    while ((m = locationMatch.exec(html)) !== null) {
      const text = m[1].trim();
      // First sidebar match tends to be contract type (e.g. "Permanent"),
      // second is schedule, third is location, fourth is team.
      matchCount++;
      if (matchCount === 3 && text && text.includes(',')) {
        locationLabel = text;
      }
      if (matchCount === 4 && text) {
        teamName = text;
      }
    }

    return { descriptionHtml, applyUrl, locationLabel, teamName };
  }

  /**
   * Parse `<lastmod>` dates from a sitemap XML string.
   * Returns a map from absolute job URL → YYYY-MM-DD date string.
   */
  private parseSitemap(xml: string): Map<string, string> {
    const map = new Map<string, string>();
    const urlPattern = /<url>([\s\S]*?)<\/url>/g;
    let m: RegExpExecArray | null;
    while ((m = urlPattern.exec(xml)) !== null) {
      const block = m[1];
      const locMatch = /<loc>([^<]+)<\/loc>/i.exec(block);
      const lastmodMatch = /<lastmod>([^<]+)<\/lastmod>/i.exec(block);
      if (locMatch && lastmodMatch) {
        const url = locMatch[1].trim();
        const date = lastmodMatch[1].trim().split('T')[0]; // ensure YYYY-MM-DD
        if (url.includes('/job_posting/')) {
          map.set(url, date);
        }
      }
    }
    return map;
  }

  /**
   * Parse `<option value='{id}'>{name}</option>` entries from a `<select>`
   * identified by its `id` attribute.
   */
  private parseSelectOptions(html: string, selectId: string): Map<string, string> {
    const map = new Map<string, string>();
    const selectPattern = new RegExp(
      `<select[^>]*id=['"]${selectId}['"][^>]*>([\\s\\S]*?)</select>`,
      'i',
    );
    const selectMatch = selectPattern.exec(html);
    if (!selectMatch) return map;

    const optionPattern = /<option[^>]*value='(\d+)'[^>]*>([^<]+)<\/option>/g;
    let m: RegExpExecArray | null;
    while ((m = optionPattern.exec(selectMatch[1])) !== null) {
      map.set(m[1], m[2].trim());
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // DTO builder
  // ---------------------------------------------------------------------------

  private buildJobPost(
    indexJob: FactorialIndexJob,
    detail: FactorialDetailJob | null,
    host: string,
    companyName: string,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const { id, title, jobUrl, isRemote, contractType, lastmod, teamId, locationId } =
      indexJob;
    if (!title || !id) return null;

    const rawDescription = detail?.descriptionHtml ?? null;
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

    const applyUrl = detail?.applyUrl ?? jobUrl;

    // Prefer the finer-grained detail location; fall back to office label.
    const locationLabel = detail?.locationLabel ?? indexJob.officeLabel ?? null;
    const location = locationLabel ? this.locationFromLabel(locationLabel) : null;

    // Department: prefer detail team name, then index team id lookup is done
    // externally so we just use what we have.
    const department = detail?.teamName ?? null;

    const remote = isRemote || this.detectRemoteFromTitle(title);

    return new JobPostDto({
      id: `factorial-${id}`,
      title,
      companyName,
      jobUrl,
      location,
      description,
      datePosted: lastmod ?? null,
      isRemote: remote,
      emails: extractEmails(description),
      site: Site.FACTORIAL,
      atsId: id,
      atsType: 'factorial',
      department,
      applyUrl,
    });
  }

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve the tenant sub-domain slug.
   * Prefer `companySlug`; fall back to the first label of `companyUrl`.
   */
  private resolveSlug(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const host = u.hostname.split(':')[0];
        const labels = host.split('.').filter(Boolean);
        const label = labels[0];
        if (label && label !== 'www') return label;
      } catch {
        // Malformed URL — no slug recoverable.
      }
    }
    return '';
  }

  /**
   * Extract the numeric job id from the trailing segment of the job-detail URL.
   * e.g. `/job_posting/ai-developer-304592` → `"304592"`.
   */
  private extractIdFromUrl(url: string): string {
    const lastSegment = url.split('/').pop() ?? '';
    const parts = lastSegment.split('-').filter(Boolean);
    const last = parts[parts.length - 1];
    return last && /^\d+$/.test(last) ? last : '';
  }

  /** Extract the job title from the inner HTML of a job-list-item. */
  private extractTitle(innerHtml: string): string {
    // Title is in the first bold div inside the list item.
    const m = /<div[^>]*font-bold[^>]*>([\s\S]*?)<\/div>/i.exec(innerHtml);
    return m ? this.stripTags(m[1]).trim() : '';
  }

  /**
   * Extract a specific `data-{attr}` value for a given job URL from the index
   * page HTML. The `data-contract-type` attribute appears on the enclosing
   * `<li>` element before the `data-controller='job-postings'` element.
   */
  private extractDataAttr(
    html: string,
    jobUrl: string,
    attr: string,
  ): string | null {
    const escapedUrl = jobUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `${attr.replace('-', '-')}='([^']*)'[^>]*(?:>|\\s)[\\s\\S]{0,400}${escapedUrl}`,
    );
    const m = pattern.exec(html);
    return m ? m[1] : null;
  }

  /** Convert a "City, State, Country" label into a LocationDto. */
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
    return new LocationDto({
      city: city ?? null,
      state: state ?? null,
      country: country ?? null,
    });
  }

  /** Derive a display company name from the slug (kebab-case → Title Case). */
  private deriveCompanyName(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Strip HTML tags from a string. */
  private stripTags(html: string): string {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Detect remote roles from the title when the `data-is-remote` flag is absent. */
  private detectRemoteFromTitle(title: string): boolean {
    const v = title.toLowerCase();
    return v.includes('remote') || v.includes('work from home') || v.includes('wfh');
  }
}
