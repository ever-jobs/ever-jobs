/**
 * The pre-Spec-1711 scraper of the legacy HTML search page, kept reachable
 * with `BDJOBS_MODE=html` so no behaviour is removed. It is never an automatic
 * fallback: the legacy page now redirects to a script-rendered shell with no
 * job cards, so falling back would only double the failed requests.
 *
 * Moved from `bdjobs.service.ts` as it was, then patched:
 * - the deadline no longer feeds `datePosted`, and card dates are parsed
 *   without building a `Date` from free text;
 * - company, location and date read the first matching element instead of
 *   concatenating every match;
 * - the seen-id check runs before the detail page is fetched;
 * - pages are capped at `BDJOBS_MAX_PAGES` and the loop stops on a page that
 *   adds no new ids, so a server that ignores `pg` cannot loop forever;
 * - a first page that is the new site's shell (or a challenge) reports a
 *   diagnostic instead of looking like an empty board;
 * - requests identify themselves with the honest User-Agent.
 */
import { Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Country,
  DescriptionFormat,
  Site,
  looksLikeChallenge,
} from '@ever-jobs/models';
import {
  createHttpClient,
  markdownConverter,
  removeAttributes,
  parseLocationText,
  randomSleep,
} from '@ever-jobs/common';
import {
  BDJOBS_ALLOWED_REDIRECT_HOSTS,
  BDJOBS_DEFAULT_RESULTS_WANTED,
  BDJOBS_JOB_SELECTORS,
  BDJOBS_LEGACY_BASE_URL,
  BDJOBS_LEGACY_HTML_HEADERS,
  BDJOBS_LEGACY_SEARCH_URL,
  BDJOBS_MAX_PAGES,
  BDJOBS_SEARCH_PARAMS,
  BDJOBS_USER_AGENT,
} from './bdjobs.constants';
import { parseBdjobsCalendarDate } from './bdjobs.parse';

/** The new site's script-rendered shell, served where the legacy page used to be. */
const SPA_SHELL_RE = /<base\s+href=["']?\/h\//i;

/** @deprecated Legacy HTML path only (`BDJOBS_MODE=html`). */
export class BdjobsLegacyHtmlScraper {
  private readonly baseUrl = BDJOBS_LEGACY_BASE_URL;
  private readonly searchUrl = BDJOBS_LEGACY_SEARCH_URL;
  private readonly delay = 2;
  private readonly bandDelay = 3;

  constructor(private readonly logger: Logger) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      userAgent: input.userAgent,
      // The factory reads `requestTimeout` when `proxies` is set and
      // `timeout` otherwise, so both carry the value.
      timeout: input.requestTimeout,
      requestTimeout: input.requestTimeout,
      allowedRedirectHosts: BDJOBS_ALLOWED_REDIRECT_HOSTS,
    });
    client.setHeaders({
      ...BDJOBS_LEGACY_HTML_HEADERS,
      'User-Agent': input.userAgent?.trim() || BDJOBS_USER_AGENT,
    });

    const jobList: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const resultsWanted = input.resultsWanted ?? BDJOBS_DEFAULT_RESULTS_WANTED;
    const seenIds = new Set<string>();
    let page = 1;

    const params = { ...BDJOBS_SEARCH_PARAMS, txtsearch: input.searchTerm ?? '' };

    while (jobList.length < resultsWanted && page <= BDJOBS_MAX_PAGES) {
      this.logger.log(`Fetching BDJobs page ${page} (legacy HTML)`);

      try {
        const reqParams: Record<string, any> = { ...params };
        if (page > 1) reqParams.pg = page;

        const response = await client.get(this.searchUrl, {
          params: reqParams,
          timeout: (input.requestTimeout ?? 60) * 1000,
        });

        if (response.status !== 200) {
          this.logger.error(`BDJobs response status ${response.status}`);
          break;
        }

        const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const $ = cheerio.load(html);
        const jobCards = this.findJobListings($);

        if (jobCards.length === 0) {
          this.logger.log('No more BDJobs listings found');
          if (page === 1) diagnostics = this.diagnoseEmptyFirstPage(html);
          break;
        }

        let newIds = 0;
        for (let i = 0; i < jobCards.length && jobList.length < resultsWanted; i++) {
          try {
            const card = $(jobCards[i]);
            const jobPost = this.buildJob(card);
            if (!jobPost || seenIds.has(jobPost.id!)) continue;
            seenIds.add(jobPost.id!);
            newIds++;
            await this.addDetails(jobPost, client, input);
            jobList.push(jobPost);
          } catch (err: any) {
            this.logger.warn(`BDJobs process error: ${err.message}`);
          }
        }

        if (newIds === 0) {
          this.logger.log(`BDJobs legacy page ${page} added no new listings; stopping`);
          break;
        }

        page++;
        await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
      } catch (err: any) {
        this.logger.error(`BDJobs scrape error: ${err.message}`);
        diagnostics = classifyScrapeError(err);
        break;
      }
    }

    return new JobResponseDto(jobList.slice(0, resultsWanted), diagnostics);
  }

  /**
   * A first page with no cards used to read as an empty board. The legacy
   * page now serves the new site's shell, which is a failure, not a result.
   */
  private diagnoseEmptyFirstPage(html: string): ScrapeDiagnostics | undefined {
    if (looksLikeChallenge(html)) {
      return new ScrapeDiagnostics('blocked', 'challenge page instead of the legacy search page');
    }
    if (SPA_SHELL_RE.test(html)) {
      return new ScrapeDiagnostics(
        'fetch_error',
        'legacy search page now serves the new site shell; unset BDJOBS_MODE to use the JSON API',
      );
    }
    return undefined;
  }

  private findJobListings($: cheerio.CheerioAPI): any[] {
    for (const selector of BDJOBS_JOB_SELECTORS) {
      const [tag, className] = selector.split('.');
      const elements = $(tag + (className ? `.${className}` : '')).toArray();
      if (elements.length > 0) return elements;
    }

    // Fallback: find parent elements of job detail links
    const links = $('a[href*="jobdetail" i]').toArray();
    return links.length > 0 ? links.map((link) => (link as any).parent || link) : [];
  }

  /** Map one card to a job from the card alone (no request). */
  private buildJob(card: cheerio.Cheerio<any>): JobPostDto | null {
    const jobLink = card.find('a[href*="jobdetail" i]').first();
    if (!jobLink.length) return null;

    let jobUrl = jobLink.attr('href') ?? '';
    if (!jobUrl.startsWith('http')) {
      jobUrl = `${this.baseUrl}/${jobUrl.replace(/^\//, '')}`;
    }

    const jobId = jobUrl.includes('jobid=')
      ? jobUrl.split('jobid=')[1]?.split('&')[0] ?? `bdjobs-${this.hashCode(jobUrl)}`
      : `bdjobs-${this.hashCode(jobUrl)}`;

    const title = jobLink.text().trim() || 'N/A';

    // Company
    const companyEl = card.find('[class*="comp-name" i], [class*="company" i]').first();
    const companyName = companyEl.text().trim() || 'N/A';

    // Location
    const locationEl = card.find('[class*="locon" i], [class*="location" i]').first();
    const locationText = locationEl.text().trim() || 'Dhaka, Bangladesh';
    const parsedLocation = parseLocationText(locationText).location;
    const location = new LocationDto({
      city: parsedLocation?.city ?? null,
      state: parsedLocation?.state ?? null,
      country: parsedLocation?.country ?? Country.BANGLADESH,
    });

    // Date: a posting date only. A deadline is never a posting date.
    const dateEl = card.find('[class*="date" i]').not('[class*="deadline" i]').first();
    const datePosted = dateEl.length ? this.parseDate(dateEl.text().trim()) : null;

    // Remote check
    const remoteKeywords = ['remote', 'work from home', 'wfh', 'home based'];
    const isRemote = remoteKeywords.some((kw) => `${title} ${location.displayLocation()}`.toLowerCase().includes(kw));

    return new JobPostDto({
      id: jobId,
      title,
      companyName,
      location,
      locations: [location],
      datePosted,
      jobUrl,
      isRemote,
      site: Site.BDJOBS,
    });
  }

  /** Fetch the detail page for a job that is known to be new. */
  private async addDetails(jobPost: JobPostDto, client: any, input: ScraperInputDto): Promise<void> {
    try {
      const details = await this.getJobDetails(client, jobPost.jobUrl, input.descriptionFormat);
      if (details.description) jobPost.description = details.description;
      if (details.jobType) jobPost.jobType = details.jobType;
      if (details.companyIndustry) jobPost.companyIndustry = details.companyIndustry;
    } catch {
      // Ignore description fetch failures
    }
  }

  private async getJobDetails(
    client: any,
    jobUrl: string,
    format?: DescriptionFormat,
  ): Promise<{ description?: string; jobType?: any; companyIndustry?: string }> {
    const response = await client.get(jobUrl, { timeout: 60000 });
    if (response.status !== 200) return {};

    const $ = cheerio.load(response.data);

    // Description
    let description = '';
    const jobContentDiv = $('div.jobcontent');
    if (jobContentDiv.length) {
      const respHeading = jobContentDiv.find('h4#job_resp, h4:contains("Responsibilities"), h5:contains("Responsibilities")');
      if (respHeading.length) {
        const parts: string[] = [];
        let sibling = respHeading.next();
        while (sibling.length && !['hr', 'h4', 'h5'].includes(String(sibling.prop('tagName') ?? '').toLowerCase())) {
          if (sibling.is('ul')) {
            sibling.find('li').each((_, li) => { parts.push($(li).text().trim()); });
          } else if (sibling.is('p')) {
            parts.push(sibling.text().trim());
          }
          sibling = sibling.next();
        }
        description = parts.join('\n');
      }
    }

    if (!description) {
      const descEl = $('[class*="job-description" i], [class*="details" i], [class*="requirements" i]');
      if (descEl.length) {
        description = removeAttributes(descEl.html() ?? '');
        if (format === DescriptionFormat.MARKDOWN) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    return { description: description || undefined };
  }

  /**
   * A card date → `YYYY-MM-DD`. Text naming a deadline is refused outright
   * (it used to be stripped of its label and returned as the posting date),
   * and the layouts in `BDJOBS_DATE_FORMATS` are parsed from their parts.
   */
  private parseDate(dateText: string): string | null {
    if (/deadline/i.test(dateText)) return null;
    return parseBdjobsCalendarDate(dateText.replace(/^(?:posted(?:\s+on)?|date)\s*:?\s*/i, ''));
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }
}
