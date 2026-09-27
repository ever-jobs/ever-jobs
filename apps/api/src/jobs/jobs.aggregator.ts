import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CAREER_LEVEL_CLASSIFIER_TOKEN,
  CanonicalJob,
  type CareerLevel,
  type CareerLevelInput,
  type CareerLevelVerdict,
  DEDUP_ENGINE_TOKEN,
  DedupMetrics,
  ICareerLevelClassifier,
  IDedupEngine,
  IJobObservationStore,
  IJobStore,
  isCareerLevel,
  JOB_OBSERVATION_STORE_TOKEN,
  JOB_STORE_TOKEN,
  JobPostDto,
  LocationDto,
  ScraperInputDto,
} from '@ever-jobs/models';
import {
  CompiledJobExclusions,
  ExclusionMatch,
  JobExclusionMetrics,
  JobExclusionSpec,
  MAX_EXCLUSION_SAMPLES,
  buildExclusionMetrics,
  clusterKeyForJob,
  compileJobExclusions,
  dedupKeyForJob,
  matchJobExclusion,
  YieldBudget,
} from '@ever-jobs/common';
import { JobsService } from './jobs.service';

/**
 * Per-call options for {@link JobsAggregator.aggregate} /
 * {@link JobsAggregator.aggregateRaw}.
 */
export interface AggregateOptions {
  /**
   * Run the bound `IDedupEngine` over the fan-out result. Default: `true`
   * when an engine is bound (Spec 003 / Phase 5 migration plan).
   *
   * Setting `dedup=false` returns the raw fan-out unchanged — the only
   * supported way for legacy clients to opt out of dedup.
   */
  readonly dedup?: boolean;

  /**
   * Persist post-dedup canonical records (and their source observations)
   * via the bound `IJobStore` / `IJobObservationStore` (Spec 004 / T11).
   * Default: `true`.
   *
   * Persistence is best-effort: a backend-down blip MUST NOT turn a
   * successful search into a 500. Failures surface via
   * {@link AggregateResult.persistError} so callers / dashboards / metrics
   * can observe them without coupling to the response status code.
   *
   * Setting `persist=false` short-circuits the side-effect entirely —
   * useful for ephemeral / preview searches and for tests that don't
   * care about the store. Per Q-018 (run #25), `persist=true` with no
   * store bound is also a silent no-op (matches the dedup precedent:
   * "when nothing is bound the aggregator is a pass-through").
   */
  readonly persist?: boolean;

  /**
   * Keep only jobs whose `careerLevel.level` is in this list (Spec 1730, FR-8). Applied after
   * dedup and classification; `undefined` or `[]` means no filter. Values outside
   * `CAREER_LEVELS` are ignored here — the REST DTO / GraphQL resolver reject them first.
   * Callers pass `careerLevels: input.careerLevels`; `aggregate()` reads it from the input.
   * For `aggregateRaw()` the key is required, see {@link AggregateRawOptions}.
   *
   * The filter fails closed (Q-106): when it cannot be applied — no classifier bound, or
   * classification failed — the aggregator throws `ServiceUnavailableException` (503) rather
   * than return the unfiltered set. A successful result therefore always means "filtered".
   */
  readonly careerLevels?: ReadonlyArray<string>;

  /**
   * Leave `careerLevel` for the caller to attach to the jobs it actually returns (Spec 1730,
   * FR-12): a page of a paginated search, or each chunk of a stream, via
   * {@link JobsAggregator.attachCareerLevel}. Without it the whole deduplicated set is classified
   * here, which for a 30,000-job list-mode search means 30,000 classifications to serve a
   * 10-job page. {@link AggregateResult.careerLevelDeferred} says whether the caller now owes
   * that call.
   *
   * Ignored when a `careerLevels` filter is set: the filter needs a verdict for every job, so
   * all of them are classified (and attached) here, and nothing is deferred. Default `false`.
   */
  readonly deferCareerLevel?: boolean;

  /**
   * Post-scrape exclusion filters (Spec 1700). A per-request VIEW filter:
   * matching jobs are removed from {@link AggregateResult.jobs}, but the
   * persisted corpus still receives every canonical record and the cache
   * (which the controller writes before this runs) holds the raw fan-out.
   *
   * With dedup, a cluster is dropped when ANY of its members matches — sources
   * describe the same job differently, and dropping only the matching
   * observation would leak a job the caller explicitly excluded through a
   * representative with an empty description.
   *
   * Absent → the code path and the result object are exactly the
   * pre-Spec-1700 ones (no exclusion keys). Present but inactive (empty
   * lists) → nothing is removed and zeroed metrics are returned.
   */
  readonly exclusions?: JobExclusionSpec | CompiledJobExclusions;
}

/**
 * Options for {@link JobsAggregator.aggregateRaw}: {@link AggregateOptions} with `careerLevels`
 * as a REQUIRED key whenever options are passed (`careerLevels: undefined` means "no filter").
 *
 * `aggregateRaw` never sees the request DTO, so this argument is the only way the filter reaches
 * it, for every response format (JSON, CSV, NDJSON, GraphQL). A call site rebuilt as
 * `{ dedup, persist }` (a refactor, or a merge resolved against a branch that predates the
 * filter) would otherwise compile and silently serve the unfiltered set: the filter would fail
 * OPEN. With the key required it does not compile (Spec 1730 review).
 */
export type AggregateRawOptions = AggregateOptions & {
  readonly careerLevels: AggregateOptions['careerLevels'];
};

/**
 * Jobs handed to `classifyBatch` per call. Small enough that one chunk stays around the yield
 * budget even on a loaded machine (~100 µs/job idle, ~450 µs/job under a parallel jest run), so
 * the budget check between chunks bounds the event-loop stall (Spec 1730, NFR-2).
 */
const CAREER_LEVEL_CHUNK = 16;

/**
 * Envelope returned by the aggregator. The shape is intentionally additive:
 * `jobs` is always populated (raw or deduped) so existing controller code
 * keeps working without conditional handling.
 */
export interface AggregateResult {
  /** Final job list — deduped when `dedup=true` and an engine is bound. */
  readonly jobs: JobPostDto[];
  /** Pre-dedup count. Equals `rawJobs.length`. */
  readonly rawCount: number;
  /** Post-dedup count. Equals `jobs.length`. */
  readonly outputCount: number;
  /** `true` iff the dedup engine actually ran. */
  readonly deduped: boolean;
  /** Populated only when {@link deduped} is `true`. */
  readonly dedupMetrics?: DedupMetrics;
  /**
   * `true` iff a backend was bound, `persist` was not opted out, and
   * the upsertMany call succeeded. Spec 004 / T11.
   */
  readonly persisted?: boolean;
  /**
   * Insert / update accounting from `IJobStore.upsertMany`. Populated
   * only when {@link persisted} is `true` and the active backend
   * advertises real counts (in-memory backends always return
   * `{ inserted, updated }`; Postgres / SQLite return real `ON CONFLICT`
   * counts).
   */
  readonly persistCounts?: { readonly inserted: number; readonly updated: number };
  /**
   * Populated only when persistence was attempted AND failed (i.e.
   * `persist=true`, a store WAS bound, and upsertMany / putAll
   * rejected). Carries the wire-stable error code (`ERR_STORE_BACKEND_DOWN`
   * / `ERR_STORE_INVALID_CURSOR` / generic `ERR_STORE_PERSIST_FAILED`)
   * plus the message. Operators read this from logs / metrics; callers
   * can surface it as a response header without blocking the response
   * body.
   */
  readonly persistError?: { readonly code: string; readonly message: string };
  /**
   * Number of jobs the `careerLevels` filter removed (Spec 1730). Present only when a filter
   * ran; `jobs` / `outputCount` are then post-filter.
   */
  readonly careerLevelFilteredOut?: number;
  /**
   * `true` when classification was deferred to the caller (Spec 1730, FR-12): it asked for it
   * (`deferCareerLevel`), no filter needed the verdicts, attachment is on and a classifier is
   * bound. The jobs carry no `careerLevel` yet; the caller must pass every job it returns to
   * {@link JobsAggregator.attachCareerLevel}. Absent otherwise — the jobs are then final.
   */
  readonly careerLevelDeferred?: boolean;
  /**
   * Populated only when {@link AggregateOptions.exclusions} was supplied and
   * the filter ran (Spec 1700). `excludedCount` counts removed results (whole
   * clusters when dedup ran); `excludedRawCount` counts matching raw rows,
   * including rows the dedup engine rejected. `rawCount` keeps its meaning
   * (pre-dedup, pre-exclusion); `outputCount` is post-exclusion.
   */
  readonly exclusionMetrics?: JobExclusionMetrics;
  /** Up to {@link MAX_EXCLUSION_SAMPLES} excluded raw rows and why (Spec 1700). */
  readonly excludedSamples?: ReadonlyArray<{ readonly job: JobPostDto; readonly match: ExclusionMatch }>;
  /**
   * Set when the exclusion filter itself failed (Spec 1700). The search then
   * returns the unfiltered list rather than a 500 — the filter is optional,
   * the search is not. Same shape as {@link persistError}.
   */
  readonly exclusionError?: { readonly code: string; readonly message: string };
}

/**
 * Error code surfaced via {@link AggregateResult.exclusionError} (Spec 1700).
 */
export const ERR_EXCLUSION_FAILED = 'ERR_EXCLUSION_FAILED';

/**
 * Generic fallback error code surfaced via {@link AggregateResult.persistError}
 * when the underlying backend rejection lacks a structured `.code`.
 * Distinct from the well-known Spec 004 §7.3 codes
 * (`ERR_STORE_NOT_FOUND` / `ERR_STORE_BACKEND_DOWN` / `ERR_STORE_INVALID_CURSOR`)
 * so log queries can grep "ERR_STORE_PERSIST_FAILED" specifically when
 * triaging aggregator-side persistence drops.
 */
export const ERR_STORE_PERSIST_FAILED = 'ERR_STORE_PERSIST_FAILED';

/**
 * Thin orchestration layer between {@link JobsService} (fan-out), the
 * dedup engine (Spec 003 / Phase 5), and the persistent store
 * (Spec 004 / Phase 5).
 *
 * The aggregator is intentionally minimal — it does **not** own caching,
 * salary post-processing, or sorting (those still live in `JobsService`).
 * It only:
 *
 *   1. delegates fan-out to `JobsService.searchJobs`;
 *   2. invokes the bound `IDedupEngine` (if present and the caller didn't
 *      opt out) to collapse near-duplicates across sources;
 *   3. picks the **first** raw `JobPostDto` per canonical cluster as the
 *      "winning" representative — this preserves the input sort order
 *      established by `JobsService` (site asc, then posted time desc -
 *      `datePostedAt` when present, else `datePosted`; Spec 1696);
 *   4. (Spec 004 / T11) persists the post-dedup `CanonicalJob[]` plus
 *      their `SourceObservation[]` via the bound `IJobStore` /
 *      `IJobObservationStore`, **best-effort**: any backend failure is
 *      logged and surfaced via {@link AggregateResult.persistError} but
 *      MUST NOT fail the request. Persistence runs only when an engine
 *      is bound (i.e. dedup actually produced a `canonical[]` list);
 *      pure pass-through paths skip persistence by construction.
 *
 * The engine and store bindings are **optional** so that environments
 * that haven't imported `DedupHybridModule` / `StoreModule.forActive` (or
 * that swap them for no-ops via DI) keep working. When no engine is
 * bound the aggregator is a pass-through. When no store is bound
 * persistence is silently a no-op (Q-018 / run #25).
 */
@Injectable()
export class JobsAggregator {
  private readonly logger = new Logger(JobsAggregator.name);

  constructor(
    private readonly jobsService: JobsService,
    @Optional() @Inject(DEDUP_ENGINE_TOKEN) private readonly dedupEngine?: IDedupEngine,
    @Optional() @Inject(JOB_STORE_TOKEN) private readonly jobStore?: IJobStore,
    @Optional() @Inject(JOB_OBSERVATION_STORE_TOKEN)
    private readonly observationStore?: IJobObservationStore,
    /**
     * Spec 1730 — career-level classifier. Optional like the other bindings: when unbound
     * (tests, a deployment that dropped the plugin) jobs are returned unclassified.
     */
    @Optional() @Inject(CAREER_LEVEL_CLASSIFIER_TOKEN)
    private readonly careerLevelClassifier?: ICareerLevelClassifier,
    /** Reads `careerLevel.classify` (`EVER_JOBS_CLASSIFY_CAREER_LEVEL`); absent → enabled. */
    @Optional() private readonly configService?: ConfigService,
  ) {}

  /**
   * Fan-out then optionally dedup.
   *
   * Use this when you have an input DTO and want the full pipeline.
   */
  async aggregate(
    input: ScraperInputDto,
    options: AggregateOptions = {},
  ): Promise<AggregateResult> {
    const rawJobs = await this.jobsService.searchJobs(input);
    return this.aggregateRaw(rawJobs, {
      ...options,
      careerLevels: options.careerLevels ?? input.careerLevels,
    });
  }

  /**
   * Dedup (and persist) an already-fanned-out list, then attach `careerLevel` to every returned
   * job and apply the optional `careerLevels` filter (Spec 1730).
   *
   * Classification runs here — once, after dedup — so every response shape built from this
   * result carries the field without format-specific code. A caller that returns only part of
   * the result (a page, a stream written chunk by chunk) passes `deferCareerLevel` and classifies
   * just that part with {@link attachCareerLevel} (FR-12); a filter always classifies everything
   * here. See {@link dedupAndPersist} for the dedup / persistence contract, which is unchanged.
   */
  async aggregateRaw(
    rawJobs: JobPostDto[],
    options: AggregateRawOptions = { careerLevels: undefined },
  ): Promise<AggregateResult> {
    // Fail fast (Q-106): a filter that cannot run must not cost a dedup + persist pass first.
    if (wantedCareerLevels(options).size > 0 && !this.careerLevelClassifier) {
      this.logger.warn('careerLevels filter requested but no ICareerLevelClassifier is bound — 503');
      throw new ServiceUnavailableException(
        'careerLevels filter could not be applied: no career-level classifier is available',
      );
    }
    const result = await this.dedupAndPersist(rawJobs, options);
    return this.applyCareerLevel(result, options);
  }

  /**
   * Spec 1730 — attach `careerLevel` (unless `EVER_JOBS_CLASSIFY_CAREER_LEVEL=false`) and apply
   * the `careerLevels` filter. Never mutates the input array (it may be the cached fan-out); a
   * filter returns a new array. The source `jobType` / `jobLevel` fields are left untouched.
   *
   * Classification is cooperative: it runs in small chunks and hands the event loop back every
   * 10 ms (`DEFAULT_YIELD_BUDGET_MS`, `@ever-jobs/common`), so a 30,000-job keyword-less result
   * cannot starve `/health` (Spec 1730, NFR-2; the incident class recorded in
   * `dedup-hybrid/src/cooperative.ts`).
   *
   * Failure handling: with no filter, a classifier failure logs and returns the jobs
   * unclassified (the field is additive). With a filter it throws `ServiceUnavailableException`
   * (503): returning the unfiltered set would silently answer a different question (Q-106).
   *
   * With `deferCareerLevel` and no filter nothing is classified here: the result says
   * `careerLevelDeferred: true` and the caller classifies what it returns (FR-12).
   */
  private async applyCareerLevel(
    result: AggregateResult,
    options: AggregateOptions,
  ): Promise<AggregateResult> {
    const attach = this.careerLevelAttachEnabled();
    const wanted = wantedCareerLevels(options);
    const filter = wanted.size > 0;
    if (!attach && !filter) return result;
    // Unreachable with a filter (aggregateRaw failed fast); without one, jobs stay unclassified.
    if (!this.careerLevelClassifier) return result;
    // FR-12 — no filter needs the verdicts, so only the jobs the caller returns are classified.
    if (!filter && options.deferCareerLevel) return { ...result, careerLevelDeferred: true };

    let verdicts: CareerLevelVerdict[];
    try {
      verdicts = await this.classifyCooperatively(this.careerLevelClassifier, result.jobs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (filter) {
        this.logger.warn(
          `career-level classification failed; careerLevels filter cannot be applied — 503: ${message}`,
        );
        throw new ServiceUnavailableException(
          'careerLevels filter could not be applied: career-level classification failed',
        );
      }
      this.logger.warn(`career-level classification failed; returning jobs unclassified: ${message}`);
      return result;
    }

    if (attach) {
      result.jobs.forEach((job, i) => {
        job.careerLevel = verdicts[i];
      });
    }
    if (!filter) return result;

    // Q-106: with attachment switched off the filter is still honoured (the verdicts above are
    // transient); the caller asked for it explicitly.
    const kept = result.jobs.filter((_, i) => wanted.has(verdicts[i]!.level));
    this.logger.log(
      `careerLevels [${[...wanted].join(',')}]: ${result.jobs.length} → ${kept.length}`,
    );
    return {
      ...result,
      jobs: kept,
      outputCount: kept.length,
      careerLevelFilteredOut: result.jobs.length - kept.length,
    };
  }

  /**
   * Attach `careerLevel` to exactly these jobs, in place (Spec 1730, FR-12). For a caller whose
   * {@link aggregateRaw} result says `careerLevelDeferred`: it passes the jobs it returns — the
   * page, or each chunk of a stream as it is written — so a 10-job page of a 30,000-job search
   * classifies 10 jobs. The verdicts equal what `aggregateRaw` would have attached (the
   * classifier is pure), and classification is as cooperative (NFR-2).
   *
   * No filter depends on these verdicts, so a failure never fails the request: it logs, leaves
   * these jobs unclassified and resolves `false` (as `aggregateRaw` degrades without a filter).
   * A no-op resolving `true` when attachment is off (`EVER_JOBS_CLASSIFY_CAREER_LEVEL=false`),
   * no classifier is bound, or `jobs` is empty.
   */
  async attachCareerLevel(jobs: ReadonlyArray<JobPostDto>): Promise<boolean> {
    if (jobs.length === 0 || !this.careerLevelClassifier || !this.careerLevelAttachEnabled()) {
      return true;
    }
    let verdicts: CareerLevelVerdict[];
    try {
      verdicts = await this.classifyCooperatively(this.careerLevelClassifier, jobs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `career-level classification failed; returning ${jobs.length} jobs unclassified: ${message}`,
      );
      return false;
    }
    jobs.forEach((job, i) => {
      job.careerLevel = verdicts[i];
    });
    return true;
  }

  /** `careerLevel.classify` (`EVER_JOBS_CLASSIFY_CAREER_LEVEL`, FR-7); absent → enabled. */
  private careerLevelAttachEnabled(): boolean {
    return this.configService?.get<boolean>('careerLevel.classify', true) ?? true;
  }

  /**
   * `classifyBatch` over {@link CAREER_LEVEL_CHUNK}-job slices, yielding to the event loop
   * whenever the current slice has held it for the yield budget. Returns one verdict per job, in
   * order. Throws when the classifier throws or returns the wrong number of verdicts, so a
   * broken classifier can never produce a partially classified (or wrongly filtered) result.
   */
  private async classifyCooperatively(
    classifier: ICareerLevelClassifier,
    jobs: ReadonlyArray<JobPostDto>,
  ): Promise<CareerLevelVerdict[]> {
    const verdicts: CareerLevelVerdict[] = new Array(jobs.length);
    const budget = new YieldBudget();
    for (let start = 0; start < jobs.length; start += CAREER_LEVEL_CHUNK) {
      const chunk = jobs.slice(start, start + CAREER_LEVEL_CHUNK);
      const out = classifier.classifyBatch(chunk.map(careerLevelInputOf));
      if (!Array.isArray(out) || out.length !== chunk.length) {
        throw new Error(
          `classifyBatch returned ${Array.isArray(out) ? out.length : typeof out} verdicts for ${chunk.length} jobs`,
        );
      }
      for (let i = 0; i < out.length; i++) {
        const verdict = out[i];
        if (!verdict || !isCareerLevel(verdict.level)) {
          throw new Error(`classifyBatch returned an invalid verdict for job ${start + i}`);
        }
        verdicts[start + i] = verdict;
      }
      await budget.yieldIfExpired();
    }
    return verdicts;
  }

  /**
   * Apply (or skip) dedup on an already-fanned-out list.
   *
   * The controller uses this overload to keep the `cache → dedup` order:
   *   1. cache lookup (raw) — fast path
   *   2. fan-out via `JobsService` on miss
   *   3. cache write (raw) — keeps cache invalidation independent of
   *      dedup-engine version changes
   *   4. dedup pass per-request (this method)
   *   5. (T11) persist post-dedup canonical + observations
   */
  private async dedupAndPersist(
    rawJobs: JobPostDto[],
    options: AggregateOptions = {},
  ): Promise<AggregateResult> {
    const result = await this.aggregateRawUnkeyed(rawJobs, options);
    // Spec 1721 / contract C9 — every returned job carries its stable
    // cross-source key, whichever path produced the list.
    await stampDedupKeys(result.jobs);
    return result;
  }

  private async aggregateRawUnkeyed(
    rawJobs: JobPostDto[],
    options: AggregateOptions,
  ): Promise<AggregateResult> {
    const rawCount = rawJobs.length;
    const wantDedup = options.dedup ?? true;
    // Spec 1700 — `undefined` when the caller supplied no exclusion input, in
    // which case every path below returns exactly its pre-Spec-1700 object.
    const exclusion =
      options.exclusions === undefined
        ? undefined
        : this.evaluateExclusions(rawJobs, options.exclusions);

    if (!wantDedup) {
      return this.passThrough(rawJobs, exclusion);
    }
    if (!this.dedupEngine) {
      this.logger.debug(
        'No IDedupEngine bound under DEDUP_ENGINE_TOKEN — returning raw list',
      );
      return this.passThrough(rawJobs, exclusion);
    }
    if (rawCount === 0) {
      return {
        jobs: rawJobs,
        rawCount,
        outputCount: 0,
        deduped: true,
        dedupMetrics: {
          inputCount: 0,
          outputCount: 0,
          mergedPairs: 0,
          elapsedMs: 0,
        },
        ...this.exclusionFields(rawJobs, exclusion, 0),
      };
    }

    const result = await this.dedupEngine.dedup(rawJobs);

    // Spec 1700 — a cluster is excluded when ANY of its members matched.
    const excludedClusters = new Set<string>();
    if (exclusion?.verdicts) {
      exclusion.verdicts.forEach((verdict, i) => {
        const canonId = result.assignments[i];
        if (verdict && canonId) excludedClusters.add(canonId);
      });
    }

    // Pick the first raw job per canonical cluster. We iterate the input
    // (which is already sorted by `JobsService`) so the representative
    // is the most-recent-on-the-best-site entry — and the output keeps
    // the same site/date ordering as a non-deduped response.
    const seen = new Set<string>();
    const representatives: JobPostDto[] = [];
    const representativeIds: string[] = [];
    const clusterSize = new Map<string, number>();
    let droppedClusters = 0;
    for (let i = 0; i < rawJobs.length; i++) {
      const canonId = result.assignments[i];
      if (!canonId) continue; // rejected by engine
      clusterSize.set(canonId, (clusterSize.get(canonId) ?? 0) + 1);
      if (seen.has(canonId)) continue;
      seen.add(canonId);
      if (excludedClusters.has(canonId)) {
        droppedClusters++;
        continue;
      }
      representatives.push(rawJobs[i]);
      representativeIds.push(canonId);
    }
    // Spec 1724 — merged representatives carry the cluster's union of
    // locations, and representatives the engine kept apart never share a key.
    const deduped = await finalizeRepresentatives(
      representatives,
      representativeIds,
      clusterSize,
      result.canonical,
    );

    this.logger.log(
      `dedup: ${rawCount} → ${deduped.length} (merged ${result.metrics.mergedPairs} pairs in ${result.metrics.elapsedMs}ms)`,
    );

    // Persistence receives the FULL canonical list: exclusion is a
    // per-request view and must not shrink the corpus.
    const persistOutcome = await this.maybePersist(result.canonical, options);

    return {
      jobs: deduped,
      rawCount,
      outputCount: deduped.length,
      deduped: true,
      dedupMetrics: result.metrics,
      ...persistOutcome,
      ...this.exclusionFields(rawJobs, exclusion, droppedClusters),
    };
  }

  /** The `dedup=false` / no-engine result, with exclusions applied row by row. */
  private passThrough(
    rawJobs: JobPostDto[],
    exclusion: ExclusionEvaluation | undefined,
  ): AggregateResult {
    const rawCount = rawJobs.length;
    if (!exclusion) {
      return {
        jobs: rawJobs,
        rawCount,
        outputCount: rawCount,
        deduped: false,
      };
    }
    const verdicts = exclusion.verdicts;
    const jobs = verdicts ? rawJobs.filter((_job, i) => !verdicts[i]) : rawJobs;
    return {
      jobs,
      rawCount,
      outputCount: jobs.length,
      deduped: false,
      ...this.exclusionFields(rawJobs, exclusion, rawCount - jobs.length),
    };
  }

  /**
   * Compile the spec and match every raw row once (Spec 1700). Never throws:
   * a failure is returned as `error` and the caller serves the unfiltered list.
   */
  private evaluateExclusions(
    rawJobs: JobPostDto[],
    spec: JobExclusionSpec | CompiledJobExclusions,
  ): ExclusionEvaluation {
    try {
      const compiled =
        spec instanceof CompiledJobExclusions ? spec : compileJobExclusions(spec);
      if (!compiled.active) return { compiled };
      return {
        compiled,
        verdicts: rawJobs.map((job) => matchJobExclusion(job, compiled)),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `exclusion filter failed: ${message}. Returning the unfiltered list.`,
      );
      return { error: { code: ERR_EXCLUSION_FAILED, message } };
    }
  }

  /** The exclusion keys of an {@link AggregateResult}; empty when none were requested. */
  private exclusionFields(
    rawJobs: JobPostDto[],
    exclusion: ExclusionEvaluation | undefined,
    excludedCount: number,
  ): Partial<AggregateResult> {
    if (!exclusion) return {};
    if (exclusion.error || !exclusion.compiled) {
      return {
        exclusionError: exclusion.error ?? {
          code: ERR_EXCLUSION_FAILED,
          message: 'exclusion filter did not compile',
        },
      };
    }
    const samples: { job: JobPostDto; match: ExclusionMatch }[] = [];
    const matches: ExclusionMatch[] = [];
    exclusion.verdicts?.forEach((match, i) => {
      if (!match) return;
      matches.push(match);
      if (samples.length < MAX_EXCLUSION_SAMPLES) samples.push({ job: rawJobs[i], match });
    });
    const metrics = buildExclusionMetrics(exclusion.compiled, matches, excludedCount);
    this.logger.log(
      `exclusions: excluded=${metrics.excludedCount} raw=${metrics.excludedRawCount} ` +
        `terms=${exclusion.compiled.termCount} ignored=${metrics.ignoredTerms.length}`,
    );
    if (metrics.byTerm.length > 0) {
      this.logger.debug(
        `exclusions by term: ${metrics.byTerm.map((t) => `${t.source}:${JSON.stringify(t.term)}=${t.count}`).join(', ')}`,
      );
    }
    return { exclusionMetrics: metrics, excludedSamples: samples };
  }

  /**
   * Best-effort persistence of the post-dedup canonical records and their
   * source observations. Spec 004 / T11 + Q-018 (run #25, Option A).
   *
   * Returns a partial {@link AggregateResult} carrying only the
   * persistence-related fields, ready to spread into the final result
   * envelope. The four outcomes are:
   *
   *   - `persist=false` opt-out → no fields (consumer sees `persisted`
   *     and friends as `undefined`).
   *   - No `IJobStore` bound → no fields. Matches the dedup-engine
   *     precedent of silently skipping when nothing is wired.
   *   - Empty canonical list → no fields. Avoids a `upsertMany([])`
   *     round-trip on every all-rejected dedup pass.
   *   - Bound + non-empty → attempt `upsertMany` and (when an
   *     observation store is bound and the canonical record carries
   *     observations) `putAll`. Success → `persisted: true` +
   *     `persistCounts`. Failure → `persisted: false` + structured
   *     `persistError`. Errors are caught here and NEVER bubble.
   */
  private async maybePersist(
    canonical: ReadonlyArray<CanonicalJob>,
    options: AggregateOptions,
  ): Promise<Partial<AggregateResult>> {
    const wantPersist = options.persist ?? true;
    if (!wantPersist) return {};
    if (!this.jobStore) {
      this.logger.debug(
        'No IJobStore bound under JOB_STORE_TOKEN — skipping persistence',
      );
      return {};
    }
    if (canonical.length === 0) return {};

    try {
      const counts = await this.jobStore.upsertMany(canonical);
      // Observations are best-effort within best-effort: a successful
      // canonical upsert is the load-bearing write; observation failures
      // degrade to "canonical persisted, observations stale" rather than
      // nuking the persisted flag.
      if (this.observationStore) {
        await this.persistObservations(this.observationStore, canonical);
      }
      this.logger.log(
        `persisted: ${canonical.length} canonical records ` +
          `(inserted=${counts.inserted}, updated=${counts.updated})`,
      );
      return {
        persisted: true,
        persistCounts: counts,
      };
    } catch (err) {
      const code = readErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `persist failed: ${code} — ${message}. Search response continues.`,
      );
      return {
        persisted: false,
        persistError: { code, message },
      };
    }
  }

  /**
   * Write every canonical record's observation set (Spec 1722 / FR-13).
   *
   * A backend with `putAllMany` gets the whole set in one call and batches
   * it itself. Otherwise `putAll` runs per record with at most
   * {@link OBSERVATION_WRITE_CONCURRENCY} in flight: the previous
   * `Promise.allSettled(canonical.map(putAll))` started one transaction per
   * job at once — 25 k of them for a list-mode search — which drained the
   * Postgres pool and failed most of them. Never throws; failures are
   * logged with a count.
   */
  private async persistObservations(
    store: IJobObservationStore,
    canonical: ReadonlyArray<CanonicalJob>,
  ): Promise<void> {
    if (typeof store.putAllMany === 'function') {
      try {
        await store.putAllMany(
          canonical.map((c) => ({ canonicalJobId: c.canonicalJobId, observations: c.sources ?? [] })),
        );
      } catch (err) {
        this.logger.warn(
          `persist observations failed for a batch of ${canonical.length}: ${readErrorCode(err)} — ` +
            `${err instanceof Error ? err.message : String(err)}. Canonical records stay persisted.`,
        );
      }
      return;
    }

    let cursor = 0;
    let failed = 0;
    let firstError: unknown;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= canonical.length) return;
        const c = canonical[index]!;
        try {
          await store.putAll(c.canonicalJobId, c.sources ?? []);
        } catch (err) {
          failed++;
          firstError ??= err;
        }
      }
    };
    await Promise.allSettled(
      Array.from({ length: Math.min(OBSERVATION_WRITE_CONCURRENCY, canonical.length) }, () =>
        worker(),
      ),
    );
    if (failed > 0) {
      this.logger.warn(
        `persist observations: ${failed} of ${canonical.length} putAll calls failed ` +
          `(first: ${firstError instanceof Error ? firstError.message : String(firstError)}). ` +
          'Canonical records stay persisted.',
      );
    }
  }
}

/**
 * Most `putAll` calls in flight at once when the observation store has no
 * `putAllMany` (Spec 1722 / FR-13) — below any sane connection-pool size.
 */
export const OBSERVATION_WRITE_CONCURRENCY = 8;

/**
 * Jobs keyed between event-loop yields in {@link stampDedupKeys}. One key is
 * a normalise + sha-256 (~12 µs); 500 of them is ~6 ms, well under anything a
 * liveness probe or a concurrent request would notice.
 */
const DEDUP_KEY_YIELD_EVERY = 500;

/**
 * Jobs whose `dedupKey` {@link finalizeRepresentatives} already set during
 * this pass. {@link stampDedupKeys} consumes the mark (skip + delete) instead
 * of hashing the job a second time; it must not recompute a copy's key from
 * its widened `locations[]` (Spec 1724). A mark left on a cached raw job by
 * an interleaved request is harmless: that job's key is its own per-job key,
 * which is what recomputing would write.
 */
const PRE_KEYED = new WeakSet<JobPostDto>();

/**
 * Final shape of the deduped representatives (Spec 1724).
 *
 * 1. **Union of locations.** A representative whose cluster merged several
 *    postings carries the cluster's `locations[]` union (the engine's
 *    `CanonicalJob.locations`, head first) when that adds a site it did not
 *    list itself — e.g. a board listing merged into the ATS posting that
 *    names every office.
 * 2. **Stable, distinct keys.** `dedupKey` is the representative's
 *    `clusterKeyForJob` (Spec 1724 review), computed from its own fields
 *    BEFORE the union, so it equals the default engine's cluster id and never
 *    depends on what else is in the batch: the plain per-job key for the
 *    default engagement (full-time, or no employment information), else a key
 *    scoped by the employment class — so an internship and a full-time posting
 *    with the same title, company and location never share a key. When two
 *    representatives still share one (a rare residual: the engine kept them
 *    apart for another reason), each carries its cluster id instead.
 *
 * Representatives whose key or locations differ from what {@link stampDedupKeys}
 * would write are shallow COPIES: the input may be the cached fan-out, which a
 * later `dedup=false` request must see unchanged (with its plain per-job key).
 * The rest are keyed in place, as {@link stampDedupKeys} would.
 */
async function finalizeRepresentatives(
  representatives: JobPostDto[],
  ids: ReadonlyArray<string>,
  clusterSize: ReadonlyMap<string, number>,
  canonical: ReadonlyArray<CanonicalJob>,
): Promise<JobPostDto[]> {
  const keys: (string | undefined)[] = new Array(representatives.length);
  const plainKeys: (string | undefined)[] = new Array(representatives.length);
  const perKey = new Map<string, number>();
  for (let i = 0; i < representatives.length; i++) {
    if (i > 0 && i % DEDUP_KEY_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const plain = dedupKeyForJob(representatives[i]!);
    const key = clusterKeyForJob(representatives[i]!, plain);
    plainKeys[i] = plain;
    keys[i] = key;
    if (key !== undefined) perKey.set(key, (perKey.get(key) ?? 0) + 1);
  }

  let byId: Map<string, CanonicalJob> | undefined;
  return representatives.map((job, i) => {
    const id = ids[i]!;
    const ownKey = keys[i];
    const key = ownKey !== undefined && (perKey.get(ownKey) ?? 0) > 1 ? id : ownKey;
    let union: LocationDto[] | undefined;
    if ((clusterSize.get(id) ?? 1) > 1) {
      byId ??= new Map(canonical.map((c) => [c.canonicalJobId, c]));
      const merged = byId.get(id)?.locations;
      const own = new Set<LocationDto>(job.locations ?? []);
      if (merged && merged.some((loc) => !own.has(loc))) union = [...merged];
    }
    // In place only when the key is the job's plain per-job key — what any
    // other request's stamp pass would write on this (possibly cached) job.
    if (key === plainKeys[i] && union === undefined) {
      if (key !== undefined) job.dedupKey = key;
      PRE_KEYED.add(job);
      return job;
    }
    const copy = new JobPostDto({ ...job, ...(union ? { locations: union } : {}) });
    if (key !== undefined) copy.dedupKey = key;
    PRE_KEYED.add(copy);
    return copy;
  });
}

/**
 * Stamp `dedupKey` (Spec 1721 / contract C9) on every job, in place.
 *
 * Always derived from the job's own normalised company/title/location via
 * `dedupKeyForJob` — the function the default dedup engine uses for
 * `canonicalJobId` — rather than from the engine's cluster assignment, so the
 * key is identical with `dedup=false`, with a swapped engine, from a cache hit
 * or a fresh fan-out, and across runs. For a representative of the default
 * engagement the default engine returns, the two coincide (it is the cluster
 * head).
 * Deduped representatives are keyed by {@link finalizeRepresentatives}
 * instead (Spec 1724): a posting of a non-default employment class carries its
 * class-scoped `clusterKeyForJob`, and representatives that would still share
 * a key carry their cluster ids. It also marks the jobs it keyed, so this pass
 * does not hash them twice.
 *
 * Yields to the event loop every {@link DEDUP_KEY_YIELD_EVERY} jobs: a
 * 25 k-job list-mode corpus would otherwise block for ~0.3 s.
 */
export async function stampDedupKeys(jobs: JobPostDto[]): Promise<void> {
  for (let i = 0; i < jobs.length; i++) {
    if (i > 0 && i % DEDUP_KEY_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const job = jobs[i];
    if (!job) continue;
    if (PRE_KEYED.delete(job)) continue;
    const key = dedupKeyForJob(job);
    if (key !== undefined) job.dedupKey = key;
  }
}

/** Outcome of matching a request's exclusion spec against the raw rows (Spec 1700). */
interface ExclusionEvaluation {
  readonly compiled?: CompiledJobExclusions;
  /** Per raw row; absent when the spec was inactive or the filter failed. */
  readonly verdicts?: ReadonlyArray<ExclusionMatch | null>;
  readonly error?: { readonly code: string; readonly message: string };
}

/** The requested career levels that are real levels; empty means "no filter" (Spec 1730, FR-8). */
function wantedCareerLevels(options: AggregateOptions): Set<CareerLevel> {
  return new Set<CareerLevel>((options.careerLevels ?? []).filter(isCareerLevel));
}

/** The classifier's view of a job — only the fields it reads (Spec 1730, FR-3). */
function careerLevelInputOf(job: JobPostDto): CareerLevelInput {
  return {
    title: job.title,
    description: job.description,
    jobType: job.jobType,
    employmentType: job.employmentType,
    jobLevel: job.jobLevel,
    experienceRange: job.experienceRange,
  };
}

/**
 * Read the structured `.code` off an error rejection, falling back to
 * {@link ERR_STORE_PERSIST_FAILED} when the rejection is a bare `Error`
 * or non-error value. Stays in this file rather than `@ever-jobs/common`
 * because the only caller is the persistence-failure path above.
 */
function readErrorCode(err: unknown): string {
  if (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return ERR_STORE_PERSIST_FAILED;
}
