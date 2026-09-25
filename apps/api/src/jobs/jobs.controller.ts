import {
  Controller,
  Post,
  Body,
  Logger,
  Query,
  Res,
  StreamableFile,
  Optional,
  Inject,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import {
  ScraperInputDto,
  JobPostDto,
  SourceDiagnosticDto,
  summarizeSourceDiagnostics,
  DEFAULT_DIAGNOSTICS_LIMIT,
  type DiagnosticsMode,
  JobAnalysisDto,
  LIVENESS_CHECKER_TOKEN,
  LEGITIMACY_CHECKER_TOKEN,
  type ILivenessChecker,
  type ILegitimacyChecker,
  type LegitimacyInput,
} from '@ever-jobs/models';
import { ConfigService } from '@nestjs/config';
import { JobsService } from './jobs.service';
import { AggregateResult, JobsAggregator } from './jobs.aggregator';
import {
  NDJSON_CONTENT_TYPE,
  NDJSON_HEARTBEAT_MS,
  NdjsonWriter,
} from './ndjson-writer';
import {
  SearchProgress,
  SearchRunOptions,
  clampResultsWanted,
  describeTerm,
  normalizeSearchInput,
} from './search-input';
import { DEFAULT_LIVENESS_MAX_URLS, DEFAULT_MAX_RESULTS_WANTED } from '../config/search-config';
import { AnalyticsService } from '@ever-jobs/analytics';
import { CacheService } from '../cache/cache.service';

/**
 * The fan-out stopped starting sources because the NDJSON client disconnected
 * (Spec 1721 / FR-14). Thrown by `runSearch` so the partial result is never
 * cached, deduped or persisted.
 */
export class SearchCancelledError extends Error {
  constructor() {
    super('client disconnected; the fan-out stopped starting sources and the partial result was discarded');
    this.name = 'SearchCancelledError';
  }
}

@ApiTags('Jobs')
@Controller('api/jobs')
export class JobsController {
  private readonly logger = new Logger(JobsController.name);

  constructor(
    private readonly jobsService: JobsService,
    private readonly aggregator: JobsAggregator,
    private readonly analyticsService: AnalyticsService,
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
    // Spec 740 — opt-in corpus signals. Optional so the controller boots even if a checker
    // module isn't wired; enrichment is simply skipped when the binding is absent.
    @Optional()
    @Inject(LIVENESS_CHECKER_TOKEN)
    private readonly livenessChecker?: ILivenessChecker,
    @Optional()
    @Inject(LEGITIMACY_CHECKER_TOKEN)
    private readonly legitimacyChecker?: ILegitimacyChecker,
  ) {}

  /**
   * POST /api/jobs/search
   *
   * Primary job search endpoint. Accepts a JSON body with search criteria
   * and returns results with caching, CSV export, and pagination support.
   *
   * Output format and pagination are controlled via query parameters:
   *   ?format=csv    → returns CSV file download
   *   ?format=ndjson → streams one JSON line per job (Spec 1721)
   *   ?paginate=true&page=1&page_size=10 → paginated JSON
   *   ?dedup=false   → opt out of cross-source deduplication (default true)
   *
   * Omitting `searchTerm` (or sending null / "" / whitespace) is LIST MODE
   * (Spec 1720): every selected source lists what it can, no keyword filter.
   */
  @Post('search')
  @ApiOperation({
    summary: 'Search for jobs across multiple sources',
    description:
      'Searches selected job boards concurrently and returns a merged, sorted list of job postings. ' +
      'Supports caching, CSV export (via ?format=csv), NDJSON streaming (via ?format=ndjson), pagination ' +
      '(via ?paginate=true), and cross-source deduplication (default ?dedup=true; pass ?dedup=false to opt out). ' +
      'Omit `searchTerm` for LIST MODE: every selected source returns what it can list without a keyword, ' +
      'up to `resultsWanted` per source. Every job carries a stable cross-source `dedupKey`.',
  })
  @ApiQuery({
    name: 'format',
    required: false,
    enum: ['json', 'csv', 'ndjson'],
    description:
      'Output format: json (default), csv, or ndjson. ndjson streams Content-Type application/x-ndjson: ' +
      '{"type":"progress","sourcesDone":n,"sourcesTotal":m,"jobs":k} immediately (0/0/0), at fan-out start and at most every ~10 s, ' +
      'then one {"type":"job","data":{…}} per job (same order and per-job shape as json), then ' +
      '{"type":"end","total":N,"deduped":bool,"durationMs":ms}. On failure after headers: {"type":"error","message":"…"} ' +
      'and NO end line — treat a missing end line as a truncated result. Ignore unknown line types. ' +
      'paginate/page/page_size are ignored in ndjson mode.',
    example: 'json',
  })
  @ApiQuery({ name: 'paginate', required: false, type: Boolean, description: 'Enable pagination' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (when paginate=true)' })
  @ApiQuery({ name: 'page_size', required: false, type: Number, description: 'Results per page (1-100, default 10)' })
  @ApiQuery({
    name: 'dedup',
    required: false,
    type: Boolean,
    description:
      'Cross-source deduplication. Default true — collapses identical or near-duplicate jobs surfaced by multiple sources into one record. Pass false to keep every observation as a separate result (Spec 003 / FR-1).',
  })
  @ApiQuery({
    name: 'diagnostics',
    required: false,
    description:
      'Per-source outcome breakdown. Off by default — a full fan-out covers ~1 800 sources, and returning a row for each put hundreds of KB of mostly-`ok`/`empty` noise on every response. `true` returns only actionable reasons (blocked, browser_unavailable, fetch_error, timeout, bad_input, circuit_open, unknown); `all` returns every row. `per_source_summary` always reports the complete picture, including rows not returned.',
    example: 'true',
  })
  @ApiQuery({
    name: 'diagnostics_limit',
    required: false,
    type: Number,
    description: 'Cap on returned per_source rows (default 200). Non-positive means no cap.',
  })
  @ApiQuery({
    name: 'liveness',
    required: false,
    type: Boolean,
    description:
      'Probe each returned posting URL (liveness-http) and attach liveness {state, checkedAt}. Off unless requested. ' +
      'The server can refuse it (EVER_JOBS_LIVENESS_ENABLED=false → no liveness field) and caps probes per request ' +
      '(EVER_JOBS_LIVENESS_MAX_URLS, default 100; jobs past the cap carry no liveness).',
  })
  @ApiQuery({
    name: 'legitimacy',
    required: false,
    type: Boolean,
    description: 'Attach an in-process legitimacy verdict {state, reasons} to each returned job. Off unless requested.',
  })
  @ApiResponse({ status: 200, description: 'Job search results (json / csv / ndjson)' })
  @ApiResponse({
    status: 400,
    description:
      'Invalid input, e.g. an unknown siteCategories value or a companyDomain that maps to no plugin (also for ndjson — checked before the stream starts)',
  })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async searchJobs(
    @Body() input: ScraperInputDto,
    @Query('format') format?: string,
    @Query('paginate') paginateRaw?: string,
    @Query('page') pageRaw?: string,
    @Query('page_size') pageSizeRaw?: string,
    @Query('dedup') dedupRaw?: string,
    @Query('liveness') livenessRaw?: string,
    @Query('legitimacy') legitimacyRaw?: string,
    @Res({ passthrough: true }) res?: Response,
    // Appended after `res` deliberately. Nest binds these by decorator, so
    // order is irrelevant at runtime — but the parameter list is positional for
    // direct callers (the unit tests construct the controller and call it
    // directly), and inserting ahead of `res` silently shifts it.
    @Query('diagnostics') diagnosticsRaw?: string,
    @Query('diagnostics_limit') diagnosticsLimitRaw?: string,
  ) {
    // Spec 1720 — normalise the keyword BEFORE logging and the cache lookup,
    // so "", "   ", null and an omitted term are one request and one cache
    // entry, and the log never prints term="undefined".
    normalizeSearchInput(input);
    // Spec 1720 / FR-12 — clamp before the cache key, so an over-cap request
    // shares the entry of the request the server will actually run.
    const maxResultsWanted = this.configService.get<number>(
      'search.maxResultsWanted',
      DEFAULT_MAX_RESULTS_WANTED,
    );
    const askedResults = clampResultsWanted(input, maxResultsWanted);
    if (askedResults !== undefined) {
      this.logger.warn(
        `resultsWanted ${askedResults} clamped to ${maxResultsWanted} per source (EVER_JOBS_MAX_RESULTS_WANTED)`,
      );
    }
    this.logger.log(
      `Search request: sites=${input.siteType?.join(',') ?? 'all'}` +
        `${input.siteCategories?.length ? `, categories=${input.siteCategories.join(',')}` : ''}` +
        `, term=${describeTerm(input)}, location=${input.location ? JSON.stringify(input.location) : '<none>'}`,
    );

    // ── Helper parsers ────────────────────
    const parseBool = (v?: string): boolean =>
      v !== undefined && ['true', '1', 'yes'].includes(v.toLowerCase());
    /** Like parseBool but with a configurable default when the param is absent. */
    const parseBoolWithDefault = (v: string | undefined, fallback: boolean): boolean => {
      if (v === undefined) return fallback;
      const s = v.toLowerCase();
      if (['true', '1', 'yes'].includes(s)) return true;
      if (['false', '0', 'no'].includes(s)) return false;
      return fallback;
    };
    const parseNum = (v?: string): number | undefined =>
      v === undefined ? undefined : Number(v) || undefined;
    /**
     * `diagnostics` is opt-in: a full fan-out produces ~1 800 rows, so emitting
     * them by default put hundreds of kilobytes of mostly-`ok`/`empty` noise on
     * every response. `true` returns only the reasons an operator can act on;
     * `all` returns every row. Both are capped, and the summary always reports
     * the full picture regardless of what was returned.
     */
    /**
     * Deliberately not `parseNum`: that returns `Number(v) || undefined`, so a
     * literal `0` is falsy and falls through to the default cap — which would
     * silently truncate the very request (`?diagnostics_limit=0`) documented as
     * meaning "no cap". Zero and negatives are passed through for the helper to
     * interpret; only absent or non-numeric input takes the default.
     */
    const parseLimit = (v?: string): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const parseDiagnosticsMode = (v?: string): DiagnosticsMode => {
      if (v === undefined) return 'off';
      const s = v.toLowerCase();
      if (s === 'all') return 'all';
      if (['true', '1', 'yes'].includes(s)) return 'actionable';
      return 'off';
    };

    const dedup = parseBoolWithDefault(dedupRaw, true);

    // ── NDJSON stream (Spec 1721) ─────────
    // Same cache → fan-out → dedup → corpus-signal pipeline as JSON, but the
    // whole set is streamed line by line; pagination params are ignored.
    if (format?.toLowerCase() === 'ndjson') {
      // Spec 1721 / FR-13 — input the search would reject before scraping is
      // a 400 here, while no status line has been committed yet; inside the
      // stream it could only be a `201` + an `error` line.
      this.jobsService.assertSearchable(input);
      return this.streamNdjson(
        input,
        { dedup, liveness: parseBool(livenessRaw), legitimacy: parseBool(legitimacyRaw) },
        res,
      );
    }

    // ── Cache → fan-out → dedup (shared with NDJSON) ──
    const { aggregated, perSource, fromCache } = await this.runSearch(input, dedup);
    const jobs = aggregated.jobs;

    // ── Output window (Spec 5025) ─────────
    // Resolved BEFORE enrichment so corpus signals are computed only for the
    // records we actually return. Previously the pagination slice happened
    // *after* `enrichLiveness`, so a `?paginate=true&page_size=25` request over
    // a 16 000-job corpus issued 16 000 outbound liveness probes and then threw
    // 15 975 of the verdicts away — minutes to tens of minutes of work, and the
    // whole corpus pinned in memory for the duration, per request.
    //
    // CSV returns the full set, so it keeps the full-corpus window.
    const isCsv = format?.toLowerCase() === 'csv';
    const paginate = !isCsv && parseBool(paginateRaw);

    let page = 1;
    let pageSize = 0;
    let totalPages = 0;
    let outputJobs = jobs;

    if (paginate) {
      page = Math.max(1, parseNum(pageRaw) ?? 1);
      pageSize = Math.min(100, Math.max(1, parseNum(pageSizeRaw) ?? 10));
      totalPages = Math.ceil(jobs.length / pageSize);
      const start = (page - 1) * pageSize;
      outputJobs = jobs.slice(start, start + pageSize);
    }

    // ── Corpus signals (Spec 740; scoped by Spec 5025) — opt-in ──
    await this.applyCorpusSignals(outputJobs, parseBool(livenessRaw), parseBool(legitimacyRaw));

    // ── CSV output ────────────────────────
    if (isCsv) {
      const csvLines = this.jobsToCsv(outputJobs);
      res!.setHeader('Content-Type', 'text/csv');
      res!.setHeader('Content-Disposition', 'attachment; filename=jobs.csv');
      return new StreamableFile(Buffer.from(csvLines, 'utf-8'));
    }

    // ── Per-source diagnostics (opt-in, filtered, capped) ──
    const diagnostics = summarizeSourceDiagnostics(
      perSource,
      parseDiagnosticsMode(diagnosticsRaw),
      parseLimit(diagnosticsLimitRaw) ?? DEFAULT_DIAGNOSTICS_LIMIT,
    );

    // ── Pagination ────────────────────────
    if (paginate) {
      return {
        count: jobs.length,
        total_pages: totalPages,
        current_page: page,
        page_size: pageSize,
        jobs: outputJobs,
        cached: fromCache,
        deduped: aggregated.deduped,
        raw_count: aggregated.rawCount,
        dedup_metrics: aggregated.dedupMetrics,
        per_source: diagnostics.rows,
        per_source_summary: diagnostics.summary,
        next_page: page < totalPages ? page + 1 : null,
        previous_page: page > 1 ? page - 1 : null,
      };
    }

    // ── Standard JSON ─────────────────────
    // `outputJobs === jobs` on this path (no pagination window was applied);
    // referencing it keeps the "enriched set is exactly the returned set"
    // invariant visible at every exit.
    return {
      count: jobs.length,
      jobs: outputJobs,
      cached: fromCache,
      deduped: aggregated.deduped,
      raw_count: aggregated.rawCount,
      dedup_metrics: aggregated.dedupMetrics,
      per_source: diagnostics.rows,
      per_source_summary: diagnostics.summary,
    };
  }

  /**
   * POST /api/jobs/analyze
   *
   * Searches jobs then returns summary statistics, company intelligence,
   * and per-site comparison — a different response shape from /search.
   */
  @Post('analyze')
  @ApiOperation({
    summary: 'Search and analyze jobs',
    description:
      'Searches jobs from selected sites, then returns summary statistics, company intelligence, and per-site comparison.',
  })
  @ApiResponse({
    status: 200,
    description: 'Full analysis including summary, company insights, and site comparison.',
  })
  async analyzeJobs(@Body() input: ScraperInputDto): Promise<JobAnalysisDto> {
    this.logger.log(
      `Analyze request: sites=${input.siteType?.join(',') ?? 'all'}, term=${describeTerm(input)}, location=${input.location ? JSON.stringify(input.location) : '<none>'}`,
    );
    const jobs = await this.jobsService.searchJobs(input);
    const analysis = this.analyticsService.analyze(jobs);
    this.logger.log(`Analysis complete: ${analysis.summary.totalJobs} jobs, ${analysis.companies.length} companies`);
    return analysis;
  }

  // ── Shared search pipeline (JSON + NDJSON) ──

  /**
   * Cache lookup → fan-out on miss → cache write (RAW fan-out) → dedup +
   * optional persistence. The single implementation behind both the JSON and
   * the NDJSON path, so the two can never return different job sets.
   */
  private async runSearch(
    input: ScraperInputDto,
    dedup: boolean,
    hooks: SearchRunOptions = {},
  ): Promise<{ aggregated: AggregateResult; perSource: SourceDiagnosticDto[]; fromCache: boolean }> {
    // ── Cache check (cache stores RAW fan-out — dedup runs per-request) ──
    const cacheParams = { ...input, endpoint: 'search' };
    const cached = await this.cacheService.get<JobPostDto[]>(cacheParams);
    let rawJobs: JobPostDto[];
    let fromCache = false;
    // Per-source outcome breakdown (Spec 5082). Only meaningful on a fresh
    // fan-out — a cache hit ran no scrapers, so it stays empty.
    let perSource: SourceDiagnosticDto[] = [];

    if (cached) {
      rawJobs = cached;
      fromCache = true;
      this.logger.log(`Cache hit — returning ${rawJobs.length} cached results`);
    } else {
      const result =
        hooks.onProgress || hooks.isCancelled
          ? await this.jobsService.searchJobsWithDiagnostics(input, hooks)
          : await this.jobsService.searchJobsWithDiagnostics(input);
      // Spec 1721 / FR-14 — sources were left unstarted because the caller
      // went away: a partial answer must never be cached (a retry would be
      // served the truncated set), deduped or persisted.
      if (result.cancelled) {
        throw new SearchCancelledError();
      }
      rawJobs = result.jobs;
      perSource = result.perSource;
      await this.cacheService.set(cacheParams, rawJobs);
    }

    // ── Dedup (Spec 003 / FR-1) ───────────
    // Persistence follows `store.persistSearch` (Spec 5024; since Spec 1722
    // off by default, on by default for an explicitly selected durable store).
    // The fallback below only applies when no configuration is loaded at all.
    const persist = this.configService.get<boolean>('store.persistSearch', true);
    const aggregated = await this.aggregator.aggregateRaw(rawJobs, { dedup, persist });

    this.logger.log(
      `Returning ${aggregated.jobs.length} jobs (raw=${aggregated.rawCount}, deduped=${aggregated.deduped}, cached=${fromCache})`,
    );
    return { aggregated, perSource, fromCache };
  }

  // ── NDJSON streaming (Spec 1721) ──

  /**
   * Start an NDJSON response and return it as a `StreamableFile`.
   *
   * The producer runs detached: this method returns before any scraping so
   * Nest's interceptors finish first (flushing from inside the handler would
   * make `LoggingInterceptor`'s `X-Process-Time` header throw). The first
   * line is written into the stream synchronously, here (Spec 1721 / FR-12),
   * so the headers reach the client as soon as Nest pipes the stream — before
   * the cache lookup, and on a cache hit before dedup/persistence of the whole
   * cached set, which can take seconds.
   */
  private streamNdjson(
    input: ScraperInputDto,
    flags: { dedup: boolean; liveness: boolean; legitimacy: boolean },
    res?: Response,
  ): StreamableFile {
    const startedAt = Date.now();
    res?.setHeader('Content-Type', NDJSON_CONTENT_TYPE);
    res?.setHeader('Cache-Control', 'no-cache');
    // nginx (ingress) buffers proxied responses by default; this header turns
    // that off for this response so lines reach the client as written.
    res?.setHeader('X-Accel-Buffering', 'no');

    const writer = new NdjsonWriter();
    // A client that goes away stops the writer and, through `isCancelled`
    // below, stops the fan-out from STARTING further sources (Spec 1721 /
    // FR-14). In-flight scrapers cannot be aborted (no AbortSignal in the
    // plugin contract) and finish detached, as they do at the deadline.
    res?.once?.('close', () => {
      if (!writer.isClosed) {
        this.logger.warn('NDJSON client disconnected before the end line');
        writer.abort();
      }
    });

    // Spec 1721 / FR-12 — the first line, synchronously. It is also what the
    // heartbeat repeats until the fan-out reports real progress.
    let latest: SearchProgress = { sourcesDone: 0, sourcesTotal: 0, jobs: 0 };
    writer.writeNow({ type: 'progress', ...latest });
    let announced = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      writer.writeNow({ type: 'progress', ...latest });
    }, NDJSON_HEARTBEAT_MS);
    heartbeat.unref?.();
    const stopHeartbeat = (): void => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    const onProgress = (progress: SearchProgress): void => {
      latest = { ...progress };
      if (!announced) {
        // Fan-out start: the first line, sent immediately.
        announced = true;
        writer.writeNow({ type: 'progress', ...latest });
      }
    };

    void this.produceNdjson(input, flags, writer, onProgress, startedAt, {
      onFetched: (rawCount) => {
        // Cache hit: no fan-out ran; report the set's size in the heartbeats
        // that keep the connection alive while liveness works through it.
        if (!announced) latest = { sourcesDone: 0, sourcesTotal: 0, jobs: rawCount };
      },
      // No progress line may land between job lines or after the end line.
      onStreamStart: stopHeartbeat,
      isCancelled: () => writer.isClosed,
    }).finally(stopHeartbeat);

    return new StreamableFile(writer.stream, { type: NDJSON_CONTENT_TYPE });
  }

  /**
   * Body of the NDJSON response. Never rejects: every failure becomes one
   * `{"type":"error"}` line and the stream closes WITHOUT an `end` line,
   * which is how consumers recognise a truncated result.
   */
  private async produceNdjson(
    input: ScraperInputDto,
    flags: { dedup: boolean; liveness: boolean; legitimacy: boolean },
    writer: NdjsonWriter,
    onProgress: (progress: SearchProgress) => void,
    startedAt: number,
    hooks: {
      onFetched: (rawCount: number) => void;
      onStreamStart: () => void;
      isCancelled: () => boolean;
    },
  ): Promise<void> {
    try {
      const { aggregated, fromCache } = await this.runSearch(input, flags.dedup, {
        onProgress,
        isCancelled: hooks.isCancelled,
      });
      hooks.onFetched(aggregated.rawCount);
      const jobs = aggregated.jobs;
      await this.applyCorpusSignals(jobs, flags.liveness, flags.legitimacy);

      hooks.onStreamStart();
      for (const job of jobs) {
        if (!(await writer.writeJob(job))) return; // consumer went away
      }
      await writer.write({
        type: 'end',
        total: jobs.length,
        deduped: aggregated.deduped,
        durationMs: Date.now() - startedAt,
      });
      writer.end();
      this.logger.log(
        `NDJSON stream complete: ${jobs.length} jobs (cached=${fromCache}) in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      if (err instanceof SearchCancelledError) {
        // Nobody is reading: nothing to write, nothing cached or persisted.
        this.logger.warn(`NDJSON search abandoned after ${Date.now() - startedAt}ms: ${err.message}`);
        writer.end();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`NDJSON stream failed after headers: ${message}`);
      writer.writeNow({ type: 'error', message });
      writer.end();
    }
  }

  // ── Corpus-signal enrichment (Spec 740) ──

  /**
   * Opt-in corpus signals for exactly the jobs being returned.
   * Order matters: legitimacy folds in liveness's off-platform redirect
   * signal (`job.liveness?.state === 'expired'`), so liveness runs first.
   */
  private async applyCorpusSignals(
    jobs: JobPostDto[],
    liveness: boolean,
    legitimacy: boolean,
  ): Promise<void> {
    if (liveness && this.livenessChecker && this.livenessAllowed()) {
      await this.enrichLiveness(jobs);
    }
    if (legitimacy && this.legitimacyChecker) {
      this.enrichLegitimacy(jobs);
    }
  }

  /**
   * Spec 1723 — server gate. `EVER_JOBS_LIVENESS_ENABLED=false` refuses the
   * per-request flag: nothing is probed and no `liveness` field is set.
   */
  private livenessAllowed(): boolean {
    const enabled = this.configService.get<boolean>('liveness.enabled', true) !== false;
    if (!enabled) {
      this.logger.debug('liveness requested but EVER_JOBS_LIVENESS_ENABLED=false — not probing');
    }
    return enabled;
  }

  /**
   * Attach per-posting liveness (active/expired/uncertain) by probing each result URL via the
   * `ILivenessChecker` (Spec 721). Best-effort: any failure degrades the whole batch to
   * `uncertain` and never aborts the request.
   *
   * Spec 1723 — at most `EVER_JOBS_LIVENESS_MAX_URLS` URLs (default 100) are probed, the
   * first ones in output order; jobs past the cap are left without a `liveness` field.
   */
  private async enrichLiveness(jobs: JobPostDto[]): Promise<void> {
    const maxUrls = this.configService.get<number>('liveness.maxUrls', DEFAULT_LIVENESS_MAX_URLS);
    if (maxUrls > 0 && jobs.length > maxUrls) {
      this.logger.warn(
        `Liveness capped: probing ${maxUrls} of ${jobs.length} jobs (EVER_JOBS_LIVENESS_MAX_URLS)`,
      );
      jobs = jobs.slice(0, maxUrls);
    }
    try {
      const verdicts = await this.livenessChecker!.checkBatch(
        jobs.map((j) => j.jobUrl),
      );
      jobs.forEach((job, i) => {
        const v = verdicts[i];
        job.liveness = v
          ? { state: v.result, checkedAt: v.checkedAt }
          : { state: 'uncertain' };
      });
    } catch (err) {
      this.logger.warn(
        `Liveness enrichment failed; defaulting to uncertain: ${err instanceof Error ? err.message : err}`,
      );
      for (const job of jobs) job.liveness = { state: 'uncertain' };
    }
  }

  /**
   * Attach per-posting legitimacy (verified/likely/uncertain) via the deterministic
   * `ILegitimacyChecker` (Spec 740). Pure + in-memory; derives its input from already-present
   * fields. Folds in the liveness off-platform redirect when liveness ran first.
   */
  private enrichLegitimacy(jobs: JobPostDto[]): void {
    const inputs: LegitimacyInput[] = jobs.map((job) => ({
      hasCompensation: job.compensation != null,
      sourceCount: 1,
      isFromAts: !!job.atsType,
      hasCompanyLogo: !!job.companyLogo,
      descriptionLength: job.description?.length ?? 0,
      redirectsOffPlatform: job.liveness?.state === 'expired' ? true : undefined,
    }));
    const verdicts = this.legitimacyChecker!.assessBatch(inputs);
    jobs.forEach((job, i) => {
      const v = verdicts[i]!;
      job.legitimacy = { state: v.state, reasons: v.reasons };
    });
  }

  // ── CSV helper ──────────────────────────

  /** Convert jobs array to CSV string. */
  private jobsToCsv(jobs: JobPostDto[]): string {
    if (jobs.length === 0) return 'No results\n';

    // Flatten nested objects for CSV
    const flatJobs = jobs.map((job) => {
      const flat: Record<string, string> = {};
      for (const [key, value] of Object.entries(job)) {
        if (value === null || value === undefined) {
          flat[key] = '';
        } else if (typeof value === 'object' && !Array.isArray(value)) {
          for (const [subKey, subVal] of Object.entries(value as Record<string, any>)) {
            // Nested arrays (e.g. `legitimacy.reasons`) read like top-level ones.
            flat[`${key}.${subKey}`] = Array.isArray(subVal)
              ? subVal.join('; ')
              : String(subVal ?? '');
          }
        } else if (Array.isArray(value)) {
          flat[key] = value.join('; ');
        } else {
          flat[key] = String(value);
        }
      }
      return flat;
    });

    // Collect all unique headers
    const headers = new Set<string>();
    for (const row of flatJobs) {
      for (const key of Object.keys(row)) {
        headers.add(key);
      }
    }
    const headerArr = [...headers];

    const escape = (v: string) => {
      if (v.includes(',') || v.includes('"') || v.includes('\n')) {
        return `"${v.replace(/"/g, '""')}"`;
      }
      return v;
    };

    const lines = [headerArr.map(escape).join(',')];
    for (const row of flatJobs) {
      lines.push(headerArr.map((h) => escape(row[h] ?? '')).join(','));
    }
    return lines.join('\n') + '\n';
  }
}
