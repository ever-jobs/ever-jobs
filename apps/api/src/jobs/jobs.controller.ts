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
import { JobsAggregator } from './jobs.aggregator';
import { AnalyticsService } from '@ever-jobs/analytics';
import { CacheService } from '../cache/cache.service';

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
   *   ?paginate=true&page=1&page_size=10 → paginated JSON
   *   ?dedup=false   → opt out of cross-source deduplication (default true)
   */
  @Post('search')
  @ApiOperation({
    summary: 'Search for jobs across multiple sources',
    description:
      'Searches selected job boards concurrently and returns a merged, sorted list of job postings. ' +
      'Supports caching, CSV export (via ?format=csv), pagination (via ?paginate=true), and ' +
      'cross-source deduplication (default ?dedup=true; pass ?dedup=false to opt out).',
  })
  @ApiQuery({ name: 'format', required: false, description: 'Output format: json (default) or csv', example: 'json' })
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
  @ApiResponse({ status: 200, description: 'Job search results' })
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
    this.logger.log(
      `Search request: sites=${input.siteType?.join(',') ?? 'all'}, term="${input.searchTerm}", location="${input.location}"`,
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
    const parseDiagnosticsMode = (v?: string): DiagnosticsMode => {
      if (v === undefined) return 'off';
      const s = v.toLowerCase();
      if (s === 'all') return 'all';
      if (['true', '1', 'yes'].includes(s)) return 'actionable';
      return 'off';
    };

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
      const result = await this.jobsService.searchJobsWithDiagnostics(input);
      rawJobs = result.jobs;
      perSource = result.perSource;
      await this.cacheService.set(cacheParams, rawJobs);
    }

    // ── Dedup (Spec 003 / FR-1) ───────────
    const dedup = parseBoolWithDefault(dedupRaw, true);
    // Spec 5024 — persistence on the interactive path is opt-out via
    // `EVER_JOBS_PERSIST_SEARCH`. Default stays `true` (historical
    // behaviour); deployments on the in-process `memory` backend should
    // disable it, since nothing in `apps/api` reads the corpus back.
    const persist = this.configService.get<boolean>('store.persistSearch', true);
    const aggregated = await this.aggregator.aggregateRaw(rawJobs, { dedup, persist });
    const jobs = aggregated.jobs;

    this.logger.log(
      `Returning ${jobs.length} jobs (raw=${aggregated.rawCount}, deduped=${aggregated.deduped}, cached=${fromCache})`,
    );

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
    // Order matters: legitimacy folds in liveness's off-platform redirect
    // signal (`job.liveness?.state === 'expired'`), so liveness runs first.
    if (parseBool(livenessRaw) && this.livenessChecker) {
      await this.enrichLiveness(outputJobs);
    }
    if (parseBool(legitimacyRaw) && this.legitimacyChecker) {
      this.enrichLegitimacy(outputJobs);
    }

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
      parseNum(diagnosticsLimitRaw) ?? DEFAULT_DIAGNOSTICS_LIMIT,
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
      `Analyze request: sites=${input.siteType?.join(',') ?? 'all'}, term="${input.searchTerm}", location="${input.location}"`,
    );
    const jobs = await this.jobsService.searchJobs(input);
    const analysis = this.analyticsService.analyze(jobs);
    this.logger.log(`Analysis complete: ${analysis.summary.totalJobs} jobs, ${analysis.companies.length} companies`);
    return analysis;
  }

  // ── Corpus-signal enrichment (Spec 740) ──

  /**
   * Attach per-posting liveness (active/expired/uncertain) by probing each result URL via the
   * `ILivenessChecker` (Spec 721). Best-effort: any failure degrades the whole batch to
   * `uncertain` and never aborts the request.
   */
  private async enrichLiveness(jobs: JobPostDto[]): Promise<void> {
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
            flat[`${key}.${subKey}`] = String(subVal ?? '');
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
