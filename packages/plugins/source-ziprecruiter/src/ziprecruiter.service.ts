import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  looksLikeChallenge,
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto,
  LocationDto, CompensationDto, CompensationInterval, JobType,
  DescriptionFormat, Site, getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient, markdownConverter, plainConverter,
  extractEmails, randomSleep, parseLocationList, intervalFromPeriodToken,
  postedFromTimestamp, postedTimeFields,
} from '@ever-jobs/common';
import {
  ZIPRECRUITER_HEADERS,
  SESSION_EVENT_DATA,
  ZIPRECRUITER_SEARCH_URL,
  ZIPRECRUITER_EVENT_URL,
  ZIPRECRUITER_COUNTRY_NAMES,
  ZIPRECRUITER_DEFAULT_CURRENCY,
  EMPLOYMENT_TYPE_PARAM,
  EMPLOYMENT_TYPE_LABELS,
  GEO_BLOCK_DETAIL,
  GEO_BLOCK_MEMO_MAX_ENTRIES,
  MAX_PAGES,
  PAGE_SIZE_ESTIMATE,
  PAGE_DELAY_MIN_MS,
  PAGE_DELAY_MAX_MS,
  ZipRecruiterOptions,
  buildSessionEventBody,
  isGeoBlockError,
  isSupportedCountry,
  resolveZipRecruiterOptions,
  zipRecruiterJobUrl,
} from './ziprecruiter.constants';
import { ZipJob, ZipJobsResponse } from './ziprecruiter.types';

type HttpClient = ReturnType<typeof createHttpClient>;

const HOUR_MS = 60 * 60 * 1000;

/**
 * ZipRecruiter (US/Canada job board), read through the jobs-app search
 * endpoint (Spec 1713).
 *
 * One session event, then sequential search pages 5-10 s apart, capped. No
 * job-detail page is ever fetched: robots.txt disallows `/jobs/` for every
 * agent, so the description and links come from the list payload alone.
 */
@SourcePlugin({
  site: Site.ZIP_RECRUITER,
  name: 'ZipRecruiter',
  category: 'job-board',
  description: 'US/Canada only. The app API refuses non-North-American egress (403 cf-waf).',
  // Spec 1700 — the plugin keeps 5-10 s between pages; hold location calls to the same floor.
  minRequestIntervalMs: PAGE_DELAY_MIN_MS,
})
@Injectable()
export class ZipRecruiterService implements IScraper {
  private readonly logger = new Logger(ZipRecruiterService.name);
  private readonly baseUrl = ZIPRECRUITER_SEARCH_URL;

  /**
   * Egress (proxy list) -> epoch ms until which a geo-block suppresses every
   * request from it (Spec 1713 section 6.3). A caught 403 never reaches the circuit
   * breaker (the plugin resolves with diagnostics), so without this memo each
   * search would repeat a request known to fail.
   */
  private readonly geoBlockedUntil = new Map<string, number>();

  /** Clock; replaced in tests. */
  private now = (): number => Date.now();

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const options = resolveZipRecruiterOptions();

    // Region guard (section 6.1): before any client or request exists.
    if (options.regionGuard && !isSupportedCountry(input.country)) {
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics(
          'bad_input',
          `ZipRecruiter serves US/Canada only; country ${input.country} not searched`,
        ),
      );
    }

    const offset = wholeNumber(input.offset, 0);
    const resultsWanted = wholeNumber(input.resultsWanted, 15);
    if (resultsWanted === 0) return new JobResponseDto([]);

    const egress = egressKey(input);
    const blockedUntil = this.activeGeoBlock(egress, options);
    if (blockedUntil !== null) {
      const until = new Date(blockedUntil).toISOString();
      this.logger.warn(`ZipRecruiter skipped: this egress is geo-blocked until ${until}`);
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('blocked', `${GEO_BLOCK_DETAIL}; not retried until ${until}`),
      );
    }

    // Only the opt-in app-shaped session event keeps the cookies it is answered with.
    const client = createHttpClient(options.sessionEvent === 'form' ? { ...input, cookies: true } : input);
    client.setHeaders(ZIPRECRUITER_HEADERS);

    const refused = await this.initSession(client, options, egress);
    if (refused) return new JobResponseDto([], refused);

    return this.collect(client, input, options, egress, offset, resultsWanted);
  }

  /**
   * Session event (section 6.4). A geo-block ends the scrape here, one request
   * instead of two; any other failure is logged and the search goes ahead.
   */
  private async initSession(
    client: HttpClient,
    options: ZipRecruiterOptions,
    egress: string,
  ): Promise<ScrapeDiagnostics | null> {
    if (options.sessionEvent === 'off') return null;
    try {
      if (options.sessionEvent === 'json') {
        await client.post(ZIPRECRUITER_EVENT_URL, SESSION_EVENT_DATA);
      } else {
        await client.post(ZIPRECRUITER_EVENT_URL, buildSessionEventBody(this.now()).toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      }
      return null;
    } catch (err: unknown) {
      if (isGeoBlockError(err)) {
        this.rememberGeoBlock(egress, options);
        this.logger.warn('ZipRecruiter session init refused by the geo WAF (403 cf-waf); search skipped');
        return new ScrapeDiagnostics('blocked', GEO_BLOCK_DETAIL);
      }
      this.logger.warn(`ZipRecruiter session init failed: ${errorMessage(err)}`);
      return null;
    }
  }

  /** Pagination loop (section 6.5). */
  private async collect(
    client: HttpClient,
    input: ScraperInputDto,
    options: ZipRecruiterOptions,
    egress: string,
    offset: number,
    resultsWanted: number,
  ): Promise<JobResponseDto> {
    const target = offset + resultsWanted;
    const maxPages =
      options.maxPages ?? Math.min(MAX_PAGES, Math.ceil(target / PAGE_SIZE_ESTIMATE) + 1);
    const nowMs = this.now();
    const hoursOld = input.hoursOld ?? 0;
    const cutoffMs = options.hoursFilter && hoursOld > 0 ? nowMs - hoursOld * HOUR_MS : null;
    // With `remote=1` the server returns remote jobs only.
    const remoteFiltered = !options.legacyParams && input.isRemote === true;

    const collected: JobPostDto[] = [];
    const seen = new Set<string>();
    let token: string | null = null;
    let skipped = 0;
    let tooOld = 0;
    let diagnostics: ScrapeDiagnostics | undefined;

    for (let page = 1; page <= maxPages && collected.length < target; page++) {
      if (page > 1) await randomSleep(PAGE_DELAY_MIN_MS, PAGE_DELAY_MAX_MS);
      this.logger.log(`Fetching ZipRecruiter jobs, page ${page}`);

      let data: unknown;
      try {
        const response = await client.get<ZipJobsResponse>(this.baseUrl, {
          params: this.buildParams(input, token, options),
        });
        data = response.data;
      } catch (err: unknown) {
        this.logger.error(`ZipRecruiter scrape error: ${errorMessage(err)}`);
        diagnostics = this.describeError(err, egress, options);
        break;
      }

      const jobs = pageJobs(data);
      if (jobs === null) {
        diagnostics = unexpectedBody(data);
        this.logger.warn(`ZipRecruiter page ${page}: ${diagnostics.detail}`);
        break;
      }
      if (jobs.length === 0) break;

      let fresh = 0;
      for (const job of jobs) {
        if (collected.length >= target) break;
        const key = jobKey(job);
        if (!key) {
          skipped++;
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        fresh++;

        try {
          if (cutoffMs !== null && postedBefore(job.posted_time, cutoffMs)) {
            tooOld++;
            continue;
          }
          const jobPost = this.processJob(job, key, input.descriptionFormat, remoteFiltered, nowMs);
          if (jobPost) collected.push(jobPost);
          else skipped++;
        } catch (err: unknown) {
          skipped++;
          this.logger.warn(`Error processing ZipRecruiter job: ${errorMessage(err)}`);
        }
      }

      token = nextToken(data);
      // `fresh === 0`: a token that keeps returning the same jobs would loop.
      if (!token || fresh === 0) break;
      if (page === maxPages && collected.length < target) {
        this.logger.warn(`ZipRecruiter: stopped at the ${maxPages}-page cap with ${collected.length} of ${target} jobs`);
      }
    }

    if (tooOld > 0) this.logger.debug(`ZipRecruiter: ${tooOld} job(s) older than ${hoursOld} h dropped`);
    if (skipped > 0) {
      this.logger.warn(`ZipRecruiter: skipped ${skipped} record(s) without a usable id, title or URL`);
      if (!diagnostics && collected.length === 0) {
        diagnostics = new ScrapeDiagnostics(
          'unknown',
          `${skipped} ZipRecruiter record(s) had no listing_key, title or URL; the response contract may have changed`,
        );
      }
    }

    return new JobResponseDto(collected.slice(offset, target), diagnostics);
  }

  private buildParams(
    input: ScraperInputDto,
    continueToken: string | null,
    options: ZipRecruiterOptions,
  ): Record<string, any> {
    if (options.legacyParams) return this.buildLegacyParams(input, continueToken);

    const params: Record<string, any> = {
      search: input.searchTerm ?? '',
      location: input.location ?? '',
      radius: input.distance ?? 50,
    };
    if (input.hoursOld && input.hoursOld > 0) {
      // `ceil`: the server returns a superset; the exact cut happens client-side.
      params.days = Math.max(1, Math.ceil(input.hoursOld / 24));
    }
    const employmentType = input.jobType ? EMPLOYMENT_TYPE_PARAM[input.jobType] : undefined;
    if (employmentType) params.employment_type = employmentType;
    if (input.isRemote === true) params.remote = 1;
    if (input.easyApply === true) params.zipapply = 1;
    if (continueToken) params.continue_from = continueToken;
    return params;
  }

  /** The pre-1713 query, unchanged (`ZIPRECRUITER_LEGACY_PARAMS`). */
  private buildLegacyParams(input: ScraperInputDto, continueToken: string | null): Record<string, any> {
    const params: Record<string, any> = {
      search: input.searchTerm ?? '',
      location: input.location ?? '',
      radius_miles: input.distance ?? 50,
      form: 'jobs-landing',
    };
    if (continueToken) params.continue_token = continueToken;
    if (input.hoursOld) params.days_ago = Math.ceil(input.hoursOld / 24);
    if (input.jobType) {
      params.employment_type = EMPLOYMENT_TYPE_PARAM[input.jobType] ?? '';
    }
    return params;
  }

  /** Section 6.2: a geo-block gets its own detail (and starts the memo); the rest is classified as usual. */
  private describeError(err: unknown, egress: string, options: ZipRecruiterOptions): ScrapeDiagnostics {
    if (isGeoBlockError(err)) {
      this.rememberGeoBlock(egress, options);
      return new ScrapeDiagnostics('blocked', GEO_BLOCK_DETAIL);
    }
    return classifyScrapeError(err);
  }

  private activeGeoBlock(egress: string, options: ZipRecruiterOptions): number | null {
    if (options.geoBlockTtlMs <= 0) return null;
    const until = this.geoBlockedUntil.get(egress);
    if (until === undefined) return null;
    if (until <= this.now()) {
      this.geoBlockedUntil.delete(egress);
      return null;
    }
    return until;
  }

  private rememberGeoBlock(egress: string, options: ZipRecruiterOptions): void {
    if (options.geoBlockTtlMs <= 0) return;
    const now = this.now();
    for (const [key, until] of this.geoBlockedUntil) {
      if (until <= now) this.geoBlockedUntil.delete(key);
    }
    this.geoBlockedUntil.delete(egress);
    while (this.geoBlockedUntil.size >= GEO_BLOCK_MEMO_MAX_ENTRIES) {
      const oldest = this.geoBlockedUntil.keys().next().value;
      if (oldest === undefined) break;
      this.geoBlockedUntil.delete(oldest);
    }
    this.geoBlockedUntil.set(egress, now + options.geoBlockTtlMs);
  }

  private processJob(
    job: ZipJob,
    key: string,
    format: DescriptionFormat | undefined,
    remoteFiltered: boolean,
    nowMs: number,
  ): JobPostDto | null {
    const title = text(job.name) ?? text(job.title);
    if (!title) return null;

    const listingKey = text(job.listing_key);
    const jobUrl = listingKey ? zipRecruiterJobUrl(listingKey) : text(job.job_url) ?? text(job.url);
    if (!jobUrl) return null;

    let description = firstString(job.job_description, job.snippet);
    if (description) {
      if (format === DescriptionFormat.MARKDOWN) description = markdownConverter(description) ?? description;
      else if (format === DescriptionFormat.PLAIN) description = plainConverter(description) ?? description;
    }

    const rawCountry = text(job.job_country)?.toUpperCase() ?? null;
    const countryCode = rawCountry && ZIPRECRUITER_COUNTRY_NAMES[rawCountry] ? rawCountry : null;
    const countryName = countryCode ? ZIPRECRUITER_COUNTRY_NAMES[countryCode] : null;
    const city = text(job.job_city);
    const state = text(job.job_state);
    // The code is turned into a name BEFORE parsing: a bare `CA` is California to the parser.
    const label = [city, state, countryName].filter(Boolean).join(', ');
    const parsed = parseLocationList([label || null]);
    const location =
      parsed.location ??
      new LocationDto({ city, state, country: countryName ?? rawCountry });

    const employmentType = text(job.employment_type)?.toLowerCase() ?? '';
    const jobType: JobType | null = employmentType
      ? EMPLOYMENT_TYPE_LABELS[employmentType] ?? getJobTypeFromString(employmentType.replace(/_/g, ''))
      : null;

    const remoteFlag =
      job.remote === true ||
      (typeof job.remote === 'string' && job.remote.trim().toLowerCase() === 'true');

    return new JobPostDto({
      id: `zr-${key}`,
      title,
      companyName: text(job.hiring_company?.name),
      companyUrl: text(job.hiring_company?.url),
      jobUrl,
      jobUrlDirect: directApplyUrl(job),
      location,
      ...(parsed.locations.length > 0 ? { locations: parsed.locations } : {}),
      countryCode,
      compensation: this.compensation(job, countryCode),
      description,
      ...postedTimeFields(postedFromTimestamp(job.posted_time ?? null, nowMs)),
      isRemote: remoteFiltered || remoteFlag || parsed.remoteMentioned,
      workFromHomeType: parsed.workFromHomeType ?? null,
      listingType: text(job.buyer_type),
      jobType: jobType ? [jobType] : null,
      emails: extractEmails(description),
      companyLogo: text(job.hiring_company?.logo),
      site: Site.ZIP_RECRUITER,
    });
  }

  private compensation(job: ZipJob, countryCode: string | null): CompensationDto | null {
    const minAmount = positiveAmount(job.compensation_min);
    const maxAmount = positiveAmount(job.compensation_max);
    if (minAmount !== null || maxAmount !== null) {
      return new CompensationDto({
        minAmount,
        maxAmount,
        interval: intervalFromPeriodToken(text(job.compensation_interval)) ?? CompensationInterval.YEARLY,
        currency:
          text(job.compensation_currency)?.toUpperCase() ??
          (countryCode ? ZIPRECRUITER_DEFAULT_CURRENCY[countryCode] : undefined) ??
          'USD',
      });
    }

    // Retired partner-API fields: the pre-1713 mapping (annual USD).
    if (job.salary_min_annual || job.salary_max_annual) {
      return new CompensationDto({
        minAmount: job.salary_min_annual ?? null,
        maxAmount: job.salary_max_annual ?? null,
        interval: CompensationInterval.YEARLY,
        currency: 'USD',
      });
    }
    return null;
  }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function wholeNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, n);
}

function positiveAmount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(err);
}

/** Memo key: requests through a different proxy list leave from a different egress. */
function egressKey(input: ScraperInputDto): string {
  return JSON.stringify(Array.isArray(input.proxies) ? input.proxies : []);
}

/** Dedup / id key: `listing_key`, else the retired `job_id` / `id`. */
function jobKey(job: ZipJob | null | undefined): string | null {
  if (!job || typeof job !== 'object') return null;
  const listingKey = text(job.listing_key);
  if (listingKey) return listingKey;
  for (const value of [job.job_id, job.id]) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    const s = text(value);
    if (s) return s;
  }
  return null;
}

/** The page's jobs; `null` when the body is not the JSON object the endpoint returns. */
function pageJobs(data: unknown): ZipJob[] | null {
  if (data === null || data === undefined) return [];
  if (typeof data !== 'object' || Array.isArray(data)) return null;
  const jobs = (data as ZipJobsResponse).jobs;
  return Array.isArray(jobs) ? jobs : [];
}

function unexpectedBody(data: unknown): ScrapeDiagnostics {
  if (typeof data === 'string' && looksLikeChallenge(data)) {
    return new ScrapeDiagnostics('blocked', 'challenge page instead of the JSON job list');
  }
  const size = typeof data === 'string' ? `${data.length} characters` : typeof data;
  return new ScrapeDiagnostics('unknown', `unexpected non-JSON response body (${size})`);
}

/** Next-page token: `continue`, else the retired `continue_token`. */
function nextToken(data: unknown): string | null {
  const body = data as ZipJobsResponse;
  return text(body?.continue) ?? text(body?.continue_token);
}

function postedBefore(postedTime: unknown, cutoffMs: number): boolean {
  const ms =
    typeof postedTime === 'string' ? Date.parse(postedTime)
    : typeof postedTime === 'number' ? postedTime
    : NaN;
  return Number.isFinite(ms) && ms < cutoffMs;
}

/**
 * Direct apply link from the list payload. A link that carries the target in a
 * `job_url` query parameter yields that parameter, decoded. A save link is
 * used only for that parameter, never as a link itself.
 */
function directApplyUrl(job: ZipJob): string | null {
  const apply = text(job.apply_url);
  if (apply) return jobUrlParam(apply) ?? apply;
  const save = text(job.save_job_url);
  return save ? jobUrlParam(save) : null;
}

function jobUrlParam(url: string): string | null {
  let target: string | null;
  try {
    target = new URL(url).searchParams.get('job_url');
  } catch {
    return null;
  }
  const value = text(target);
  return value && /^https?:\/\//i.test(value) ? value : null;
}
