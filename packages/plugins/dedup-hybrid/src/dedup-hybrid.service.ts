import { Injectable, Logger } from '@nestjs/common';
import {
  CanonicalJob,
  DedupInputError,
  DedupMetrics,
  DedupResult,
  FieldWithProvenance,
  IDedupEngine,
  JobPostDto,
  LocationDto,
  OfficeDto,
  Site,
  SourceObservation,
  provenance,
} from '@ever-jobs/models';
import {
  canonicalJobId,
  canonicalKey,
  canonicalKeyInputForJob,
  formatJobLocation,
  normalizeCompany,
  normalizeLocation,
  normalizeTitle,
} from '@ever-jobs/common';

import { YieldBudget, yieldToEventLoop } from './cooperative';
import { MergeGate, clusterDiscriminator, discriminatedCanonicalJobId } from './merge-gate';
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
 * Every merge either stage proposes passes the {@link MergeGate} (Spec 1724):
 * postings are only merged when their locations are compatible and their
 * employment types do not conflict, so one role posted per office (or per
 * program) keeps one record per office (or program).
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

  /**
   * Tail of the serialisation chain — see {@link dedup}. Never rejects: each
   * link is resolved from a `finally`, so one failed pass cannot wedge the
   * queue for every later caller.
   */
  private tail: Promise<void> = Promise.resolve();

  /**
   * Deduplicate a fan-out result. **Passes are serialised.**
   *
   * 🛑 The serialisation is load-bearing and exists *because* of the yields.
   * Before them, a pass held the thread start-to-finish, so two concurrent
   * `dedup()` calls were serialised by the runtime and only ever one working
   * set (`slots`, `buckets`, signatures) was live. Yielding removes that
   * accidental mutual exclusion: without this gate, K concurrent passes keep K
   * working sets resident simultaneously — measured +17 % peak heap at K=4 and
   * +67 % (+117 MB) at K=8 on a 2 500-job batch, and production batches are
   * ~10x that.
   *
   * This service runs with `--max-old-space-size=2560` in a 4Gi container and
   * has already aborted with `FATAL ERROR: Reached heap limit` (exit 139), so
   * trading peak heap for concurrency is exactly the wrong trade here. The
   * gate restores the old memory profile while keeping the win that motivated
   * the yields: the pass that holds the gate still hands the event loop back
   * every `DEFAULT_YIELD_BUDGET_MS`, so `GET /health` — and every other
   * request — is served throughout.
   *
   * Queuing cost is negligible in practice: this endpoint serves a handful of
   * searches an hour and the fan-out that produces the input already takes
   * ~150 s, dwarfing any wait here.
   */
  async dedup(jobs: ReadonlyArray<JobPostDto>): Promise<DedupResult> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // `prior` can never reject (see `tail`), but stay defensive: a poisoned
    // chain would turn a single bad batch into a permanent outage.
    await prior.catch(() => undefined);
    try {
      return await this.dedupExclusive(jobs);
    } finally {
      release();
    }
  }

  /** The pass itself. Only ever entered by one caller at a time — see {@link dedup}. */
  private async dedupExclusive(jobs: ReadonlyArray<JobPostDto>): Promise<DedupResult> {
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

      // Spec 1689 — `isRemote` feeds the key's remote bucket: a parsed
      // 'Remote' (no location) or 'Remote - US' (`{ country }` only) keys to
      // `remote`, the same as a source emitting `{ city: 'Remote' }`, so the
      // two hash-merge in stage 1 instead of relying on MinHash.
      // Spec 1721 — built by the shared helper that also builds the API's
      // `dedupKey`, so the cluster id and the key can never read different
      // fields (title, company, flat location, `locations[]`, `isRemote`).
      const keyInput = canonicalKeyInputForJob(raw);
      prepared.push({
        index: i,
        canonicalKey: canonicalKey(keyInput),
        canonicalJobId: canonicalJobId(keyInput),
        raw,
      });
    }

    // Pass 2 — run strategies; union all partitions in a single Union-Find.
    // Spec 1724 — every proposed merge goes through the merge gate: postings
    // are only merged when their locations are compatible and their
    // employment types do not conflict (see ./merge-gate). A proposed cluster
    // the gate refuses is split into compatible sub-groups, in input order.
    const uf = new UnionFind(prepared.length);
    const gate = new MergeGate(prepared.map((p) => p.raw));
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
        const heads: number[] = [];
        for (const index of cluster) {
          // Yield checkpoint — a gate check is a few string comparisons per
          // pair of distinct member profiles; a cluster the gate splits into
          // many sub-groups costs sub-groups x members of them.
          if (budget.expired) {
            await yieldToEventLoop();
            budget.renew();
          }
          const pos = indexToPos.get(index);
          if (pos !== undefined) gate.place(uf, heads, pos);
        }
      }
    }
    if (gate.refused > 0) {
      this.logger.debug(
        `dedup gate kept ${gate.refused} proposed merges apart (location or employment-type conflict)`,
      );
    }

    // Pass 3 — materialise canonical records.
    const clusters = uf.toClusters();
    const mergedAt = new Date().toISOString();
    const clusterIds = assignClusterIds(clusters, prepared, gate);
    const canonical: CanonicalJob[] = [];
    const assignments: (string | null)[] = new Array(inputCount).fill(null);

    for (let c = 0; c < clusters.length; c++) {
      const cluster = clusters[c];
      const clusterId = clusterIds[c];
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

      // Per-site data is merged as a union across every observation, not
      // just the head's: stage-2 (MinHash) clusters may weld postings whose
      // site lists genuinely differ (e.g. a repost that added a site).
      const locations = unionLocations(cluster, prepared);
      const offices = unionOffices(cluster, prepared);
      // Spec 1689 — the ATS posting country (`JobPostDto.countryCode`) is
      // carried onto the canonical record instead of being dropped here.
      const countryCode = pickCountryCode(cluster, prepared);

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
      if (countryCode) {
        fields['countryCode'] = provenance(
          countryCode.value,
          (countryCode.raw.site as Site) ?? headSite,
          String(countryCode.raw.id ?? countryCode.raw.atsId ?? countryCode.raw.jobUrl ?? headSourceId),
          observedAt,
        );
      }

      const record: CanonicalJob = {
        canonicalJobId: clusterId,
        title: titleVal,
        company: companyVal,
        location: locationVal,
        ...(locations.length > 0 ? { locations } : {}),
        ...(offices.length > 0 ? { offices } : {}),
        ...(countryCode ? { countryCode: countryCode.value } : {}),
        description: head.raw.description ?? undefined,
        url: head.raw.jobUrl,
        sources: observations,
        fields,
        mergedAt,
      };
      canonical.push(record);

      for (const pos of cluster) {
        assignments[prepared[pos].index] = clusterId;
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
 * One `canonicalJobId` per cluster (Spec 1724).
 *
 * A cluster's id is its head's `canonicalJobId` — unless the merge gate kept
 * two clusters apart whose heads share one canonical key (same company, title
 * and location, conflicting employment type: an internship and a new-grad
 * posting). Then EVERY cluster of that key gets
 * `sha256(<canonicalKey>|<discriminator>)` (the head's employment label, else
 * its classes, else its sites), plus an ordinal if that still collides, so
 * ids stay unique per batch — the aggregator keys its representatives and the
 * store upserts by them — and no posting inherits another posting's plain id.
 */
function assignClusterIds(
  clusters: ReadonlyArray<ReadonlyArray<number>>,
  prepared: ReadonlyArray<PreparedJob>,
  gate: MergeGate,
): string[] {
  const perId = new Map<string, number>();
  for (const cluster of clusters) {
    const id = prepared[cluster[0]].canonicalJobId;
    perId.set(id, (perId.get(id) ?? 0) + 1);
  }
  const used = new Set<string>();
  return clusters.map((cluster) => {
    const head = prepared[cluster[0]];
    if ((perId.get(head.canonicalJobId) ?? 0) < 2) return head.canonicalJobId;
    const discriminator = clusterDiscriminator(gate.profile(cluster[0]));
    let id = discriminatedCanonicalJobId(head.canonicalKey, discriminator);
    for (let n = 2; used.has(id); n++) {
      id = discriminatedCanonicalJobId(head.canonicalKey, `${discriminator}#${n}`);
    }
    used.add(id);
    return id;
  });
}

/**
 * Union of `locations[]` across a cluster's observations, head-first.
 * Entries dedupe on their `city|state|country` triple (entries with no
 * geography dedupe on `name|text` so name-only sites don't collapse into
 * each other). First occurrence wins, preserving each observation's raw
 * `text`/`name`/`postalCode` fields on the surviving entry.
 */
function unionLocations(
  cluster: ReadonlyArray<number>,
  prepared: PreparedJob[],
): LocationDto[] {
  const seen = new Set<string>();
  const out: LocationDto[] = [];
  for (const pos of cluster) {
    for (const loc of prepared[pos].raw.locations ?? []) {
      const geo = [loc.city, loc.state, loc.country]
        .filter(Boolean)
        .join('|')
        .toLowerCase();
      const key = geo || `${loc.name ?? ''}|${loc.text ?? ''}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(loc);
    }
  }
  return out;
}

/**
 * Union of `offices[]` across a cluster's observations, head-first.
 * Entries dedupe on `id` when present, else `name|text`.
 */
function unionOffices(
  cluster: ReadonlyArray<number>,
  prepared: PreparedJob[],
): OfficeDto[] {
  const seen = new Set<string>();
  const out: OfficeDto[] = [];
  for (const pos of cluster) {
    for (const office of prepared[pos].raw.offices ?? []) {
      const key = (office.id ?? `${office.name ?? ''}|${office.text ?? ''}`).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(office);
    }
  }
  return out;
}

/**
 * The cluster's ATS posting country (`JobPostDto.countryCode`), head-first:
 * the head's code when it carries one, else the first observation's that does.
 * Kept verbatim (trimmed). Returns `null` when no observation carries one.
 */
function pickCountryCode(
  cluster: ReadonlyArray<number>,
  prepared: PreparedJob[],
): { value: string; raw: JobPostDto } | null {
  for (const pos of cluster) {
    const raw = prepared[pos].raw;
    const code = typeof raw.countryCode === 'string' ? raw.countryCode.trim() : '';
    if (code) return { value: code, raw };
  }
  return null;
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
 *
 * Delegates to the shared `formatJobLocation` (Spec 1721) so the key this
 * engine clusters on and the `dedupKey` the API returns are one function.
 */
function formatLocation(loc: NonNullable<JobPostDto['location']>): string {
  return formatJobLocation(loc);
}
