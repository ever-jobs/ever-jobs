import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  DescriptionFormat,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  looksLikeChallenge,
  refusalFromScrapeError,
  ScrapeDiagnostics,
  ScraperInputDto,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  HttpClient,
  markdownConverter,
  parseLocationList,
  postedFromTimestamp,
  PostedTime,
  postedTimeFields,
  resolveCompensation,
} from '@ever-jobs/common';
import {
  INHIRE_API_HOST,
  INHIRE_API_ORIGIN,
  INHIRE_ATS_TYPE,
  INHIRE_BRL_MARKER_RE,
  INHIRE_DEFAULT_RESULTS,
  INHIRE_DEFAULT_TIMEOUT_SECONDS,
  INHIRE_DETAIL_CONCURRENCY,
  INHIRE_DETAIL_CONCURRENCY_ENV,
  INHIRE_DETAIL_MAX_CONSECUTIVE_FAILURES,
  INHIRE_HEADERS,
  INHIRE_LIST_PATH,
  INHIRE_MAX_DETAIL_CONCURRENCY,
  INHIRE_MAX_DETAIL_FETCHES,
  INHIRE_MAX_LIST_ITEMS,
  INHIRE_MAX_MESSAGE_LENGTH,
  INHIRE_MAX_MIN_INTERVAL_MS,
  INHIRE_MIN_INTERVAL_ENV,
  INHIRE_MIN_INTERVAL_MS,
  INHIRE_PUBLIC_PATH_PREFIX,
  INHIRE_PUBLISHED_STATUS,
  INHIRE_SITE,
  INHIRE_TENANT_HEADER,
  INHIRE_CRAWL_POLICY,
  INHIRE_USER_AGENT,
  inhireDetailPath,
} from './inhire.constants';
import {
  bodyMessage,
  buildLocationLabel,
  careerPageUrl,
  cleanListRows,
  cleanText,
  detailBudgetFor,
  employmentTypeLabel,
  firstHttpsUrl,
  htmlToText,
  httpsUrlOrNull,
  latestPostedMs,
  mapContractTypes,
  matchesLocation,
  matchesSearchTerm,
  parseInhireTenant,
  parseJsonBody,
  readEnvInt,
  resolveJobUrl,
  tenantDisplayName,
  workplaceFlags,
} from './inhire.helpers';
import { inhireRuntime, reserveInhireSlot } from './inhire.state';
import {
  InhireCandidate,
  InhireJobDetail,
  InhireScrapeStats,
  InhireSkipReason,
} from './inhire.types';

/** Everything one scrape needs, resolved once from the input and the environment. */
interface ScrapePlan {
  tenant: string;
  offset: number;
  resultsWanted: number;
  /** `offset + resultsWanted`: matching roles to collect before stopping. */
  need: number;
  /** Detail calls allowed; 0 means board mode (no detail call at all). */
  budget: number;
  searchTerm: string | null;
  location: string | null;
  remoteOnly: boolean;
  jobType: JobType | null;
  hoursOld: number | null;
  format: DescriptionFormat | undefined;
  concurrency: number;
  intervalMs: number;
  /** Clock reading taken once at the start; anchors `hoursOld` and date plausibility. */
  now: number;
}

/** A detail record mapped to a job, with what the post-detail filters read. */
interface MappedDetail {
  job: JobPostDto;
  label: string | null;
  posted: PostedTime;
}

type DetailOutcome =
  | { kind: 'job'; mapped: MappedDetail }
  | { kind: 'skip'; reason: InhireSkipReason }
  /** `refusal`: the host refused us (429, 401/403/407, block); the walk stops. */
  | { kind: 'error'; diagnostics: ScrapeDiagnostics; refusal: boolean };

/**
 * InHire ATS scraper — generic, multi-tenant (Spec 1692).
 *
 * InHire (inhire.app, Brazil) hosts each customer's career page and serves
 * its openings from a public JSON API keyed by the `X-Tenant` header. The
 * adapter resolves the tenant from `companySlug` or `companyUrl` (never
 * fetching a caller URL), reads the tenant's lean list once, pre-filters it
 * by title, then fetches detail records in list order — one at a time by
 * default, paced across the process — until enough roles match or the detail
 * budget is spent. Failures degrade to partial results with a diagnostic, the
 * same as the sibling ATS adapters; `scrape` never throws.
 */
@SourcePlugin({
  site: INHIRE_SITE,
  name: 'InHire',
  category: 'ats',
  isAts: true,
  description:
    'InHire (Brazil) hosted career pages, read from the public job-posts JSON API keyed by the X-Tenant header',
  crawl: INHIRE_CRAWL_POLICY,
})
@Injectable()
export class InhireService implements IScraper {
  private readonly logger = new Logger(InhireService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      return await this.run(input);
    } catch (err: unknown) {
      this.logger.error(`InHire scrape failed: ${this.errorText(err)}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private async run(input: ScraperInputDto): Promise<JobResponseDto> {
    const slug = cleanText(input.companySlug);
    const companyUrl = cleanText(input.companyUrl);
    if (!slug && !companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for InHire scraper');
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('bad_input', 'InHire needs a companySlug (tenant) or a companyUrl on *.inhire.app / *.inhire.com.br'),
      );
    }

    const tenant = slug ? parseInhireTenant(slug) : parseInhireTenant(companyUrl, { hostOnly: true });
    if (!tenant) {
      const field = slug ? 'companySlug' : 'companyUrl';
      this.logger.warn(`InHire: ${field} ${JSON.stringify((slug ?? companyUrl ?? '').slice(0, 80))} is not an InHire tenant`);
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics(
          'bad_input',
          `${field} is not an InHire tenant: expected a tenant slug or a URL on *.inhire.app / *.inhire.com.br`,
        ),
      );
    }

    const plan = this.buildPlan(input, tenant);
    if (plan.resultsWanted <= 0) return new JobResponseDto([]);

    const client = this.createClient(input);
    const stats: InhireScrapeStats = {
      listed: 0,
      truncated: 0,
      invalid: 0,
      dupe: 0,
      candidates: 0,
      detailTried: 0,
      detailOk: 0,
      skippedStatus: 0,
      removed: 0,
      failed: 0,
      filteredOut: 0,
      unfetched: 0,
    };

    // ── 1. The tenant's lean list (one call, not paginated) ────────────────
    let body: unknown;
    try {
      const response = await this.request(client, INHIRE_LIST_PATH, plan);
      body = parseJsonBody(response?.data);
    } catch (err: unknown) {
      this.logger.warn(`InHire(${tenant}): list request failed: ${this.errorText(err)}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }

    if (!Array.isArray(body)) {
      const message = bodyMessage(body, INHIRE_MAX_MESSAGE_LENGTH);
      this.logger.warn(`InHire(${tenant}): list body is not an array${message ? `: ${message}` : ''}`);
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('fetch_error', message ?? 'InHire list response was not a JSON array'),
      );
    }

    stats.listed = body.length;
    if (body.length === 0) {
      this.logger.log(`InHire(${tenant}): no open roles`);
      return new JobResponseDto([]);
    }

    // ── 2. Clean, de-duplicate and title-filter (no request) ───────────────
    const cleaned = cleanListRows(body, INHIRE_MAX_LIST_ITEMS);
    stats.truncated = cleaned.truncated;
    stats.invalid = cleaned.invalid;
    stats.dupe = cleaned.dupe;
    if (cleaned.truncated > 0) {
      this.logger.warn(
        `InHire(${tenant}): list has ${body.length} rows; only the first ${INHIRE_MAX_LIST_ITEMS} are considered`,
      );
    }
    const candidates = cleaned.candidates.filter((c) => matchesSearchTerm(c.title, plan.searchTerm));
    stats.candidates = candidates.length;

    // ── 3a. Board mode: list data only ─────────────────────────────────────
    if (plan.budget === 0) {
      if (this.hasDetailFilters(plan)) {
        this.logger.warn(
          `InHire(${tenant}): descriptionDepth 'board' makes no detail call; location / isRemote / jobType / hoursOld are not evaluated`,
        );
      }
      const jobs = candidates
        .slice(plan.offset, plan.offset + plan.resultsWanted)
        .map((candidate) => this.boardJob(candidate, tenant));
      this.logSummary(tenant, stats, jobs.length);
      return new JobResponseDto(jobs);
    }

    // ── 3b. Detail walk: list order, bounded pool, paced ───────────────────
    // A refusal stops every worker at once; so do
    // INHIRE_DETAIL_MAX_CONSECUTIVE_FAILURES failures in a row. The jobs
    // collected so far are returned with the diagnostic that stopped the walk.
    const accepted = new Map<number, JobPostDto>();
    let firstFailure: ScrapeDiagnostics | null = null;
    let stoppedBy: ScrapeDiagnostics | null = null;
    let consecutiveFailures = 0;
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (
        stoppedBy === null &&
        accepted.size < plan.need &&
        stats.detailTried < plan.budget &&
        nextIndex < candidates.length
      ) {
        const candidate = candidates[nextIndex++];
        stats.detailTried++;
        const outcome = await this.fetchDetail(client, plan, candidate);
        if (outcome.kind === 'error') {
          stats.failed++;
          consecutiveFailures++;
          if (firstFailure === null) firstFailure = outcome.diagnostics;
          if (stoppedBy === null && outcome.refusal) {
            stoppedBy = outcome.diagnostics;
            this.logger.warn(
              `InHire(${tenant}): the API refused a detail call (${outcome.diagnostics.reason}); stopping the detail walk`,
            );
          } else if (stoppedBy === null && consecutiveFailures >= INHIRE_DETAIL_MAX_CONSECUTIVE_FAILURES) {
            stoppedBy = outcome.diagnostics;
            this.logger.warn(
              `InHire(${tenant}): ${consecutiveFailures} detail calls failed in a row; stopping the detail walk`,
            );
          }
          continue;
        }
        consecutiveFailures = 0;
        if (outcome.kind === 'skip') {
          if (outcome.reason === 'status') stats.skippedStatus++;
          else if (outcome.reason === 'removed') stats.removed++;
          continue;
        }
        stats.detailOk++;
        if (this.passesDetailFilters(outcome.mapped, plan)) {
          accepted.set(candidate.index, outcome.mapped.job);
        } else {
          stats.filteredOut++;
        }
      }
    };

    const workers = Math.max(1, Math.min(plan.concurrency, candidates.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));

    stats.unfetched = candidates.length - nextIndex;
    if (stats.unfetched > 0 && accepted.size < plan.need) {
      this.logger.log(
        `InHire(${tenant}): detail budget ${plan.budget} spent; ${stats.unfetched} listed roles were not fetched`,
      );
    }

    const jobs = [...accepted.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, job]) => job)
      .slice(plan.offset, plan.offset + plan.resultsWanted);

    this.logSummary(tenant, stats, jobs.length);

    if (stoppedBy !== null || firstFailure !== null) {
      // Jobs plus a diagnostic is inferred as `partial` upstream; no jobs plus
      // a diagnostic reports why every detail call failed. A stopped walk
      // reports what stopped it.
      return new JobResponseDto(jobs, stoppedBy ?? firstFailure ?? undefined);
    }
    return new JobResponseDto(jobs);
  }

  /** Resolve paging, budget, filters and pacing for one scrape. */
  private buildPlan(input: ScraperInputDto, tenant: string): ScrapePlan {
    const rawResults = input.resultsWanted ?? INHIRE_DEFAULT_RESULTS;
    const resultsWanted = Number.isFinite(rawResults) ? Math.max(0, Math.floor(rawResults)) : INHIRE_DEFAULT_RESULTS;
    const rawOffset = input.offset ?? 0;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
    const hoursOld =
      typeof input.hoursOld === 'number' && Number.isFinite(input.hoursOld) && input.hoursOld > 0
        ? input.hoursOld
        : null;
    return {
      tenant,
      offset,
      resultsWanted,
      need: offset + resultsWanted,
      budget: Math.min(detailBudgetFor(input.descriptionDepth), INHIRE_MAX_DETAIL_FETCHES),
      searchTerm: cleanText(input.searchTerm),
      location: cleanText(input.location),
      // The input DTO defaults `isRemote` to false, so only `true` filters.
      remoteOnly: input.isRemote === true,
      jobType: input.jobType ?? null,
      hoursOld,
      format: input.descriptionFormat,
      concurrency: readEnvInt(
        INHIRE_DETAIL_CONCURRENCY_ENV,
        INHIRE_DETAIL_CONCURRENCY,
        1,
        INHIRE_MAX_DETAIL_CONCURRENCY,
      ),
      // A value below the default is raised to it: the gap can only grow.
      intervalMs: readEnvInt(
        INHIRE_MIN_INTERVAL_ENV,
        INHIRE_MIN_INTERVAL_MS,
        INHIRE_MIN_INTERVAL_MS,
        INHIRE_MAX_MIN_INTERVAL_MS,
      ),
      now: inhireRuntime.now(),
    };
  }

  private createClient(input: ScraperInputDto): HttpClient {
    // Cap the per-request timeout; a caller may only shorten it. Both keys are
    // set: the factory reads `requestTimeout`, the plain options path `timeout`.
    const requested = input.requestTimeout;
    const timeoutSeconds =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.min(requested, INHIRE_DEFAULT_TIMEOUT_SECONDS)
        : INHIRE_DEFAULT_TIMEOUT_SECONDS;
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
      retries: input.retries,
      retryDelay: input.retryDelay,
      retryBackoff: input.retryBackoff,
      retryMaxDelay: input.retryMaxDelay,
      rateDelayMin: input.rateDelayMin,
      rateDelayMax: input.rateDelayMax,
      userAgent: INHIRE_USER_AGENT,
      allowedRedirectHosts: [INHIRE_API_HOST],
    });
    client.setHeaders(INHIRE_HEADERS);
    return client;
  }

  /**
   * One paced GET to the fixed API origin with the tenant header. Only paths
   * under the public job-posts prefix are ever requested.
   */
  private async request(client: HttpClient, path: string, plan: ScrapePlan) {
    if (!path.startsWith(INHIRE_PUBLIC_PATH_PREFIX)) {
      throw new Error(`Refused InHire request outside ${INHIRE_PUBLIC_PATH_PREFIX}`);
    }
    await this.pace(plan.intervalMs);
    return client.get<unknown>(`${INHIRE_API_ORIGIN}${path}`, {
      headers: { [INHIRE_TENANT_HEADER]: plan.tenant },
    });
  }

  private async pace(intervalMs: number): Promise<void> {
    const wait = reserveInhireSlot(inhireRuntime.now(), intervalMs);
    if (wait > 0) await inhireRuntime.sleep(wait);
  }

  /** Fetch and map one role. Never throws: every failure is an outcome. */
  private async fetchDetail(
    client: HttpClient,
    plan: ScrapePlan,
    candidate: InhireCandidate,
  ): Promise<DetailOutcome> {
    const { tenant } = plan;
    try {
      const response = await this.request(client, inhireDetailPath(candidate.jobId), plan);
      const body = parseJsonBody(response?.data);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        this.logger.warn(`InHire(${tenant}): detail ${candidate.jobId} is not a JSON object`);
        if (typeof response?.data === 'string' && looksLikeChallenge(response.data)) {
          return {
            kind: 'error',
            diagnostics: new ScrapeDiagnostics('blocked', `InHire detail ${candidate.jobId}: challenge page`),
            refusal: true,
          };
        }
        return {
          kind: 'error',
          diagnostics: new ScrapeDiagnostics('fetch_error', `InHire detail ${candidate.jobId}: response is not a JSON object`),
          refusal: false,
        };
      }
      const detail = body as InhireJobDetail;
      if (typeof detail.jobId === 'string' && detail.jobId.toLowerCase() !== candidate.jobId.toLowerCase()) {
        this.logger.warn(`InHire(${tenant}): detail ${candidate.jobId} answered for another role`);
        return {
          kind: 'error',
          diagnostics: new ScrapeDiagnostics('fetch_error', `InHire detail ${candidate.jobId}: answered for another role`),
          refusal: false,
        };
      }
      const status = cleanText(detail.status);
      if (status && status.toLowerCase() !== INHIRE_PUBLISHED_STATUS) {
        return { kind: 'skip', reason: 'status' };
      }
      return { kind: 'job', mapped: this.mapDetail(detail, candidate, plan) };
    } catch (err: unknown) {
      if ((err as { response?: { status?: number } })?.response?.status === 404) {
        // Removed between the list call and this one: not an error.
        return { kind: 'skip', reason: 'removed' };
      }
      this.logger.warn(`InHire(${tenant}): detail ${candidate.jobId} failed: ${this.errorText(err)}`);
      const refusal = refusalFromScrapeError(err);
      return { kind: 'error', diagnostics: refusal ?? classifyScrapeError(err), refusal: refusal !== null };
    }
  }

  /** Map a published detail record (plus its list row) to a JobPostDto. */
  private mapDetail(detail: InhireJobDetail, candidate: InhireCandidate, plan: ScrapePlan): MappedDetail {
    const { tenant } = plan;
    const title = cleanText(detail.displayName) ?? candidate.title;
    const jobUrl = resolveJobUrl(candidate.link, tenant, candidate.jobId);

    const html = typeof detail.description === 'string' && detail.description.trim() ? detail.description : null;
    const plain = htmlToText(html);
    const description = this.formatDescription(html, plain, plan.format);

    const { label, countryCode } = buildLocationLabel(detail.location, detail.locationComplement);
    const parsed = label ? parseLocationList([label]) : null;
    const workplace = workplaceFlags(detail.workplaceType);

    const posted = postedFromTimestamp(
      cleanText(detail.publishedAt) ?? cleanText(detail.createdAt) ?? cleanText(detail.lastPublishedAt),
      plan.now,
    );

    // The shared salary parser reads the `$` of `R$` as US dollars, so a
    // description quoting Brazilian reais is not salary-parsed at all.
    const compensation = plain && !INHIRE_BRL_MARKER_RE.test(plain) ? resolveCompensation({ text: plain }) : null;

    const job = new JobPostDto({
      id: `inhire-${candidate.jobId}`,
      site: INHIRE_SITE,
      atsType: INHIRE_ATS_TYPE,
      atsId: candidate.jobId,
      title,
      companyName: cleanText(detail.tenantName) ?? tenantDisplayName(tenant),
      jobUrl,
      // The public job page hosts the application form.
      applyUrl: jobUrl,
      companyUrl: careerPageUrl(jobUrl),
      description,
      emails: extractEmails(plain),
      companyDescription: htmlToText(detail.about),
      companyLogo: httpsUrlOrNull(detail.logo),
      bannerPhotoUrl: firstHttpsUrl(detail.background),
      ...postedTimeFields(posted),
      isRemote: workplace.isRemote,
      workFromHomeType: workplace.workFromHomeType,
      location: parsed?.location ?? null,
      ...(parsed && parsed.locations.length > 0 ? { locations: parsed.locations } : {}),
      countryCode,
      employmentType: employmentTypeLabel(detail.contractType),
      jobType: mapContractTypes(detail.contractType, title),
      compensation,
      ...(compensation ? { salarySource: 'description' } : {}),
      department: null,
    });

    return { job, label, posted };
  }

  /** A list-only job for `descriptionDepth: 'board'`: title, URLs and company. */
  private boardJob(candidate: InhireCandidate, tenant: string): JobPostDto {
    const jobUrl = resolveJobUrl(candidate.link, tenant, candidate.jobId);
    return new JobPostDto({
      id: `inhire-${candidate.jobId}`,
      site: INHIRE_SITE,
      atsType: INHIRE_ATS_TYPE,
      atsId: candidate.jobId,
      title: candidate.title,
      companyName: tenantDisplayName(tenant),
      jobUrl,
      applyUrl: jobUrl,
      companyUrl: careerPageUrl(jobUrl),
      description: null,
      datePosted: null,
      // Unknown without the detail record, which is not the same as "not remote".
      isRemote: null,
      department: null,
    });
  }

  /** Filters that need the detail record (location, remote, job type, age). */
  private passesDetailFilters(mapped: MappedDetail, plan: ScrapePlan): boolean {
    const { job } = mapped;
    if (plan.location) {
      const locations: Array<LocationDto | null | undefined> = [job.location, ...(job.locations ?? [])];
      if (!matchesLocation(plan.location, mapped.label, locations)) return false;
    }
    if (plan.remoteOnly && job.isRemote !== true) return false;
    // A role with no mapped type passes: unknown is not a mismatch.
    if (plan.jobType && job.jobType && job.jobType.length > 0 && !job.jobType.includes(plan.jobType)) {
      return false;
    }
    if (plan.hoursOld !== null) {
      const postedMs = latestPostedMs(mapped.posted);
      // A role without a date passes.
      if (postedMs !== null && postedMs < plan.now - plan.hoursOld * 3_600_000) return false;
    }
    return true;
  }

  private hasDetailFilters(plan: ScrapePlan): boolean {
    return Boolean(plan.location || plan.remoteOnly || plan.jobType || plan.hoursOld !== null);
  }

  /**
   * The job body per `descriptionFormat`: HTML as the API sent it, PLAIN with
   * every entity decoded, MARKDOWN (the input default) through the shared
   * converter.
   */
  private formatDescription(
    html: string | null,
    plain: string | null,
    format: DescriptionFormat | undefined,
  ): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.PLAIN) return plain;
    return markdownConverter(html) ?? plain;
  }

  private logSummary(tenant: string, stats: InhireScrapeStats, returned: number): void {
    this.logger.log(
      `InHire(${tenant}): list=${stats.listed} candidates=${stats.candidates} ` +
        `details=${stats.detailOk}/${stats.detailTried} ` +
        `skipped{status=${stats.skippedStatus},invalid=${stats.invalid},dupe=${stats.dupe}} ` +
        `removed=${stats.removed} failed=${stats.failed} filtered=${stats.filteredOut} ` +
        `unfetched=${stats.unfetched} truncated=${stats.truncated} returned=${returned}`,
    );
  }

  private errorText(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
