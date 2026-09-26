import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site,
} from '@ever-jobs/models';
import { createHttpClient, randomSleep } from '@ever-jobs/common';
import {
  BDJOBS_ALLOWED_REDIRECT_HOSTS,
  BDJOBS_DEFAULT_DESCRIPTION_DEPTH,
  BDJOBS_DEFAULT_RESULTS_WANTED,
  BDJOBS_DEFAULT_TIMEOUT_S,
  BDJOBS_DESCRIPTION_BUDGET,
  BDJOBS_DETAIL_DELAY_MAX_MS,
  BDJOBS_DETAIL_DELAY_MIN_MS,
  BDJOBS_DETAIL_MAX_CONSECUTIVE_FAILURES,
  BDJOBS_DETAIL_TIME_BUDGET_MS,
  BDJOBS_DETAILS_URL,
  BDJOBS_HEADERS,
  BDJOBS_MAX_PAGES,
  BDJOBS_PAGE_DELAY_MAX_MS,
  BDJOBS_PAGE_DELAY_MIN_MS,
  BDJOBS_PAGE_HEADROOM,
  BDJOBS_PAGE_SIZE,
  BDJOBS_SEARCH_URL,
  BDJOBS_USER_AGENT,
  BDJOBS_WORKPLACE_REMOTE,
} from './bdjobs.constants';
import { BdjobsLegacyHtmlScraper } from './bdjobs.legacy-html';
import {
  applyDetails,
  bdjobsJobId,
  interpretDetailBody,
  interpretSearchBody,
  isHomeWorkplace,
  mapListItem,
  publishInstantMs,
  resolveBdjobsMode,
} from './bdjobs.parse';
import { BdjobsListItem } from './bdjobs.types';

type BdjobsClient = ReturnType<typeof createHttpClient>;

interface KeptJob {
  id: string;
  job: JobPostDto;
  item: BdjobsListItem;
}

/**
 * bdjobs.com, Bangladesh's largest job board (Spec 1711).
 *
 * Scrapes the public JSON search and details API. The legacy HTML search page
 * this plugin used to parse now redirects to a script-rendered shell, which
 * made the source return zero jobs with no diagnostic; that path is still
 * selectable with `BDJOBS_MODE=html` (see `bdjobs.legacy-html.ts`).
 *
 * Politeness: one host at a time, pages and details fetched sequentially with
 * delays, a page cap, a details budget in both calls and wall-clock time, and
 * an honest User-Agent.
 */
@SourcePlugin({
  site: Site.BDJOBS,
  name: 'BDJobs',
  category: 'regional',
  description: 'Bangladesh job board (public JSON search + details API)',
})
@Injectable()
export class BDJobsService implements IScraper {
  private readonly logger = new Logger(BDJobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const { mode, unrecognised } = resolveBdjobsMode(process.env);
    if (unrecognised) {
      this.logger.warn(`BDJobs: unrecognised BDJOBS_MODE "${unrecognised}"; using the JSON API`);
    }
    if (mode === 'html') {
      this.logger.log('BDJobs: BDJOBS_MODE=html selects the legacy HTML path');
      return new BdjobsLegacyHtmlScraper(this.logger).scrape(input);
    }
    return this.scrapeApi(input);
  }

  private async scrapeApi(input: ScraperInputDto): Promise<JobResponseDto> {
    const startedAt = Date.now();
    const resultsWanted = Math.max(0, Math.floor(input.resultsWanted ?? BDJOBS_DEFAULT_RESULTS_WANTED));
    if (resultsWanted === 0) return new JobResponseDto([]);

    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const startPage = Math.floor(offset / BDJOBS_PAGE_SIZE) + 1;
    let toSkip = offset % BDJOBS_PAGE_SIZE;
    const pagesNeeded = Math.ceil((toSkip + resultsWanted) / BDJOBS_PAGE_SIZE) + BDJOBS_PAGE_HEADROOM;
    let lastPage = startPage - 1 + Math.min(pagesNeeded, BDJOBS_MAX_PAGES);

    const hoursOld = input.hoursOld && input.hoursOld > 0 ? input.hoursOld : null;
    const cutoffMs = hoursOld ? startedAt - hoursOld * 3_600_000 : null;

    const client = this.createClient(input);
    const baseParams = this.buildSearchParams(input);

    const kept: KeptJob[] = [];
    const seenIds = new Set<string>();
    let diagnostics: ScrapeDiagnostics | undefined;

    for (let page = startPage; page <= lastPage && kept.length < resultsWanted; page++) {
      if (page > startPage) await randomSleep(BDJOBS_PAGE_DELAY_MIN_MS, BDJOBS_PAGE_DELAY_MAX_MS);
      this.logger.log(`Fetching BDJobs search page ${page}`);

      let body: unknown;
      try {
        const response = await client.get(BDJOBS_SEARCH_URL, { params: { ...baseParams, pg: page } });
        body = response?.data;
      } catch (err: any) {
        this.logger.error(`BDJobs search page ${page} failed: ${err?.message ?? err}`);
        diagnostics = classifyScrapeError(err);
        break;
      }

      const result = interpretSearchBody(body);
      if (result.kind === 'error') {
        this.logger.warn(`BDJobs search page ${page}: ${result.diagnostics.detail ?? result.diagnostics.reason}`);
        diagnostics = result.diagnostics;
        break;
      }
      if (page === startPage && result.totalRecords === 0) {
        this.logger.log('BDJobs search found no matching jobs');
        break;
      }
      if (result.totalPages !== null) lastPage = Math.min(lastPage, result.totalPages);
      if (result.rows.length === 0) {
        this.logger.log(`BDJobs search page ${page} is empty; stopping`);
        break;
      }

      let newIds = 0;
      for (const { item, premium } of result.rows) {
        const id = bdjobsJobId(item.Jobid);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        newIds++;
        if (toSkip > 0) {
          toSkip--;
          continue;
        }
        if (kept.length >= resultsWanted) continue;

        let job: JobPostDto | null;
        try {
          job = mapListItem(item, { fromPremium: premium, format: input.descriptionFormat });
        } catch (err: any) {
          this.logger.warn(`BDJobs: could not map job ${id}: ${err?.message ?? err}`);
          continue;
        }
        if (!job) {
          this.logger.debug(`BDJobs: skipping job ${id} with no title`);
          continue;
        }
        if (!this.passesFilters(item, job, input, cutoffMs)) continue;
        kept.push({ id, job, item });
      }

      if (newIds === 0) {
        this.logger.warn(`BDJobs search page ${page} repeated earlier ids; stopping`);
        break;
      }
    }

    if (kept.length > 0) {
      const detailDiagnostics = await this.enrichWithDetails(client, kept, input, startedAt);
      if (!diagnostics && detailDiagnostics) diagnostics = detailDiagnostics;
    }

    this.logger.log(`BDJobs returned ${kept.length} jobs`);
    return new JobResponseDto(
      kept.map((k) => k.job),
      diagnostics,
    );
  }

  private createClient(input: ScraperInputDto): BdjobsClient {
    const timeout = input.requestTimeout ?? BDJOBS_DEFAULT_TIMEOUT_S;
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      userAgent: input.userAgent,
      // The factory reads `requestTimeout` when `proxies` is set and
      // `timeout` otherwise, so both carry the value.
      timeout,
      requestTimeout: timeout,
      retries: input.retries,
      retryDelay: input.retryDelay,
      retryBackoff: input.retryBackoff,
      retryMaxDelay: input.retryMaxDelay,
      rateDelayMin: input.rateDelayMin,
      rateDelayMax: input.rateDelayMax,
      allowedRedirectHosts: BDJOBS_ALLOWED_REDIRECT_HOSTS,
    });
    client.setHeaders({
      ...BDJOBS_HEADERS,
      'User-Agent': input.userAgent?.trim() || BDJOBS_USER_AGENT,
    });
    return client;
  }

  /** Query parameters the site's own request builder sends; empty ones are dropped. */
  private buildSearchParams(input: ScraperInputDto): Record<string, string | number> {
    const params: Record<string, string | number> = { rpp: BDJOBS_PAGE_SIZE, isPro: 0 };
    const keyword = input.searchTerm?.trim();
    if (keyword) params.keyword = keyword;
    if (input.isRemote === true) params.workplace = BDJOBS_WORKPLACE_REMOTE;
    return params;
  }

  /**
   * Client-side filters. The board orders by relevance and ad tier, not date,
   * so `hoursOld` is judged on every row. A row whose job type or posting time
   * is unknown is kept.
   */
  private passesFilters(
    item: BdjobsListItem,
    job: JobPostDto,
    input: ScraperInputDto,
    cutoffMs: number | null,
  ): boolean {
    // The server is asked for work-from-home rows; this is the defence if it
    // ever ignores the filter.
    if (input.isRemote === true && !isHomeWorkplace(item.WorkPlace)) return false;
    if (input.jobType && job.jobType && !job.jobType.includes(input.jobType)) return false;
    if (cutoffMs !== null) {
      const postedMs = publishInstantMs(item.publishDate);
      if (postedMs !== null && postedMs < cutoffMs) return false;
    }
    return true;
  }

  private resolveDetailBudget(depth: string | undefined): number {
    const key = depth && depth in BDJOBS_DESCRIPTION_BUDGET ? depth : BDJOBS_DEFAULT_DESCRIPTION_DEPTH;
    return BDJOBS_DESCRIPTION_BUDGET[key];
  }

  /**
   * Sequential details pass over the kept jobs only. Stops at the depth budget,
   * once the wall-clock budget (measured from the start of the scrape) is
   * spent, or after a run of consecutive failures; jobs not reached keep their
   * list-only fields. One failure is only logged. When every attempted call
   * failed (two or more), the error is returned as a diagnostic so a dead
   * details host is visible.
   */
  private async enrichWithDetails(
    client: BdjobsClient,
    kept: KeptJob[],
    input: ScraperInputDto,
    startedAt: number,
  ): Promise<ScrapeDiagnostics | undefined> {
    const budget = this.resolveDetailBudget(input.descriptionDepth);
    let attempted = 0;
    let failed = 0;
    let consecutiveFailures = 0;
    let lastError: unknown;

    for (const entry of kept) {
      if (attempted >= budget) break;
      if (Date.now() - startedAt >= BDJOBS_DETAIL_TIME_BUDGET_MS) {
        this.logger.warn(
          `BDJobs details time budget spent; ${kept.length - attempted} jobs keep list-only fields`,
        );
        break;
      }
      if (consecutiveFailures >= BDJOBS_DETAIL_MAX_CONSECUTIVE_FAILURES) {
        this.logger.warn(`BDJobs details failing repeatedly; skipping the remaining ${kept.length - attempted}`);
        break;
      }
      if (attempted > 0) await randomSleep(BDJOBS_DETAIL_DELAY_MIN_MS, BDJOBS_DETAIL_DELAY_MAX_MS);
      attempted++;

      try {
        const response = await client.get(BDJOBS_DETAILS_URL, { params: { jobId: entry.id, ln: 1 } });
        const outcome = interpretDetailBody(response?.data);
        if (outcome.kind === 'malformed') {
          throw new Error('unexpected details response shape');
        }
        consecutiveFailures = 0;
        if (outcome.kind === 'ok') {
          applyDetails(entry.job, entry.item, outcome.detail, input.descriptionFormat);
        } else {
          this.logger.warn(`BDJobs details for job ${entry.id}: ${outcome.kind.replace('_', ' ')}; keeping list fields`);
        }
      } catch (err: any) {
        failed++;
        consecutiveFailures++;
        lastError = err;
        this.logger.warn(`BDJobs details for job ${entry.id} failed: ${err?.message ?? err}`);
      }
    }

    if (attempted >= 2 && failed === attempted) {
      return classifyScrapeError(lastError);
    }
    return undefined;
  }
}
