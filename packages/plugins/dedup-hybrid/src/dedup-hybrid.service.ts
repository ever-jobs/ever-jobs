import { Injectable, Logger } from '@nestjs/common';
import {
  CanonicalJob,
  DedupInputError,
  DedupMetrics,
  DedupResult,
  FieldWithProvenance,
  IDedupEngine,
  JobPostDto,
  Site,
  SourceObservation,
  provenance,
} from '@ever-jobs/models';
import { canonicalJobId, canonicalKey, normalizeCompany, normalizeLocation, normalizeTitle } from '@ever-jobs/common';

import { YieldBudget, yieldToEventLoop } from './cooperative';
import { HashStrategy } from './strategies/hash-strategy';
import { MinHashStrategy } from './strategies/minhash-strategy';
import { ClusterPartition, DedupHybridOptions, IDedupStrategy, PreparedJob } from './types';
import { UnionFind } from './union-find';

/**
 * Default hybrid dedup engine — Spec 003 / FR-1.
 *
 * Pipeline (each stage further merges clusters from the previous stage):
 *
 *  1. {@link HashStrategy} — exact `canonicalJobId` bucketing (O(N), fast path).
 *  2. {@link MinHashStrategy} — MinHash + LSH near-duplicate detection on
 *     long-form text (description, falling back to title + company).
 *
 * The service:
 *  - validates inputs (rejects entries missing `title` or `companyName`)
 *  - prepares each input once (canonical key + id)
 *  - runs strategies in order, unioning partitions via {@link UnionFind}
 *  - emits one `CanonicalJob` per cluster, picking the first observation as
 *    the field winner (replaced by `IMergeResolver` when Phase 4 lands)
 *  - returns a `DedupResult` envelope with assignments + metrics
 *
 * ## Cooperative scheduling
 *
 * Every pass below hands the event loop back once it has held it for
 * `DEFAULT_YIELD_BUDGET_MS` (see `./cooperative`). Without that, a ~6 900-job
 * batch is ~10.6 s of uninterrupted synchronous CPU on the same thread that
 * serves `GET /health`, which is what made Kubernetes' liveness probe kill the
 * pod. The yields change no output — every structure the passes touch is local
 * to the call.
 *
 * 🛑 `DedupMetrics.elapsedMs` is, and remains, **wall clock**. With yields it
 * now also counts the time the loop spent serving other requests, so under
 * concurrency it reads *higher* than the CPU the pass actually consumed. Read
 * it as "how long the caller waited", not "how much CPU dedup burned".
 */
@Injectable()
export class DedupHybridService implements IDedupEngine {
  private readonly logger = new Logger(DedupHybridService.name);
  private readonly strategies: ReadonlyArray<IDedupStrategy> = [
    new HashStrategy(),
    new MinHashStrategy(),
  ];
  private readonly options: Required<DedupHybridOptions> = {
    rejectInvalid: true,
  };

  async dedup(jobs: ReadonlyArray<JobPostDto>): Promise<DedupResult> {
    const start = Date.now();
    const errors: DedupInputError[] = [];
    const prepared: PreparedJob[] = [];
    const inputCount = jobs.length;
    const budget = new YieldBudget();

    // Pass 1 — validate + prepare. We keep `prepared` indices contiguous so
    // strategies can use a typed-array Union-Find later.
    for (let i = 0; i < inputCount; i++) {
      // Yield checkpoint — `canonicalKey` + `canonicalJobId` normalise three
      // fields twice and sha-256 the result: ~25 us per input, i.e. ~175 ms
      // for a 6 900-job batch. Well under the probe timeout on its own, but
      // free to slice and it keeps every pass under one bound.
      if (budget.expired) {
        await yieldToEventLoop();
        budget.renew();
      }
      const raw = jobs[i];
      if (!raw || !raw.title || !raw.companyName) {
        if (this.options.rejectInvalid) {
          errors.push({
            inputIndex: i,
            code: 'ERR_DEDUP_INVALID_INPUT',
            message: 'job is missing required title or companyName',
          });
          continue;
        }
      }

      const keyInput = {
        title: raw.title ?? '',
        company: raw.companyName ?? '',
        location: raw.location ? formatLocation(raw.location) : '',
      };
      prepared.push({
        index: i,
        canonicalKey: canonicalKey(keyInput),
        canonicalJobId: canonicalJobId(keyInput),
        raw,
      });
    }

    // Pass 2 — run strategies; union all partitions in a single Union-Find.
    const uf = new UnionFind(prepared.length);
    const indexToPos = new Map<number, number>();
    for (let pos = 0; pos < prepared.length; pos++) {
      indexToPos.set(prepared[pos].index, pos);
    }
    for (const strategy of this.strategies) {
      // Prefer the cooperative variant when a strategy offers one. `HashStrategy`
      // does not (its pass is O(N) map inserts, ~1 ms for 7 K inputs);
      // `MinHashStrategy` does, and it is the ~10 s pass this whole mechanism
      // exists for.
      const partition: ClusterPartition = strategy.clusterAsync
        ? await strategy.clusterAsync(prepared)
        : strategy.cluster(prepared);
      budget.renew();
      for (const cluster of partition.clusters) {
        if (cluster.length < 2) continue;
        const headPos = indexToPos.get(cluster[0]);
        if (headPos === undefined) continue;
        for (let k = 1; k < cluster.length; k++) {
          const nextPos = indexToPos.get(cluster[k]);
          if (nextPos !== undefined) uf.union(headPos, nextPos);
        }
      }
    }

    // Pass 3 — materialise canonical records.
    const clusters = uf.toClusters();
    const mergedAt = new Date().toISOString();
    const canonical: CanonicalJob[] = [];
    const assignments: (string | null)[] = new Array(inputCount).fill(null);

    for (const cluster of clusters) {
      // Yield checkpoint — materialisation re-normalises title/company/location
      // per cluster head (~10 us) and allocates a `CanonicalJob`; a
      // mostly-unique 7 K batch emits ~7 K of them.
      if (budget.expired) {
        await yieldToEventLoop();
        budget.renew();
      }
      const observations: SourceObservation[] = [];
      const head = prepared[cluster[0]];
      const fields: Record<string, FieldWithProvenance<unknown>> = {};

      for (const pos of cluster) {
        const job = prepared[pos];
        const obs = jobToObservation(job.raw);
        if (obs) observations.push(obs);
      }

      // Phase-3 default merge: head wins for every field. Phase 4 introduces
      // `IMergeResolver` for ATS > company > board > niche precedence.
      const headSite = (head.raw.site as Site) ?? observations[0]?.site ?? Site.LINKEDIN;
      const headSourceId = String(head.raw.id ?? observations[0]?.sourceJobId ?? '');
      const observedAt = observations[0]?.observedAt ?? mergedAt;

      const titleVal = normalizeTitle(head.raw.title ?? '');
      const companyVal = normalizeCompany(head.raw.companyName ?? '');
      const locationVal = head.raw.location ? normalizeLocation(formatLocation(head.raw.location)) : '';

      fields['title'] = provenance(titleVal, headSite, headSourceId, observedAt);
      fields['company'] = provenance(companyVal, headSite, headSourceId, observedAt);
      fields['location'] = provenance(locationVal, headSite, headSourceId, observedAt);
      fields['url'] = provenance(head.raw.jobUrl, headSite, headSourceId, observedAt);
      if (head.raw.description) {
        fields['description'] = provenance(head.raw.description, headSite, headSourceId, observedAt);
      }

      const record: CanonicalJob = {
        canonicalJobId: head.canonicalJobId,
        title: titleVal,
        company: companyVal,
        location: locationVal,
        description: head.raw.description ?? undefined,
        url: head.raw.jobUrl,
        sources: observations,
        fields,
        mergedAt,
      };
      canonical.push(record);

      for (const pos of cluster) {
        assignments[prepared[pos].index] = head.canonicalJobId;
      }
    }

    const metrics: DedupMetrics = {
      inputCount,
      outputCount: canonical.length,
      mergedPairs: prepared.length - canonical.length,
      elapsedMs: Date.now() - start,
    };

    if (errors.length > 0) {
      this.logger.warn(
        `dedup rejected ${errors.length} of ${inputCount} inputs (missing title/company)`,
      );
    }

    return {
      canonical,
      assignments,
      errors,
      metrics,
    };
  }
}

/**
 * Build a `SourceObservation` from a `JobPostDto`. Returns `null` if the DTO
 * lacks the bare-minimum identity fields (`site`, `jobUrl`).
 */
function jobToObservation(raw: JobPostDto): SourceObservation | null {
  if (!raw.site || !raw.jobUrl) return null;
  return {
    site: raw.site as Site,
    sourceJobId: String(raw.id ?? raw.atsId ?? raw.jobUrl),
    url: raw.jobUrl,
    observedAt: typeof raw.datePosted === 'string' ? raw.datePosted : new Date().toISOString(),
    rawTitle: raw.title,
  };
}

/**
 * Render `LocationDto` into the flat string the canonicaliser expects.
 * `displayLocation()` is the canonical UI rendering already; we lean on it
 * here to avoid drifting from the user-visible shape.
 */
function formatLocation(loc: NonNullable<JobPostDto['location']>): string {
  if (typeof (loc as { displayLocation?: () => string }).displayLocation === 'function') {
    return (loc as { displayLocation: () => string }).displayLocation();
  }
  const parts: string[] = [];
  if (loc.city) parts.push(loc.city);
  if (loc.state) parts.push(loc.state);
  if (loc.country) parts.push(typeof loc.country === 'string' ? loc.country : String(loc.country));
  return parts.join(', ');
}
