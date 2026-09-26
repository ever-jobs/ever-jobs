import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto,
  LocationDto, CompensationDto, Country, DescriptionFormat, Site,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient, NaukriException, markdownConverter, extractEmails, htmlToPlainText, parseLocationText,
  randomSleep, toDateOnly,
} from '@ever-jobs/common';
import {
  NAUKRI_DEFAULT_DIAGNOSTICS,
  NAUKRI_DEFAULT_PARSER,
  NAUKRI_DEFAULT_TIMEOUT_S,
  NAUKRI_DIAGNOSTICS_ENV,
  NAUKRI_HEADERS,
  NAUKRI_JOBS_PER_PAGE,
  NAUKRI_MAX_PAGES,
  NAUKRI_ORIGIN,
  NAUKRI_PAGE_DELAY_BAND_S,
  NAUKRI_PAGE_DELAY_S,
  NAUKRI_PARSER_ENV,
  NAUKRI_SEARCH_URL,
  NaukriDiagnosticsMode,
  NaukriParserMode,
  parseNaukriMode,
} from './naukri.constants';
import {
  coerceNaukriBody,
  detectNaukriBlock,
  finiteNumberOrNull,
  naukriPostedCutoffDay,
  naukriSeoKey,
  parseNaukriLocationLabel,
  parseNaukriPostedDate,
  parseNaukriSalary,
  parseNaukriSkills,
  placeholderLabel,
  resolveNaukriUrl,
} from './naukri.parsers';
import { NaukriJobDetail, NaukriSearchResponse } from './naukri.types';

@SourcePlugin({
  site: Site.NAUKRI,
  name: 'Naukri',
  category: 'regional',
  // Spec 1720 — `urlType: search_by_keyword` + a `<term>-jobs` SEO key: an
  // empty term is a malformed search, not a listing.
  requiresSearchTerm: true,
  // Spec 1700 — the plugin keeps 3-7 s between pages; hold location calls to the same floor.
  minRequestIntervalMs: NAUKRI_PAGE_DELAY_S * 1000,
})
@Injectable()
export class NaukriService implements IScraper {
  private readonly logger = new Logger(NaukriService.name);
  private readonly baseUrl = NAUKRI_SEARCH_URL;
  private readonly jobsPerPage = NAUKRI_JOBS_PER_PAGE;
  private readonly delay = NAUKRI_PAGE_DELAY_S;
  private readonly bandDelay = NAUKRI_PAGE_DELAY_BAND_S;

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const parserMode: NaukriParserMode = this.resolveMode(NAUKRI_PARSER_ENV, NAUKRI_DEFAULT_PARSER);
    const diagnosticsMode: NaukriDiagnosticsMode = this.resolveMode(
      NAUKRI_DIAGNOSTICS_ENV,
      NAUKRI_DEFAULT_DIAGNOSTICS,
    );
    const legacy = parserMode === 'legacy';
    const reportBlocks = diagnosticsMode === 'current';

    // Always the input branch of the factory, so `requestTimeout`, `userAgent`,
    // `retries` and the rate delays are honoured, with or without proxies.
    const client = createHttpClient({
      ...input,
      requestTimeout: input.requestTimeout ?? NAUKRI_DEFAULT_TIMEOUT_S,
    });
    client.setHeaders(NAUKRI_HEADERS);
    if (input.userAgent) client.setHeaders({ 'user-agent': input.userAgent });

    const jobList: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const resultsWanted = input.resultsWanted ?? 15;
    const seenIds = new Set<string>();
    const offset = input.offset ?? 0;
    let page = Math.floor(offset / this.jobsPerPage) + 1;
    // Rows of the first fetched page that the offset already consumed.
    let skip = legacy ? 0 : offset % this.jobsPerPage;
    const now = Date.now();
    // Safety net: whether the endpoint honours `days` is unverified.
    const cutoffDay = !legacy && input.hoursOld ? naukriPostedCutoffDay(input.hoursOld, now) : null;
    let filtered = 0;

    while (jobList.length < resultsWanted && page <= NAUKRI_MAX_PAGES) {
      this.logger.log(`Fetching Naukri jobs, page ${page}`);

      try {
        const searchTerm = input.searchTerm ?? '';
        const params: Record<string, any> = {
          noOfResults: this.jobsPerPage,
          urlType: 'search_by_keyword',
          searchType: 'adv',
          keyword: searchTerm,
          pageNo: page,
          k: searchTerm,
          seoKey: legacy
            ? `${searchTerm.toLowerCase().replace(/\s+/g, '-')}-jobs`
            : naukriSeoKey(searchTerm),
          src: 'jobsearchDesk',
          latLong: '',
        };
        if (input.location) params.location = input.location;
        if (input.isRemote) params.remote = 'true';
        if (input.hoursOld) params.days = Math.ceil(input.hoursOld / 24);

        const response = await client.get(this.baseUrl, { params });
        const body = coerceNaukriBody(response?.data);

        if (reportBlocks) {
          const block = detectNaukriBlock(body);
          if (block) {
            this.logger.warn(`Naukri refused the search on page ${page}: ${block}`);
            diagnostics = new ScrapeDiagnostics('blocked', block);
            break;
          }
          if (typeof body === 'string') {
            this.logger.warn(`Naukri returned a non-JSON search response on page ${page}`);
            diagnostics = new ScrapeDiagnostics('fetch_error', 'naukri: non-JSON search response');
            break;
          }
        }

        const data = (body && typeof body === 'object' ? body : {}) as NaukriSearchResponse;
        const jobDetails = Array.isArray(data.jobDetails) ? data.jobDetails : [];
        if (jobDetails.length === 0) break;

        // Rows the offset consumed were served by an earlier call: remember their
        // ids so a later duplicate of one is not returned as new.
        for (const consumed of jobDetails.slice(0, skip)) {
          const id = this.jobIdOf(consumed);
          if (id) seenIds.add(id);
        }
        const rows = skip > 0 ? jobDetails.slice(skip) : jobDetails;
        skip = 0;

        for (const job of rows) {
          if (jobList.length >= resultsWanted) break;
          const jobId = this.jobIdOf(job);
          if (!jobId || seenIds.has(jobId)) continue;
          seenIds.add(jobId);

          try {
            const jobPost = legacy
              ? this.processJobLegacy(job, jobId, input)
              : this.processJob(job, jobId, input, now);
            if (!jobPost) continue;
            if (
              cutoffDay &&
              typeof jobPost.datePosted === 'string' &&
              jobPost.datePosted < cutoffDay
            ) {
              filtered++;
              continue;
            }
            jobList.push(jobPost);
          } catch (err: any) {
            this.logger.warn(`Naukri process error for ${jobId}: ${err?.message ?? err}`);
          }
        }

        if (!legacy && this.isLastPage(data, page)) break;

        page++;
        if (jobList.length < resultsWanted && page <= NAUKRI_MAX_PAGES) {
          await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
        }
      } catch (err: any) {
        const block = reportBlocks ? detectNaukriBlock(err) : null;
        if (block) {
          // An expected state, not a fault: the board gates automated clients.
          this.logger.warn(`Naukri refused the search on page ${page}: ${block}`);
          diagnostics = new ScrapeDiagnostics('blocked', block);
        } else {
          this.logger.error(`Naukri scrape error: ${err?.message ?? err}`);
          diagnostics = classifyScrapeError(err);
        }
        break;
      }
    }

    if (filtered > 0) {
      this.logger.debug(`Naukri: dropped ${filtered} job(s) older than ${cutoffDay} (hoursOld)`);
    }

    return new JobResponseDto(jobList.slice(0, resultsWanted), diagnostics);
  }

  /** Mode from its env var (read on every call); an unknown value warns and uses the default. */
  private resolveMode(envName: string, fallback: 'current' | 'legacy'): 'current' | 'legacy' {
    const raw = process.env[envName];
    const mode = parseNaukriMode(raw, fallback);
    if (mode) return mode;
    this.logger.warn(`Ignoring unrecognised ${envName}="${raw}" (expected current|legacy); using ${fallback}`);
    return fallback;
  }

  /** A row's id as a trimmed string; `''` when missing. */
  private jobIdOf(job: NaukriJobDetail | null | undefined): string {
    const raw = job && typeof job === 'object' ? job.jobId : undefined;
    return raw === undefined || raw === null ? '' : String(raw).trim();
  }

  /** `noOfJobs` (unverified) as a stop hint: this page already reached it. */
  private isLastPage(data: NaukriSearchResponse, page: number): boolean {
    const total = finiteNumberOrNull(data.noOfJobs);
    return total !== null && total >= 0 && page * this.jobsPerPage >= total;
  }

  private processJob(
    job: NaukriJobDetail,
    jobId: string,
    input: ScraperInputDto,
    now: number,
  ): JobPostDto | null {
    const title = typeof job.title === 'string' && job.title.trim() ? job.title.trim() : 'N/A';
    const company =
      typeof job.companyName === 'string' && job.companyName.trim() ? job.companyName.trim() : 'N/A';
    const placeholders = Array.isArray(job.placeholders) ? job.placeholders : [];

    // Location, remote and hybrid come from the location chip only.
    const place = parseNaukriLocationLabel(placeholderLabel(placeholders, 'location'));

    // Compensation (Indian CTC labels)
    const compensation = parseNaukriSalary(placeholderLabel(placeholders, 'salary'));

    // Date (IST day)
    const datePosted = parseNaukriPostedDate(job.footerPlaceholderLabel, job.createdDate, now);

    // URLs: `jdURL` is usually site-relative, occasionally absolute.
    const jobUrl =
      resolveNaukriUrl(job.jdURL) ?? `${NAUKRI_ORIGIN}/job/${encodeURIComponent(jobId)}`;
    const companyUrl = resolveNaukriUrl(job.staticUrl);

    // Description (an HTML snippet)
    const rawDescription =
      typeof job.jobDescription === 'string' && job.jobDescription.trim() ? job.jobDescription : null;
    const plainText = rawDescription ? htmlToPlainText(rawDescription) : null;
    let description = rawDescription;
    if (rawDescription && input.descriptionFormat === DescriptionFormat.MARKDOWN) {
      description = markdownConverter(rawDescription) ?? rawDescription;
    } else if (rawDescription && input.descriptionFormat === DescriptionFormat.PLAIN) {
      description = plainText || null;
    }

    const vacancy = finiteNumberOrNull(job.vacancy);

    return new JobPostDto({
      id: `nk-${jobId}`,
      title,
      companyName: company,
      companyUrl,
      location: place.location,
      locations: place.locations,
      isRemote: place.isRemote,
      datePosted,
      jobUrl,
      compensation,
      description,
      emails: extractEmails(plainText),
      companyLogo: job.logoPathV3 ?? job.logoPath ?? null,
      skills: parseNaukriSkills(job.tagsAndSkills),
      experienceRange: job.experienceText ?? null,
      companyRating: finiteNumberOrNull(job.ambitionBoxData?.AggregateRating),
      companyReviewsCount: finiteNumberOrNull(job.ambitionBoxData?.ReviewsCount),
      vacancyCount: vacancy !== null && vacancy > 0 ? vacancy : null,
      workFromHomeType: place.workFromHomeType,
      site: Site.NAUKRI,
    });
  }

  // --- Pre-Spec-1712 mapping, kept for NAUKRI_PARSER=legacy --------------------

  private processJobLegacy(job: any, jobId: string, input: ScraperInputDto): JobPostDto | null {
    const title = job.title ?? 'N/A';
    const company = job.companyName ?? 'N/A';

    // Location
    const location = this.getLocation(job.placeholders ?? []);

    // Compensation (Indian salary format)
    const compensation = this.getCompensation(job.placeholders ?? []);

    // Date
    const datePosted = this.parseDate(job.footerPlaceholderLabel, job.createdDate);

    // URL
    const jobUrl = `https://www.naukri.com${job.jdURL ?? `/job/${jobId}`}`;

    // Description
    let description = job.jobDescription ?? null;
    if (description && input.descriptionFormat === DescriptionFormat.MARKDOWN) {
      description = markdownConverter(description) ?? description;
    }

    // Remote detection
    const remoteKeywords = ['remote', 'work from home', 'wfh'];
    const fullText = `${title} ${description ?? ''} ${location.displayLocation()}`.toLowerCase();
    const isRemote = remoteKeywords.some((kw) => fullText.includes(kw));

    // Work from home type
    const workFromHomeType = this.inferWorkFromHomeType(job.placeholders ?? [], title, description ?? '');

    // Skills
    const skills = job.tagsAndSkills
      ? job.tagsAndSkills.split(',').map((s: string) => s.trim())
      : null;

    return new JobPostDto({
      id: `nk-${jobId}`,
      title,
      companyName: company,
      companyUrl: job.staticUrl ? `https://www.naukri.com/${job.staticUrl}` : null,
      location,
      locations: [location],
      isRemote,
      datePosted: toDateOnly(datePosted),
      jobUrl,
      compensation,
      description,
      emails: extractEmails(description),
      companyLogo: job.logoPathV3 ?? job.logoPath ?? null,
      skills,
      experienceRange: job.experienceText ?? null,
      companyRating: job.ambitionBoxData?.AggregateRating ? parseFloat(job.ambitionBoxData.AggregateRating) : null,
      companyReviewsCount: job.ambitionBoxData?.ReviewsCount ?? null,
      vacancyCount: job.vacancy ?? null,
      workFromHomeType,
      site: Site.NAUKRI,
    });
  }

  private getLocation(placeholders: any[]): LocationDto {
    for (const p of placeholders) {
      if (p.type === 'location') {
        const parsed = parseLocationText(p.label ?? '').location;
        return new LocationDto({
          city: parsed?.city ?? null,
          state: parsed?.state ?? null,
          country: parsed?.country ?? Country.INDIA,
        });
      }
    }
    return new LocationDto({ country: Country.INDIA });
  }

  private getCompensation(placeholders: any[]): CompensationDto | null {
    for (const p of placeholders) {
      if (p.type === 'salary') {
        const text = (p.label ?? '').trim();
        if (text === 'Not disclosed') return null;

        const match = text.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(Lacs|Lakh|Cr)/i);
        if (!match) return null;

        let minSalary = parseFloat(match[1]);
        let maxSalary = parseFloat(match[2]);
        const unit = match[3].toLowerCase();

        if (unit === 'lacs' || unit === 'lakh') {
          minSalary *= 100000;
          maxSalary *= 100000;
        } else if (unit === 'cr') {
          minSalary *= 10000000;
          maxSalary *= 10000000;
        }

        return new CompensationDto({
          minAmount: Math.round(minSalary),
          maxAmount: Math.round(maxSalary),
          currency: 'INR',
        });
      }
    }
    return null;
  }

  private parseDate(label: string | null, createdDate: number | null): Date | null {
    const now = new Date();
    if (!label) {
      if (createdDate) return new Date(createdDate);
      return null;
    }
    const lbl = label.toLowerCase();
    if (lbl.includes('today') || lbl.includes('just now') || lbl.includes('few hours')) {
      return now;
    }
    if (lbl.includes('ago')) {
      const match = lbl.match(/(\d+)\s*day/);
      if (match) {
        const days = parseInt(match[1], 10);
        return new Date(now.getTime() - days * 86400000);
      }
    }
    if (createdDate) return new Date(createdDate);
    return null;
  }

  private inferWorkFromHomeType(placeholders: any[], title: string, description: string): string | null {
    const locStr = (placeholders.find((p: any) => p.type === 'location')?.label ?? '').toLowerCase();
    const fullText = `${locStr} ${title.toLowerCase()} ${description.toLowerCase()}`;
    if (fullText.includes('hybrid')) return 'Hybrid';
    if (fullText.includes('remote')) return 'Remote';
    if (fullText.includes('work from office')) return 'Work from office';
    return null;
  }
}
