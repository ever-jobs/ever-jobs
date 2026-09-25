import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  DescriptionFormat,
  getJobTypeFromString,
  IScraper,
  isRefusalDiagnostics,
  JobPostDto,
  JobResponseDto,
  JobType,
  looksLikeChallenge,
  refusalFromScrapeError,
  ScrapeDiagnostics,
  ScraperInputDto,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  htmlToPlainText,
  HttpClient,
  markdownConverter,
  parseLocationList,
  postedFromTimestamp,
  postedTimeFields,
  resolveCompensation,
} from '@ever-jobs/common';
import {
  JOBSBYLEVEL_BASE_URL,
  JOBSBYLEVEL_CACHE_TTL_ENV,
  JOBSBYLEVEL_CATEGORIES_ENV,
  JOBSBYLEVEL_DEFAULT_MAX_PAGES,
  JOBSBYLEVEL_DEFAULT_RESULTS,
  JOBSBYLEVEL_DETAIL_CACHE_MAX,
  JOBSBYLEVEL_DETAIL_HTML_HEADERS,
  JOBSBYLEVEL_DETAIL_TIME_BUDGET_MS,
  JOBSBYLEVEL_DETAIL_TIMEOUT_S,
  JOBSBYLEVEL_EMIT_AI_LEVEL_ENV,
  JOBSBYLEVEL_FEED_FALLBACK_ENV,
  JOBSBYLEVEL_FEED_HEADERS,
  JOBSBYLEVEL_FEED_MAX_ITEMS,
  JOBSBYLEVEL_FEED_URL,
  JOBSBYLEVEL_HOST,
  JOBSBYLEVEL_JOB_PATH,
  JOBSBYLEVEL_MAX_AI_LEVEL_ENV,
  JOBSBYLEVEL_MAX_ARG_LENGTH,
  JOBSBYLEVEL_MAX_PAGES_CEILING,
  JOBSBYLEVEL_MAX_PAGES_ENV,
  JOBSBYLEVEL_MCP_DETAIL_TOOL,
  JOBSBYLEVEL_MCP_HEADERS,
  JOBSBYLEVEL_MCP_PAGE_SIZE,
  JOBSBYLEVEL_MCP_SEARCH_TOOL,
  JOBSBYLEVEL_MCP_URL,
  JOBSBYLEVEL_MIN_AI_LEVEL_ENV,
  JOBSBYLEVEL_MIN_INTERVAL_MS,
  JOBSBYLEVEL_PAGE_CACHE_MAX,
  JOBSBYLEVEL_PAGE_CACHE_TTL_MS,
  JOBSBYLEVEL_SITE,
  JOBSBYLEVEL_TRANSPORT_ENV,
  JOBSBYLEVEL_USER_AGENT,
} from './jobsbylevel.constants';
import {
  buildCompensation,
  buildLocationLabel,
  buildLocationMatcher,
  companyBoardUrl,
  companyFields,
  detailBudgetFor,
  detailFromMcpItem,
  humaniseSlug,
  isAllowedJobsByLevelUrl,
  isDetailItem,
  isSearchEnvelope,
  isTruthyFlag,
  JobsByLevelLocationMatcher,
  JobsByLevelResponseError,
  looksLikeRss,
  mergeSkills,
  normaliseCountryCode,
  parseDetailPage,
  parseMcpToolPayload,
  parseRssFeed,
  readEnvCsv,
  readEnvFlag,
  readEnvInt,
  resolveAiLevel,
  seniorityLabel,
  slugFromJobUrl,
  slugifyName,
  stableStringify,
  toFiniteNumber,
} from './jobsbylevel.helpers';
import {
  jobsByLevelDetailCache,
  jobsByLevelPageCache,
  jobsByLevelRuntime,
  reserveJobsByLevelSlot,
} from './jobsbylevel.state';
import {
  JobsByLevelDetail,
  JobsByLevelFeedItem,
  JobsByLevelItem,
  JobsByLevelJobPost,
  JobsByLevelSearchArgs,
  JobsByLevelSearchEnvelope,
  JobsByLevelTransport,
} from './jobsbylevel.types';

/** Everything one scrape needs to know, resolved once from the input and env. */
interface ScrapePlan {
  wanted: number;
  offset: number;
  searchTerm: string | null;
  isRemote: boolean;
  location: JobsByLevelLocationMatcher | null;
  jobType: JobType | null;
  cutoffMs: number | null;
  companySlug: string | null;
  minLevel: number | null;
  maxLevel: number | null;
  categories: string[] | null;
  maxPages: number;
  detailBudget: number;
  detailTimeoutMs: number;
  descriptionFormat: DescriptionFormat | undefined;
  cacheTtlMs: number;
  emitAiLevel: boolean;
  /** A filter the server cannot apply is active, so `offset` counts matches, not raw items. */
  clientFilters: boolean;
}

/** A mapped listing plus the values the client-side filters read. */
interface Candidate {
  job: JobsByLevelJobPost;
  slug: string;
  aiLevel: number | null;
  label: string | null;
  companyKey: string | null;
  category: string | null;
  postedMs: number | null;
}

interface TransportOutcome {
  jobs: JobsByLevelJobPost[];
  /** Set when a listing request failed; the jobs collected before it are kept. */
  failure: ScrapeDiagnostics | null;
  detailAttempted: number;
  detailFailed: number;
  /** Set when the host refused a detail read; the reads stopped there. */
  detailRefusal: ScrapeDiagnostics | null;
}

/** What a detail loop did, and the refusal that stopped it, if any. */
interface DetailRun {
  attempted: number;
  failed: number;
  refusal: ScrapeDiagnostics | null;
}

let rpcSequence = 0;

/**
 * Level (jobsbylevel.com) — AI-rated job listings (Spec 1693).
 *
 * Reads the operator's key-less MCP server (`search_jobs` / `get_job`) with
 * the public RSS feed as a fallback. Every request is sequential, paced at
 * least {@link JOBSBYLEVEL_MIN_INTERVAL_MS} apart per host, sent with an
 * honest User-Agent and checked against the robots.txt disallow list. The
 * REST API under `/api/` is disallowed by robots.txt and is never called.
 */
@SourcePlugin({
  site: JOBSBYLEVEL_SITE,
  name: 'Level (jobsbylevel.com)',
  category: 'niche',
  description:
    'AI-rated job listings (AI Level 1-4: how central AI is to the work, not seniority) via the public Level MCP server, RSS feed fallback',
})
@Injectable()
export class JobsByLevelService implements IScraper {
  private readonly logger = new Logger(JobsByLevelService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const plan = this.buildPlan(input);
    if (plan instanceof ScrapeDiagnostics) return new JobResponseDto([], plan);
    if (plan.wanted <= 0) return new JobResponseDto([]);

    const client = this.createClient(input);
    const transport = this.resolveTransport();
    this.logger.log(
      `Fetching Level jobs via ${transport} (resultsWanted=${plan.wanted}, offset=${plan.offset}, maxPages=${plan.maxPages})`,
    );

    let outcome: TransportOutcome;
    if (transport === 'feed') {
      outcome = await this.scrapeFeed(client, plan);
    } else {
      outcome = await this.scrapeMcp(client, plan);
      // The feed lives on the same host: after a refusal (429, block, challenge)
      // asking it for more is exactly what the refusal said not to do.
      const refused = outcome.failure !== null && isRefusalDiagnostics(outcome.failure);
      if (outcome.jobs.length === 0 && outcome.failure && refused) {
        this.logger.warn(
          `Level MCP listing was refused (${outcome.failure.reason}: ${outcome.failure.detail ?? 'no detail'}); ` +
            'not trying the RSS feed on the same host',
        );
      }
      if (
        outcome.jobs.length === 0 &&
        outcome.failure &&
        !refused &&
        readEnvFlag(JOBSBYLEVEL_FEED_FALLBACK_ENV, true)
      ) {
        this.logger.warn(
          `Level MCP listing failed (${outcome.failure.reason}: ${outcome.failure.detail ?? 'no detail'}); trying the RSS feed`,
        );
        const fallback = await this.scrapeFeed(client, plan);
        if (fallback.jobs.length > 0) {
          const detail = `MCP listing failed (${outcome.failure.reason}: ${outcome.failure.detail ?? 'no detail'}); served from the RSS feed`;
          this.logger.log(`Level returned ${fallback.jobs.length} jobs from the RSS feed fallback`);
          return new JobResponseDto(fallback.jobs, new ScrapeDiagnostics('partial', detail.slice(0, 300)));
        }
      }
    }

    this.logger.log(`Level returned ${outcome.jobs.length} jobs via ${transport}`);
    if (outcome.failure) return new JobResponseDto(outcome.jobs, outcome.failure);
    // A refused detail read is reported as the refusal itself, so the caller
    // (and a multi-location search) knows the host said stop.
    if (outcome.detailRefusal) return new JobResponseDto(outcome.jobs, outcome.detailRefusal);
    if (outcome.detailFailed > 0) {
      return new JobResponseDto(
        outcome.jobs,
        new ScrapeDiagnostics(
          'partial',
          `${outcome.detailFailed}/${outcome.detailAttempted} detail fetches failed`,
        ),
      );
    }
    return new JobResponseDto(outcome.jobs);
  }

  // ── Plan ──────────────────────────────────────────────────────────────────

  private buildPlan(input: ScraperInputDto): ScrapePlan | ScrapeDiagnostics {
    const minLevel = this.readLevelEnv(JOBSBYLEVEL_MIN_AI_LEVEL_ENV);
    const maxLevel = this.readLevelEnv(JOBSBYLEVEL_MAX_AI_LEVEL_ENV);
    if (minLevel !== null && maxLevel !== null && minLevel > maxLevel) {
      return new ScrapeDiagnostics(
        'bad_input',
        `${JOBSBYLEVEL_MIN_AI_LEVEL_ENV}=${minLevel} is above ${JOBSBYLEVEL_MAX_AI_LEVEL_ENV}=${maxLevel}`,
      );
    }

    const hoursOld = toFiniteNumber(input.hoursOld);
    const cutoffMs =
      hoursOld !== null && hoursOld > 0 ? jobsByLevelRuntime.now() - hoursOld * 3_600_000 : null;
    const searchTerm = (input.searchTerm ?? '').trim().slice(0, JOBSBYLEVEL_MAX_ARG_LENGTH) || null;
    const location = buildLocationMatcher(input.location);
    const jobType = input.jobType ?? null;
    const companySlug = slugifyName(input.companySlug);
    const categories = readEnvCsv(JOBSBYLEVEL_CATEGORIES_ENV);
    const ttlOverride = readEnvInt(JOBSBYLEVEL_CACHE_TTL_ENV, 0, 24 * 3_600_000);
    const requestTimeout = toFiniteNumber(input.requestTimeout);
    const detailTimeoutS = Math.min(
      requestTimeout !== null && requestTimeout > 0 ? requestTimeout : 60,
      JOBSBYLEVEL_DETAIL_TIMEOUT_S,
    );

    return {
      wanted: Math.max(0, Math.floor(toFiniteNumber(input.resultsWanted) ?? JOBSBYLEVEL_DEFAULT_RESULTS)),
      offset: Math.max(0, Math.floor(toFiniteNumber(input.offset) ?? 0)),
      searchTerm,
      isRemote: input.isRemote === true,
      location,
      jobType,
      cutoffMs,
      companySlug,
      minLevel,
      maxLevel,
      categories,
      maxPages:
        readEnvInt(JOBSBYLEVEL_MAX_PAGES_ENV, 1, JOBSBYLEVEL_MAX_PAGES_CEILING) ?? JOBSBYLEVEL_DEFAULT_MAX_PAGES,
      detailBudget: detailBudgetFor(input.descriptionDepth),
      detailTimeoutMs: detailTimeoutS * 1000,
      descriptionFormat: input.descriptionFormat,
      cacheTtlMs: ttlOverride ?? JOBSBYLEVEL_PAGE_CACHE_TTL_MS,
      emitAiLevel: readEnvFlag(JOBSBYLEVEL_EMIT_AI_LEVEL_ENV, true),
      clientFilters: Boolean(location || jobType || cutoffMs !== null || companySlug || categories),
    };
  }

  private readLevelEnv(name: string): number | null {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return null;
    const level = readEnvInt(name, 1, 4);
    if (level === undefined) {
      this.logger.warn(`Ignoring ${name}=${raw.slice(0, 20)}: expected an integer from 1 to 4`);
      return null;
    }
    return level;
  }

  private resolveTransport(): JobsByLevelTransport {
    const raw = (process.env[JOBSBYLEVEL_TRANSPORT_ENV] ?? '').trim().toLowerCase();
    if (raw === 'feed' || raw === 'rss') return 'feed';
    if (raw && raw !== 'mcp') {
      this.logger.warn(`Unknown ${JOBSBYLEVEL_TRANSPORT_ENV}=${raw.slice(0, 20)}; using mcp`);
    }
    return 'mcp';
  }

  private createClient(input: ScraperInputDto): HttpClient {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? 60,
      retries: input.retries,
      retryDelay: input.retryDelay,
      retryBackoff: input.retryBackoff,
      retryMaxDelay: input.retryMaxDelay,
      rateDelayMin: input.rateDelayMin,
      rateDelayMax: input.rateDelayMax,
      userAgent: JOBSBYLEVEL_USER_AGENT,
      allowedRedirectHosts: [JOBSBYLEVEL_HOST],
    });
    client.setHeaders({ 'User-Agent': JOBSBYLEVEL_USER_AGENT });
    return client;
  }

  // ── MCP transport ─────────────────────────────────────────────────────────

  private async scrapeMcp(client: HttpClient, plan: ScrapePlan): Promise<TransportOutcome> {
    const baseArgs: Omit<JobsByLevelSearchArgs, 'page'> = {};
    if (plan.searchTerm) baseArgs.query = plan.searchTerm;
    if (plan.isRemote) baseArgs.remote = true;
    if (plan.location?.serverCity) baseArgs.city = plan.location.serverCity;
    if (plan.companySlug) baseArgs.company = plan.companySlug.replace(/-/g, ' ');
    if (plan.minLevel !== null) baseArgs.ai_level_min = plan.minLevel;
    if (plan.maxLevel !== null) baseArgs.ai_level_max = plan.maxLevel;

    const pageSize = JOBSBYLEVEL_MCP_PAGE_SIZE;
    let page = plan.clientFilters ? 1 : Math.floor(plan.offset / pageSize) + 1;
    let skipItems = plan.clientFilters ? 0 : plan.offset % pageSize;
    let skipMatches = plan.clientFilters ? plan.offset : 0;

    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    let failure: ScrapeDiagnostics | null = null;

    for (let scanned = 0; scanned < plan.maxPages && candidates.length < plan.wanted; scanned++, page++) {
      let envelope: JobsByLevelSearchEnvelope;
      try {
        envelope = await this.searchPage(client, { ...baseArgs, page }, plan);
      } catch (err) {
        failure = this.refusalOf(err) ?? this.diagnose(err);
        this.logger.error(`Level search page ${page} failed: ${failure.detail ?? failure.reason}`);
        break;
      }

      const items = envelope.items;
      for (const item of items) {
        if (candidates.length >= plan.wanted) break;
        if (skipItems > 0) {
          skipItems--;
          continue;
        }
        let candidate: Candidate | null;
        try {
          candidate = this.mapItem(item);
        } catch (err: unknown) {
          this.logger.warn(`Error mapping Level item ${this.itemRef(item)}: ${(err as Error)?.message ?? err}`);
          continue;
        }
        if (!candidate) {
          this.logger.warn(`Skipping malformed Level item ${this.itemRef(item)}: missing slug, title or url`);
          continue;
        }
        if (seen.has(candidate.slug)) continue;
        seen.add(candidate.slug);
        if (!this.matches(candidate, plan)) continue;
        if (skipMatches > 0) {
          skipMatches--;
          continue;
        }
        candidates.push(candidate);
      }

      const servedPageSize = toFiniteNumber(envelope.per_page);
      const effectiveSize = servedPageSize !== null && servedPageSize > 0 ? servedPageSize : pageSize;
      const total = toFiniteNumber(envelope.total);
      if (items.length < effectiveSize) break;
      if (total !== null && page * effectiveSize >= total) break;
    }

    // No detail reads after the listing itself was refused.
    const { attempted, failed, refusal }: DetailRun =
      failure !== null && isRefusalDiagnostics(failure)
        ? { attempted: 0, failed: 0, refusal: null }
        : await this.enrich(candidates, plan, (slug) => this.fetchMcpDetail(client, slug, plan));
    return {
      jobs: candidates.map((c) => this.emit(c, plan)),
      failure,
      detailAttempted: attempted,
      detailFailed: failed,
      detailRefusal: refusal,
    };
  }

  private async searchPage(
    client: HttpClient,
    args: JobsByLevelSearchArgs,
    plan: ScrapePlan,
  ): Promise<JobsByLevelSearchEnvelope> {
    const key = `mcp:${JOBSBYLEVEL_MCP_SEARCH_TOOL}:${stableStringify(args as unknown as Record<string, unknown>)}`;
    const cached = jobsByLevelPageCache.get(key, plan.cacheTtlMs, jobsByLevelRuntime.now());
    if (cached !== undefined) return cached as JobsByLevelSearchEnvelope;

    const payload = await this.callTool(client, JOBSBYLEVEL_MCP_SEARCH_TOOL, { ...args });
    if (!isSearchEnvelope(payload)) {
      throw new JobsByLevelResponseError(
        new ScrapeDiagnostics('unknown', `unexpected ${JOBSBYLEVEL_MCP_SEARCH_TOOL} envelope: no items array`),
      );
    }
    jobsByLevelPageCache.set(key, payload, plan.cacheTtlMs, JOBSBYLEVEL_PAGE_CACHE_MAX, jobsByLevelRuntime.now());
    return payload;
  }

  private async fetchMcpDetail(
    client: HttpClient,
    slug: string,
    plan: ScrapePlan,
  ): Promise<JobsByLevelDetail> {
    const key = `mcp:${slug}`;
    const cached = jobsByLevelDetailCache.get(key, plan.cacheTtlMs, jobsByLevelRuntime.now());
    if (cached !== undefined) return cached as JobsByLevelDetail;

    const payload = await this.callTool(
      client,
      JOBSBYLEVEL_MCP_DETAIL_TOOL,
      { id_or_slug: slug },
      plan.detailTimeoutMs,
    );
    if (!isDetailItem(payload)) {
      throw new JobsByLevelResponseError(
        new ScrapeDiagnostics('unknown', `unexpected ${JOBSBYLEVEL_MCP_DETAIL_TOOL} payload`),
      );
    }
    const detail = detailFromMcpItem(payload);
    jobsByLevelDetailCache.set(key, detail, plan.cacheTtlMs, JOBSBYLEVEL_DETAIL_CACHE_MAX, jobsByLevelRuntime.now());
    return detail;
  }

  /** One JSON-RPC `tools/call` round trip, paced and robots-checked. */
  private async callTool(
    client: HttpClient,
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    this.assertAllowed(JOBSBYLEVEL_MCP_URL);
    await this.pace();
    rpcSequence += 1;
    const body = {
      jsonrpc: '2.0',
      id: rpcSequence,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    const response = await client.post(JOBSBYLEVEL_MCP_URL, body, {
      headers: JOBSBYLEVEL_MCP_HEADERS,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    return parseMcpToolPayload(response?.data);
  }

  // ── Feed transport ────────────────────────────────────────────────────────

  private async scrapeFeed(client: HttpClient, plan: ScrapePlan): Promise<TransportOutcome> {
    const empty = (failure: ScrapeDiagnostics): TransportOutcome => ({
      jobs: [],
      failure,
      detailAttempted: 0,
      detailFailed: 0,
      detailRefusal: null,
    });
    if (plan.jobType || plan.categories) {
      return empty(
        new ScrapeDiagnostics(
          'bad_input',
          'jobType and category filters need the MCP transport: the RSS feed carries neither',
        ),
      );
    }
    // Filters on data the feed lacks are judged on the listing page, one read per candidate.
    const needsDetail = plan.isRemote || plan.location !== null || plan.minLevel !== null || plan.maxLevel !== null;
    if (needsDetail && plan.detailBudget === 0) {
      return empty(
        new ScrapeDiagnostics(
          'bad_input',
          "remote, location and AI-level filters on the RSS feed need listing-page reads; descriptionDepth 'board' allows none",
        ),
      );
    }

    let items: JobsByLevelFeedItem[];
    try {
      items = await this.loadFeed(client, plan);
    } catch (err) {
      const failure = this.refusalOf(err) ?? this.diagnose(err);
      this.logger.error(`Level RSS feed failed: ${failure.detail ?? failure.reason}`);
      return empty(failure);
    }

    const candidates: Candidate[] = [];
    let skip = plan.offset;
    let attempted = 0;
    let failed = 0;
    let refusal: ScrapeDiagnostics | null = null;
    const startedAt = jobsByLevelRuntime.now();

    for (const item of items) {
      if (candidates.length >= plan.wanted) break;
      const candidate = this.mapFeedItem(item);
      if (!this.matchesFeed(candidate, item, plan)) continue;

      if (!needsDetail) {
        if (skip > 0) {
          skip--;
          continue;
        }
        candidates.push(candidate);
        continue;
      }

      const withinBudget =
        attempted < plan.detailBudget &&
        jobsByLevelRuntime.now() - startedAt < JOBSBYLEVEL_DETAIL_TIME_BUDGET_MS;
      if (!withinBudget) break;
      attempted++;
      let detail: JobsByLevelDetail;
      try {
        detail = await this.fetchHtmlDetail(client, candidate.slug, plan);
      } catch (err) {
        failed++;
        this.logger.debug(`Level listing page ${candidate.slug} failed: ${this.diagnose(err).detail ?? err}`);
        refusal = this.refusalOf(err);
        if (refusal) {
          this.logger.warn(`Level refused listing page ${candidate.slug} (${refusal.reason}); stopping listing-page reads`);
          break;
        }
        continue;
      }
      this.applyDetail(candidate, detail, plan);
      if (!this.matches(candidate, plan)) continue;
      if (skip > 0) {
        skip--;
        continue;
      }
      candidates.push(candidate);
    }

    if (!needsDetail) {
      const enriched = await this.enrich(candidates, plan, (slug) => this.fetchHtmlDetail(client, slug, plan));
      attempted += enriched.attempted;
      failed += enriched.failed;
      refusal = enriched.refusal;
    }

    return {
      jobs: candidates.map((c) => this.emit(c, plan)),
      failure: null,
      detailAttempted: attempted,
      detailFailed: failed,
      detailRefusal: refusal,
    };
  }

  private async loadFeed(client: HttpClient, plan: ScrapePlan): Promise<JobsByLevelFeedItem[]> {
    const key = 'feed';
    const cached = jobsByLevelPageCache.get(key, plan.cacheTtlMs, jobsByLevelRuntime.now());
    if (cached !== undefined) return cached as JobsByLevelFeedItem[];

    this.assertAllowed(JOBSBYLEVEL_FEED_URL);
    await this.pace();
    const response = await client.get(JOBSBYLEVEL_FEED_URL, {
      headers: JOBSBYLEVEL_FEED_HEADERS,
      responseType: 'text',
    });
    const body = response?.data;
    if (typeof body !== 'string' || !looksLikeRss(body)) {
      const text = typeof body === 'string' ? body : '';
      throw new JobsByLevelResponseError(
        looksLikeChallenge(text) || text.trimStart().startsWith('<')
          ? new ScrapeDiagnostics('blocked', 'the RSS feed answered with an HTML page, not RSS')
          : new ScrapeDiagnostics('unknown', 'the RSS feed body is not RSS'),
      );
    }
    const items = parseRssFeed(body, JOBSBYLEVEL_FEED_MAX_ITEMS);
    jobsByLevelPageCache.set(key, items, plan.cacheTtlMs, JOBSBYLEVEL_PAGE_CACHE_MAX, jobsByLevelRuntime.now());
    return items;
  }

  private async fetchHtmlDetail(
    client: HttpClient,
    slug: string,
    plan: ScrapePlan,
  ): Promise<JobsByLevelDetail> {
    const key = `html:${slug}`;
    const cached = jobsByLevelDetailCache.get(key, plan.cacheTtlMs, jobsByLevelRuntime.now());
    if (cached !== undefined) return cached as JobsByLevelDetail;

    const url = `${JOBSBYLEVEL_BASE_URL}${JOBSBYLEVEL_JOB_PATH}${encodeURIComponent(slug)}`;
    this.assertAllowed(url);
    await this.pace();
    const response = await client.get(url, {
      headers: JOBSBYLEVEL_DETAIL_HTML_HEADERS,
      responseType: 'text',
      timeout: plan.detailTimeoutMs,
    });
    const html = typeof response?.data === 'string' ? response.data : '';
    const detail = parseDetailPage(html);
    if (!detail) {
      throw new JobsByLevelResponseError(
        looksLikeChallenge(html)
          ? new ScrapeDiagnostics('blocked', `listing page ${slug} is a challenge page`)
          : new ScrapeDiagnostics('unknown', `listing page ${slug} has no JobPosting JSON-LD`),
      );
    }
    jobsByLevelDetailCache.set(key, detail, plan.cacheTtlMs, JOBSBYLEVEL_DETAIL_CACHE_MAX, jobsByLevelRuntime.now());
    return detail;
  }

  // ── Details (both transports) ─────────────────────────────────────────────

  /**
   * Read details for the first `detailBudget` candidates, one at a time, and
   * stop when the time budget is spent. A failed read keeps the job (with no
   * description) and is counted, never thrown. A refused read (429, block,
   * challenge) stops the reads and is returned as `refusal`.
   */
  private async enrich(
    candidates: Candidate[],
    plan: ScrapePlan,
    fetchDetail: (slug: string) => Promise<JobsByLevelDetail>,
  ): Promise<DetailRun> {
    let attempted = 0;
    let failed = 0;
    const limit = Math.min(plan.detailBudget, candidates.length);
    const startedAt = jobsByLevelRuntime.now();
    for (let i = 0; i < limit; i++) {
      if (jobsByLevelRuntime.now() - startedAt >= JOBSBYLEVEL_DETAIL_TIME_BUDGET_MS) {
        this.logger.debug(`Level detail time budget spent after ${attempted} reads`);
        break;
      }
      const candidate = candidates[i];
      attempted++;
      try {
        const detail = await fetchDetail(candidate.slug);
        this.applyDetail(candidate, detail, plan);
      } catch (err) {
        failed++;
        this.logger.debug(`Level detail ${candidate.slug} failed: ${this.diagnose(err).detail ?? err}`);
        const refusal = this.refusalOf(err);
        if (refusal) {
          this.logger.warn(`Level refused detail ${candidate.slug} (${refusal.reason}); stopping detail reads`);
          return { attempted, failed, refusal };
        }
      }
    }
    return { attempted, failed, refusal: null };
  }

  private applyDetail(candidate: Candidate, detail: JobsByLevelDetail, plan: ScrapePlan): void {
    const job = candidate.job;
    const description = this.formatDescription(detail.description, detail.descriptionIsHtml, plan.descriptionFormat);
    if (description) {
      job.description = description;
      job.emails = extractEmails(description);
    }
    if (detail.skills.length) {
      const skills = mergeSkills(job.skills ?? [], detail.skills);
      job.skills = skills.length ? skills : null;
    }
    if (!job.companyUrlDirect && detail.companyWebsite) job.companyUrlDirect = detail.companyWebsite;
    if (!job.countryCode && detail.countryCode) job.countryCode = detail.countryCode;
    if (detail.remote === true) job.isRemote = true;
    if (candidate.aiLevel === null && detail.aiLevel !== null) candidate.aiLevel = detail.aiLevel;
    if (!job.atsId && detail.atsId) job.atsId = detail.atsId;
    if (!job.employmentType && detail.employmentType) {
      job.employmentType = detail.employmentType;
      const jobType = getJobTypeFromString(detail.employmentType);
      if (jobType) job.jobType = [jobType];
    }
    if (!job.compensation) {
      const text = detail.description
        ? detail.descriptionIsHtml
          ? htmlToPlainText(detail.description)
          : detail.description
        : null;
      job.compensation = resolveCompensation({ structured: detail.compensation, text }) ?? null;
    }
  }

  /**
   * Description in the requested format. JSON-LD gives HTML and converts as
   * siblings do; the MCP detail is plain text already and is returned as is.
   */
  private formatDescription(
    text: string | null,
    isHtml: boolean,
    format: DescriptionFormat | undefined,
  ): string | null {
    if (!text) return null;
    if (!isHtml) return text.trim() || null;
    if (format === DescriptionFormat.HTML) return text;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(text) ?? text;
    return htmlToPlainText(text);
  }

  // ── Mapping and filters ───────────────────────────────────────────────────

  /** Map one `search_jobs` item; null when it lacks a slug, a title or a Level listing URL. */
  private mapItem(item: JobsByLevelItem): Candidate | null {
    if (!item || typeof item !== 'object') return null;
    // The listing URL is the attribution link the operator asks us to keep,
    // so an item without one is not emitted; its slug is the job's identity.
    const slug = slugFromJobUrl(item.url);
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!slug || !title) return null;
    const jobUrl = (item.url as string).trim();

    const company = companyFields(item);
    const countryCode = normaliseCountryCode(item.country);
    const label = buildLocationLabel(item.location, countryCode);
    const parsed = parseLocationList(label ? [label] : []);
    const employmentType = typeof item.employment_type === 'string' ? item.employment_type.trim() || null : null;
    const jobType = employmentType ? getJobTypeFromString(employmentType) : null;
    const posted = postedFromTimestamp(item.posted_at, jobsByLevelRuntime.now());
    const postedMs = posted.datePostedAt ? Date.parse(posted.datePostedAt) : Number.NaN;
    const skills = mergeSkills(item.tools, item.skills);
    const category = typeof item.category === 'string' ? item.category.trim().toLowerCase() || null : null;

    const job = new JobPostDto({
      id: `jobsbylevel-${slug}`,
      title,
      companyName: company.name,
      companyUrl: companyBoardUrl(company.slug),
      companyUrlDirect: company.website,
      jobUrl,
      jobUrlDirect: null,
      location: parsed.location,
      ...(parsed.locations.length > 0 ? { locations: parsed.locations } : {}),
      countryCode,
      isRemote: isTruthyFlag(item.remote) || parsed.remoteMentioned,
      workFromHomeType: parsed.workFromHomeType,
      jobType: jobType ? [jobType] : null,
      employmentType,
      compensation: buildCompensation(item),
      ...postedTimeFields(posted),
      jobLevel: seniorityLabel(item.seniority),
      jobFunction: humaniseSlug(item.category),
      skills: skills.length ? skills : null,
      listingType: item.sponsored === true ? 'sponsored' : null,
      description: null,
      emails: null,
      site: JOBSBYLEVEL_SITE,
    }) as JobsByLevelJobPost;

    return {
      job,
      slug,
      aiLevel: resolveAiLevel(item),
      label: [item.location, label].filter(Boolean).join(' | ') || null,
      companyKey: company.slug ?? slugifyName(company.name),
      category,
      postedMs: Number.isFinite(postedMs) ? postedMs : null,
    };
  }

  /** Map one RSS item: title, company, canonical link and posting time only. */
  private mapFeedItem(item: JobsByLevelFeedItem): Candidate {
    const posted = postedFromTimestamp(item.postedAt, jobsByLevelRuntime.now());
    const postedMs = item.postedAt ? Date.parse(item.postedAt) : Number.NaN;
    const job = new JobPostDto({
      id: `jobsbylevel-${item.slug}`,
      title: item.title,
      companyName: item.companyName,
      jobUrl: item.url,
      jobUrlDirect: null,
      location: null,
      isRemote: null,
      ...postedTimeFields(posted),
      description: null,
      emails: null,
      site: JOBSBYLEVEL_SITE,
    }) as JobsByLevelJobPost;
    return {
      job,
      slug: item.slug,
      aiLevel: null,
      label: null,
      companyKey: slugifyName(item.companyName),
      category: null,
      postedMs: Number.isFinite(postedMs) ? postedMs : null,
    };
  }

  /** Client-side filters on a mapped listing. A filter on a value the listing lacks drops it. */
  private matches(c: Candidate, plan: ScrapePlan): boolean {
    const job = c.job;
    if (plan.isRemote && job.isRemote !== true) return false;
    if (plan.location) {
      const label = [c.label, job.countryCode].filter(Boolean).join(' | ') || null;
      if (!plan.location.matches(label, job.countryCode ?? null)) return false;
    }
    if (plan.jobType && !(job.jobType ?? []).includes(plan.jobType)) return false;
    if (plan.cutoffMs !== null && (c.postedMs === null || c.postedMs < plan.cutoffMs)) return false;
    if (plan.companySlug && c.companyKey !== plan.companySlug) return false;
    if (plan.minLevel !== null && (c.aiLevel === null || c.aiLevel < plan.minLevel)) return false;
    if (plan.maxLevel !== null && (c.aiLevel === null || c.aiLevel > plan.maxLevel)) return false;
    if (plan.categories && (!c.category || !plan.categories.includes(c.category))) return false;
    return true;
  }

  /** Feed-only filters (search term, age, company), judged on the RSS item alone. */
  private matchesFeed(c: Candidate, item: JobsByLevelFeedItem, plan: ScrapePlan): boolean {
    if (plan.searchTerm) {
      const hay = `${item.title} ${item.companyName ?? ''} ${item.snippet ?? ''}`.toLowerCase();
      const words = plan.searchTerm.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    if (plan.cutoffMs !== null && (c.postedMs === null || c.postedMs < plan.cutoffMs)) return false;
    if (plan.companySlug && c.companyKey !== plan.companySlug) return false;
    return true;
  }

  private emit(c: Candidate, plan: ScrapePlan): JobsByLevelJobPost {
    if (plan.emitAiLevel) c.job.aiLevel = c.aiLevel;
    return c.job;
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  /** Wait for this request's slot: at least the minimum interval after the previous one. */
  private async pace(): Promise<void> {
    const wait = reserveJobsByLevelSlot(jobsByLevelRuntime.now(), JOBSBYLEVEL_MIN_INTERVAL_MS);
    if (wait > 0) await jobsByLevelRuntime.sleep(wait);
  }

  /** Refuse any URL robots.txt disallows (no code path should build one). */
  private assertAllowed(url: string): void {
    if (!isAllowedJobsByLevelUrl(url)) {
      throw new JobsByLevelResponseError(
        new ScrapeDiagnostics('bad_input', `refused to request a disallowed Level URL: ${url.slice(0, 120)}`),
      );
    }
  }

  private diagnose(err: unknown): ScrapeDiagnostics {
    return err instanceof JobsByLevelResponseError ? err.diagnostics : classifyScrapeError(err);
  }

  /** The refusal this error shows (429, 401/403/407, block, challenge), or `null`. */
  private refusalOf(err: unknown): ScrapeDiagnostics | null {
    if (err instanceof JobsByLevelResponseError) {
      return isRefusalDiagnostics(err.diagnostics) ? err.diagnostics : null;
    }
    return refusalFromScrapeError(err);
  }

  private itemRef(item: JobsByLevelItem | null | undefined): string {
    const ref = item && typeof item === 'object' ? item.slug ?? item.id : null;
    return typeof ref === 'string' && ref ? ref.slice(0, 120) : '(no slug)';
  }
}
