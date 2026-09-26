import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  DatePostedBasis,
  DatePostedPrecision,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  HttpClient,
  PostedTime,
  postedAtAgreesWithDate,
  postedTimeFields,
  randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import {
  LINKEDIN_BASE_URL,
  LINKEDIN_HEADERS,
  LINKEDIN_LEGACY_PAGE_STEP,
  LINKEDIN_MAX_COMPANY_FETCHES,
  LINKEDIN_MAX_PAGES_WITHOUT_NEW,
  LINKEDIN_MAX_START,
  LINKEDIN_REQUEST_DELAY_BAND_S,
  LINKEDIN_REQUEST_DELAY_S,
  LINKEDIN_SEARCH_PATH,
  WORKPLACE_TYPE_CODES,
} from './linkedin.constants';
import { cardToJobPost, parseCompanyPage, parseJobDetail, parseSearchCards } from './linkedin.parser';
import type {
  LinkedInCompanyDetails,
  LinkedInJobDetail,
  LinkedInJobPost,
  LinkedInLegacyFlags,
  LinkedInScraperInput,
} from './linkedin.types';
import {
  companySlugFromUrl,
  jobTypeCode,
  linkedInBlockDiagnostics,
  linkedInBlockReason,
  resolveFetchCompanyDetails,
  resolveLinkedInLegacy,
} from './linkedin.utils';

type Pacer = () => Promise<void>;

interface SearchResult {
  jobs: LinkedInJobPost[];
  diagnostics?: ScrapeDiagnostics;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function responseText(data: unknown): string {
  return typeof data === 'string' ? data : '';
}

/** Set a field only when the job has none and there is a value (enrichment never overwrites). */
function fillIfEmpty<K extends keyof LinkedInJobPost>(
  job: LinkedInJobPost,
  key: K,
  value: LinkedInJobPost[K] | null | undefined,
): void {
  if (value !== null && value !== undefined && (job[key] === null || job[key] === undefined)) {
    job[key] = value;
  }
}

@SourcePlugin({
  site: Site.LINKEDIN,
  name: 'LinkedIn',
  category: 'job-board',
  // Spec 1700 — the plugin keeps 3-7 s between requests; hold location calls to the same floor.
  minRequestIntervalMs: LINKEDIN_REQUEST_DELAY_S * 1000,
})
@Injectable()
export class LinkedInService implements IScraper {
  private readonly logger = new Logger(LinkedInService.name);
  private readonly baseUrl = LINKEDIN_BASE_URL;
  private readonly delay = LINKEDIN_REQUEST_DELAY_S;
  private readonly bandDelay = LINKEDIN_REQUEST_DELAY_BAND_S;

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const client = createHttpClient(input);
    client.setHeaders(LINKEDIN_HEADERS);

    // Every request to linkedin.com in this call goes through one pacer, so
    // search pages, detail pages and company pages are all sequential with the
    // same 3-7 s gap between any two of them.
    const pace = this.createPacer();
    const legacy = resolveLinkedInLegacy();

    const search = await this.searchJobs(client, input, legacy, pace);
    const jobList = search.jobs;
    let diagnostics = search.diagnostics;
    const postedCounts = this.countPostedTimes(jobList);

    let upgraded = 0;
    if (input.linkedinFetchDescription) {
      const detail = await this.enrichFromDetailPages(client, jobList, input, legacy, pace);
      diagnostics = diagnostics ?? detail.diagnostics;
      upgraded = detail.upgraded;
    }

    if (resolveFetchCompanyDetails(input as LinkedInScraperInput)) {
      await this.enrichFromCompanyPages(client, jobList, pace);
    }

    this.logger.debug(
      `posted-time: ${postedCounts.relative} relative, ${postedCounts.dateOnly} date-only, ` +
        `${postedCounts.none} none, ${upgraded} upgraded from JSON-LD`,
    );

    return new JobResponseDto(jobList, diagnostics);
  }

  private createPacer(): Pacer {
    let requests = 0;
    return async () => {
      if (requests++ > 0) {
        await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
      }
    };
  }

  /**
   * Page through the guest search. `start` is an item offset that advances by
   * the number of cards on the page (Spec 1701), so no result is skipped. The
   * loop stops on an empty page, at the board's `start` cap, after
   * {@link LINKEDIN_MAX_PAGES_WITHOUT_NEW} pages with no new id, at
   * `resultsWanted`, or on an error — which is reported, never swallowed.
   */
  private async searchJobs(
    client: HttpClient,
    input: ScraperInputDto,
    legacy: LinkedInLegacyFlags,
    pace: Pacer,
  ): Promise<SearchResult> {
    const jobList: LinkedInJobPost[] = [];
    const seenIds = new Set<string>();
    const resultsWanted = input.resultsWanted ?? 15;
    const maxPagesWithoutNew = legacy.pagination ? 1 : LINKEDIN_MAX_PAGES_WITHOUT_NEW;
    let start = input.offset ?? 0;
    let pagesWithoutNew = 0;
    let diagnostics: ScrapeDiagnostics | undefined;

    while (jobList.length < resultsWanted) {
      if (start >= LINKEDIN_MAX_START) {
        this.logger.log(`LinkedIn guest search stops at offset ${LINKEDIN_MAX_START}`);
        break;
      }
      this.logger.log(`Fetching LinkedIn jobs, offset ${start}`);

      await pace();
      let html: string;
      let fetchedAt: number;
      try {
        const response = await client.get(`${this.baseUrl}${LINKEDIN_SEARCH_PATH}`, {
          params: this.buildSearchParams(input, start),
        });
        fetchedAt = Date.now();
        const blocked = linkedInBlockDiagnostics(response, `start=${start}`);
        if (blocked) {
          diagnostics = blocked;
          this.logger.warn(`LinkedIn search blocked: ${blocked.detail}`);
          break;
        }
        html = responseText(response.data);
      } catch (err: unknown) {
        diagnostics = linkedInBlockDiagnostics(err, `start=${start}`) ?? classifyScrapeError(err);
        this.logger.error(`LinkedIn scrape error at offset ${start}: ${errorMessage(err)}`);
        break;
      }

      const page = parseSearchCards(html);
      if (page.cardCount === 0) {
        this.logger.log('No more LinkedIn job results');
        break;
      }

      let newJobs = 0;
      for (const card of page.cards) {
        if (jobList.length >= resultsWanted) break;
        try {
          const jobPost = cardToJobPost(card, input, fetchedAt, legacy);
          if (jobPost?.id && !seenIds.has(jobPost.id)) {
            seenIds.add(jobPost.id);
            jobList.push(jobPost);
            newJobs++;
          }
        } catch (err: unknown) {
          this.logger.warn(`Error extracting LinkedIn job: ${errorMessage(err)}`);
        }
      }

      if (newJobs === 0) {
        pagesWithoutNew++;
        if (pagesWithoutNew >= maxPagesWithoutNew) {
          this.logger.log(`No new LinkedIn jobs on ${pagesWithoutNew} consecutive page(s), stopping`);
          break;
        }
      } else {
        pagesWithoutNew = 0;
      }

      start += legacy.pagination ? LINKEDIN_LEGACY_PAGE_STEP : page.cardCount;
    }

    return { jobs: jobList, diagnostics };
  }

  private buildSearchParams(input: ScraperInputDto, start: number): Record<string, string | number> {
    const params: Record<string, string | number> = {
      keywords: input.searchTerm ?? '',
      location: input.location ?? '',
      distance: input.distance ?? 50,
      start,
      sortBy: 'DD',
    };

    if (input.easyApply) {
      params['f_AL'] = 'true';
    }
    if (input.jobType) {
      const code = jobTypeCode(input.jobType);
      if (code) params['f_JT'] = code;
    }
    if (input.isRemote) {
      params['f_WT'] = WORKPLACE_TYPE_CODES.remote;
    }
    if (input.hoursOld) {
      params['f_TPR'] = `r${input.hoursOld * 3600}`;
    }
    if (input.linkedinCompanyIds && input.linkedinCompanyIds.length > 0) {
      params['f_C'] = input.linkedinCompanyIds.join(',');
    }

    return params;
  }

  /**
   * Fetch each job's view page (sequentially) and merge what it adds. A failed
   * page keeps the card-only job; the first failure is reported, and a block
   * stops the remaining fetches.
   */
  private async enrichFromDetailPages(
    client: HttpClient,
    jobList: LinkedInJobPost[],
    input: ScraperInputDto,
    legacy: LinkedInLegacyFlags,
    pace: Pacer,
  ): Promise<{ diagnostics?: ScrapeDiagnostics; upgraded: number }> {
    let diagnostics: ScrapeDiagnostics | undefined;
    let upgraded = 0;

    for (const job of jobList) {
      await pace();
      try {
        const response = await client.get(job.jobUrl);
        const blocked = linkedInBlockDiagnostics(response, `job ${job.id}`);
        if (blocked) {
          diagnostics = diagnostics ?? blocked;
          this.logger.warn(`LinkedIn job pages blocked, stopping detail fetches: ${blocked.detail}`);
          break;
        }
        const detail = parseJobDetail(responseText(response.data), input.descriptionFormat, {
          legacyDetail: legacy.detail,
          legacyPay: legacy.pay,
        });
        if (this.mergeDetail(job, detail)) upgraded++;
      } catch (err: unknown) {
        const blocked = linkedInBlockDiagnostics(err, `job ${job.id}`);
        diagnostics = diagnostics ?? blocked ?? classifyScrapeError(err);
        this.logger.warn(`Error fetching description for ${job.jobUrl}: ${errorMessage(err)}`);
        if (blocked) break;
      }
    }

    return { diagnostics, upgraded };
  }

  /**
   * Detail values override the card for pay, job type, level, function and
   * industry; logo, company id, applicants and the offsite apply URL only fill
   * gaps. Returns whether the posting time was upgraded to an exact instant.
   */
  private mergeDetail(job: LinkedInJobPost, detail: LinkedInJobDetail): boolean {
    if (detail.description !== null) {
      job.description = detail.description;
      job.emails = extractEmails(detail.description);
    }
    job.jobLevel = detail.jobLevel ?? job.jobLevel;
    job.companyIndustry = detail.companyIndustry ?? job.companyIndustry;
    job.jobType = detail.jobType ?? job.jobType;
    if (detail.jobFunction) job.jobFunction = detail.jobFunction;
    if (detail.compensation) job.compensation = detail.compensation;

    fillIfEmpty(job, 'companyLogo', detail.companyLogo);
    fillIfEmpty(job, 'companySourceId', detail.companySourceId);
    fillIfEmpty(job, 'jobUrlDirect', detail.jobUrlDirect);
    if (detail.applicants && (job.applicantsCount === null || job.applicantsCount === undefined)) {
      job.applicantsCount = detail.applicants.count;
      job.applicantsCountBound = detail.applicants.bound;
    }

    return this.upgradePostedTime(job, detail.posted);
  }

  /**
   * Spec 1696 §5.1b: the page's JSON-LD instant replaces the card estimate when
   * it is within a day of the card date. `datePosted` is never overwritten —
   * only filled when the card had none.
   */
  private upgradePostedTime(job: LinkedInJobPost, posted: PostedTime): boolean {
    if (posted.datePostedPrecision !== DatePostedPrecision.EXACT || !posted.datePostedAt) return false;

    const current =
      typeof job.datePosted === 'string'
        ? job.datePosted
        : job.datePosted instanceof Date
          ? toDateOnly(job.datePosted)
          : null;
    let next: PostedTime;
    if (current === null) {
      next = posted;
    } else if (postedAtAgreesWithDate(posted.datePostedAt, current)) {
      next = {
        datePosted: current,
        datePostedAt: posted.datePostedAt,
        datePostedPrecision: DatePostedPrecision.EXACT,
        datePostedBasis: DatePostedBasis.TIMESTAMP,
      };
    } else {
      return false;
    }

    const fields = postedTimeFields(next);
    Object.assign(job, fields);
    return fields.datePostedAt !== undefined;
  }

  /**
   * Opt-in company enrichment: one sequential GET per unique company slug,
   * capped at {@link LINKEDIN_MAX_COMPANY_FETCHES}, cached for this call
   * (failures as `null`). A block stops every remaining company fetch. It never
   * sets diagnostics: the job list is already complete.
   */
  private async enrichFromCompanyPages(client: HttpClient, jobList: LinkedInJobPost[], pace: Pacer): Promise<void> {
    const cache = new Map<string, LinkedInCompanyDetails | null>();
    let blocked = false;
    let skippedByCap = 0;

    for (const job of jobList) {
      const slug = companySlugFromUrl(job.companyUrl);
      if (!slug) continue;

      if (!cache.has(slug)) {
        if (blocked) continue;
        if (cache.size >= LINKEDIN_MAX_COMPANY_FETCHES) {
          skippedByCap++;
          continue;
        }
        await pace();
        try {
          const response = await client.get(`${this.baseUrl}/company/${slug}`);
          const reason = linkedInBlockReason(response);
          if (reason) {
            blocked = true;
            cache.set(slug, null);
            this.logger.warn(`LinkedIn company pages blocked (${reason}), stopping company fetches`);
            continue;
          }
          cache.set(slug, parseCompanyPage(responseText(response.data)));
        } catch (err: unknown) {
          cache.set(slug, null);
          const reason = linkedInBlockReason(err);
          if (reason) {
            blocked = true;
            this.logger.warn(`LinkedIn company pages blocked (${reason}), stopping company fetches`);
          } else {
            this.logger.warn(`Error fetching LinkedIn company ${slug}: ${errorMessage(err)}`);
          }
          continue;
        }
      }

      const details = cache.get(slug);
      if (details) this.mergeCompany(job, details);
    }

    if (skippedByCap > 0) {
      this.logger.log(`LinkedIn company enrichment capped at ${LINKEDIN_MAX_COMPANY_FETCHES} companies`);
    }
  }

  private mergeCompany(job: LinkedInJobPost, details: LinkedInCompanyDetails): void {
    fillIfEmpty(job, 'companyUrlDirect', details.website);
    fillIfEmpty(job, 'companyNumEmployees', details.sizeBand ?? details.employeesLd);
    fillIfEmpty(job, 'companyAddresses', details.address);
    fillIfEmpty(job, 'companyIndustry', details.industry);
    fillIfEmpty(job, 'companyDescription', details.description);
    fillIfEmpty(job, 'companyLogo', details.logo);
  }

  private countPostedTimes(jobList: LinkedInJobPost[]): { relative: number; dateOnly: number; none: number } {
    const counts = { relative: 0, dateOnly: 0, none: 0 };
    for (const job of jobList) {
      if (job.datePostedBasis === DatePostedBasis.RELATIVE) counts.relative++;
      else if (job.datePosted) counts.dateOnly++;
      else counts.none++;
    }
    return counts;
  }
}
