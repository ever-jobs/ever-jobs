import { Injectable, Logger } from '@nestjs/common';
import {
  CIRCUIT_BREAKER_TOKEN,
  CircuitPolicy,
  CircuitState,
  DEFAULT_CIRCUIT_POLICY,
  ERR_SOURCE_CIRCUIT_OPEN,
  ICircuitBreakerService,
  Site,
  SourceHealth,
  SourceHealthError,
} from '@ever-jobs/models';

/**
 * Per-site state held by {@link CircuitBreakerService}. One record is created
 * lazily on first call for a `Site`; the record is reused thereafter.
 *
 * Memory budget is enforced two ways:
 *   - the max-sites cap ({@link DEFAULT_CIRCUIT_MAX_SITES}, configurable via
 *     {@link CIRCUIT_MAX_SITES_ENV_VAR}) stops unbounded growth in the unlikely
 *     event a typo or test fixture pushes new `Site` values;
 *   - the {@link MAX_SAMPLES} ring buffer caps the per-site latency/outcome
 *     window (entries also expire by wall-clock when `rollingWindowMs`
 *     elapses).
 */
interface BreakerEntry {
  policy: CircuitPolicy;
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number; // ms timestamp; only meaningful when state === 'open' or 'half-open'
  halfOpenInFlight: number; // probe attempts currently active
  halfOpenAttempts: number; // probe attempts taken in the current half-open episode
  samples: Sample[];
  lastError?: SourceHealthError;
}

interface Sample {
  at: number;
  success: boolean;
  latencyMs: number;
}

/**
 * Environment variable that sets the max number of sites the breaker tracks
 * (Spec 1690 §4.9). Past the cap every call for an untracked site gets a
 * throwaway entry, so that site can never trip.
 */
export const CIRCUIT_MAX_SITES_ENV_VAR = 'EVER_JOBS_CIRCUIT_MAX_SITES';

/**
 * Default max tracked sites (Spec 1690 §4.9). The pre-1690 hard cap was 250
 * (Spec 005 / NFR-3, < 1 KB/site), which the ~1,850-source catalogue outgrew:
 * sites past the 250th could never trip. 4096 keeps every current source
 * trackable at a ~4 MB ceiling. Set `EVER_JOBS_CIRCUIT_MAX_SITES=250` for the
 * old bound, or `0` for no cap.
 */
export const DEFAULT_CIRCUIT_MAX_SITES = 4096;

/** The pre-1690 hard cap, kept so the old bound stays one setting away. */
export const LEGACY_CIRCUIT_MAX_SITES = 250;

/**
 * Parse {@link CIRCUIT_MAX_SITES_ENV_VAR}. A non-negative integer; `0` means no
 * cap. Unset, empty or invalid values fall back to
 * {@link DEFAULT_CIRCUIT_MAX_SITES} (an invalid value is reported through
 * `onInvalid`, never thrown).
 */
export function readCircuitMaxSites(
  env: NodeJS.ProcessEnv = process.env,
  onInvalid?: (raw: string) => void,
): number {
  const raw = env[CIRCUIT_MAX_SITES_ENV_VAR];
  if (raw === undefined || raw.trim() === '') return DEFAULT_CIRCUIT_MAX_SITES;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(n)) {
    onInvalid?.(raw);
    return DEFAULT_CIRCUIT_MAX_SITES;
  }
  return n;
}

/**
 * Own property that marks a thrown value as *circuit-neutral*: the call did
 * not fail because of the source, so it must count neither as a failure nor as
 * a success (Spec 1690 §4.6 — a scrape aborted because the whole search hit
 * its deadline says nothing about the source's health).
 */
export const CIRCUIT_NEUTRAL_ERROR_KEY = 'circuitNeutral';

/** True when `err` carries {@link CIRCUIT_NEUTRAL_ERROR_KEY} `=== true`. */
export function isCircuitNeutralError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as Record<string, unknown>)[CIRCUIT_NEUTRAL_ERROR_KEY] === true
  );
}

/**
 * Mark `err` circuit-neutral and return it. An object is tagged in place (so
 * the original error, stack and `code` reach the caller unchanged); a thrown
 * primitive, or a frozen object that cannot be tagged, is wrapped in an
 * `Error` first.
 */
export function markCircuitNeutral(err: unknown): unknown {
  const tag = (target: object): boolean => {
    try {
      Object.defineProperty(target, CIRCUIT_NEUTRAL_ERROR_KEY, {
        value: true,
        enumerable: false,
        configurable: true,
        writable: true,
      });
      return isCircuitNeutralError(target);
    } catch {
      return false;
    }
  };
  if (err && typeof err === 'object' && tag(err)) return err;
  const message =
    err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : String(err);
  const wrapped = new Error(message);
  tag(wrapped);
  return wrapped;
}

/** Per-site sample ring-buffer cap (~600 / 60 s = 10 RPS ceiling per site). */
const MAX_SAMPLES = 600;

/**
 * Hand-rolled circuit breaker — Spec 005 / FR-1, FR-2, FR-3.
 *
 * **Why hand-rolled instead of `opossum`** (deviation from plan §1):
 * `opossum` models failures as an `errorThresholdPercentage` over a rolling
 * count window — it does **not** support the "N consecutive failures →
 * open" semantics required by FR-2. Wrapping `opossum` to fake consecutive
 * counting would require post-event monkey-patching that's more fragile
 * than this 200-LOC state machine. The deviation is logged in Q-012.
 *
 * State machine (per `Site`):
 *
 * ```
 *           failure (consecutive >= threshold)
 *  closed ────────────────────────────────────►  open
 *    ▲                                            │ cooldownMs elapsed
 *    │ probe success                              ▼
 *    └────────────  half-open  ◄──── probe failure (back to open + new cooldown)
 * ```
 *
 * The breaker is observable via {@link health}, force-controllable via
 * {@link forceOpen} / {@link forceReset}, and per-site policy-configurable
 * via {@link setPolicy}.
 */
@Injectable()
export class CircuitBreakerService implements ICircuitBreakerService {
  /** Public DI token mirror for ergonomic imports in NestJS modules. */
  static readonly TOKEN = CIRCUIT_BREAKER_TOKEN;

  /**
   * Mirrors of the module-level helpers (Spec 1690), reachable through the
   * package's existing `CircuitBreakerService` export.
   */
  static readonly MAX_SITES_ENV_VAR = CIRCUIT_MAX_SITES_ENV_VAR;
  static readonly DEFAULT_MAX_SITES = DEFAULT_CIRCUIT_MAX_SITES;
  static readonly NEUTRAL_ERROR_KEY = CIRCUIT_NEUTRAL_ERROR_KEY;
  static readonly readMaxSites = readCircuitMaxSites;
  static readonly isNeutralError = isCircuitNeutralError;
  static readonly markNeutral = markCircuitNeutral;

  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly entries = new Map<Site, BreakerEntry>();

  /**
   * Test seam — defaults to `Date.now`. Replace via {@link setClock} for
   * deterministic time advancement in unit tests.
   */
  private clock: () => number = Date.now;

  /**
   * Max tracked sites; `0` = no cap. Read once from
   * {@link CIRCUIT_MAX_SITES_ENV_VAR} at construction (Spec 1690 §4.9).
   */
  private maxSites: number;

  constructor() {
    this.maxSites = readCircuitMaxSites(process.env, (raw) =>
      this.logger.warn(
        `${CIRCUIT_MAX_SITES_ENV_VAR}=${JSON.stringify(raw)} is not a non-negative integer; using ${DEFAULT_CIRCUIT_MAX_SITES}`,
      ),
    );
  }

  /** The max number of sites this breaker tracks (`0` = no cap). */
  getMaxSites(): number {
    return this.maxSites;
  }

  /**
   * Change the tracked-site cap at runtime (`0` = no cap). Already-tracked
   * sites are kept; only new sites are refused once the cap is reached.
   */
  setMaxSites(maxSites: number): void {
    if (!Number.isSafeInteger(maxSites) || maxSites < 0) {
      throw new RangeError(`maxSites must be a non-negative integer, got ${maxSites}`);
    }
    this.maxSites = maxSites;
  }

  /** Replace the wall-clock provider — testing only. */
  setClock(clock: () => number): void {
    this.clock = clock;
  }

  /** Configure or override `site`'s policy (Spec 005 / FR-3 / T08). */
  setPolicy(site: Site, policy: CircuitPolicy): void {
    const entry = this.getOrCreate(site);
    entry.policy = { ...policy };
  }

  /**
   * Run `fn` under the breaker for `site`. See {@link ICircuitBreakerService.exec}
   * for the wire-level contract.
   *
   * Implementation order:
   *   1. transition `open → half-open` if cooldown elapsed (probe gate);
   *   2. short-circuit when still `open` (or already-issued half-open probe
   *      quota is spent);
   *   3. invoke `fn`, time it, record outcome.
   */
  async exec<T>(site: Site, fn: () => Promise<T>): Promise<T> {
    const entry = this.getOrCreate(site);
    const now = this.clock();

    // 1. Try cooldown → half-open probe transition.
    if (entry.state === 'open') {
      if (now - entry.openedAt >= entry.policy.cooldownMs) {
        entry.state = 'half-open';
        entry.halfOpenAttempts = 0;
        entry.halfOpenInFlight = 0;
      }
    }

    // 2. Short-circuit if still open or no probe slots remain in half-open.
    if (entry.state === 'open') {
      const err = this.shortCircuitError(site);
      throw err;
    }
    if (
      entry.state === 'half-open' &&
      entry.halfOpenAttempts >= entry.policy.halfOpenProbes &&
      entry.halfOpenInFlight === 0
    ) {
      // Exhausted probes without a success → engineer's choice: stay
      // half-open until cooldown re-elapses. We prefer re-arming `open`
      // so the next call burns a fresh cooldown rather than spinning.
      entry.state = 'open';
      entry.openedAt = now;
      throw this.shortCircuitError(site);
    }

    // 3. Run `fn` under the breaker.
    if (entry.state === 'half-open') {
      entry.halfOpenAttempts += 1;
      entry.halfOpenInFlight += 1;
    }
    const startedAt = now;
    try {
      const result = await fn();
      this.onSuccess(site, entry, this.clock() - startedAt);
      return result;
    } catch (err) {
      if (isCircuitNeutralError(err)) {
        // Spec 1690 §4.6 — e.g. a scrape we aborted at the search deadline.
        // Not the source's fault: record nothing, and hand a half-open probe
        // slot back so the next call can still probe.
        this.onNeutral(entry);
        throw err;
      }
      this.onFailure(site, entry, this.clock() - startedAt, err);
      throw err;
    }
  }

  state(site: Site): CircuitState {
    const entry = this.getOrCreate(site);
    // Lazy reconciliation: a long-idle 'open' breaker should report
    // 'half-open' once cooldown has elapsed even if no `exec()` ran.
    const now = this.clock();
    if (entry.state === 'open' && now - entry.openedAt >= entry.policy.cooldownMs) {
      return 'half-open';
    }
    return entry.state;
  }

  health(site: Site): SourceHealth {
    const entry = this.getOrCreate(site);
    const now = this.clock();
    this.pruneSamples(entry, now);
    const successes = entry.samples.filter((s) => s.success).length;
    const total = entry.samples.length;
    const successRate = total === 0 ? 1 : successes / total;
    const latencies = entry.samples.map((s) => s.latencyMs);
    return {
      site,
      state: this.state(site),
      successRate,
      p95LatencyMs: percentile(latencies, 0.95),
      lastError: entry.lastError,
      windowMs: entry.policy.rollingWindowMs,
    };
  }

  forceOpen(site: Site): void {
    const entry = this.getOrCreate(site);
    entry.state = 'open';
    entry.openedAt = this.clock();
    entry.consecutiveFailures = entry.policy.failureThreshold;
    entry.halfOpenAttempts = 0;
    entry.halfOpenInFlight = 0;
    this.logger.warn(`forceOpen: ${site}`);
  }

  forceReset(site: Site): void {
    const entry = this.getOrCreate(site);
    entry.state = 'closed';
    entry.consecutiveFailures = 0;
    entry.halfOpenAttempts = 0;
    entry.halfOpenInFlight = 0;
    entry.openedAt = 0;
    entry.samples = [];
    entry.lastError = undefined;
    this.logger.log(`forceReset: ${site}`);
  }

  list(): SourceHealth[] {
    return Array.from(this.entries.keys()).map((site) => this.health(site));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  private getOrCreate(site: Site): BreakerEntry {
    const existing = this.entries.get(site);
    if (existing) return existing;
    if (this.maxSites > 0 && this.entries.size >= this.maxSites) {
      // Cap reached — refuse to grow further. Return a transient "ghost"
      // entry so the caller path doesn't crash. Raise
      // EVER_JOBS_CIRCUIT_MAX_SITES (0 = no cap) if the catalogue outgrows it.
      this.logger.error(
        `MAX_SITES (${this.maxSites}) reached — refusing to track new site ${site}; using ephemeral entry (raise ${CIRCUIT_MAX_SITES_ENV_VAR})`,
      );
      return this.makeEntry();
    }
    const entry = this.makeEntry();
    this.entries.set(site, entry);
    return entry;
  }

  private makeEntry(): BreakerEntry {
    return {
      policy: { ...DEFAULT_CIRCUIT_POLICY },
      state: 'closed',
      consecutiveFailures: 0,
      openedAt: 0,
      halfOpenAttempts: 0,
      halfOpenInFlight: 0,
      samples: [],
    };
  }

  private onSuccess(site: Site, entry: BreakerEntry, latencyMs: number): void {
    const now = this.clock();
    entry.consecutiveFailures = 0;
    if (entry.state === 'half-open') {
      entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1);
      entry.state = 'closed';
      entry.openedAt = 0;
      entry.halfOpenAttempts = 0;
      this.logger.log(`circuit ${site}: half-open → closed (probe success)`);
    }
    this.recordSample(entry, { at: now, success: true, latencyMs });
  }

  /** A circuit-neutral outcome: no sample, no failure count, probe slot returned. */
  private onNeutral(entry: BreakerEntry): void {
    if (entry.state === 'half-open') {
      entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1);
      entry.halfOpenAttempts = Math.max(0, entry.halfOpenAttempts - 1);
    }
  }

  private onFailure(
    site: Site,
    entry: BreakerEntry,
    latencyMs: number,
    err: unknown,
  ): void {
    const now = this.clock();
    entry.consecutiveFailures += 1;
    entry.lastError = projectError(err, now);
    if (entry.state === 'half-open') {
      entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1);
      entry.state = 'open';
      entry.openedAt = now;
      this.logger.warn(`circuit ${site}: half-open → open (probe failure)`);
    } else if (
      entry.state === 'closed' &&
      entry.consecutiveFailures >= entry.policy.failureThreshold
    ) {
      entry.state = 'open';
      entry.openedAt = now;
      this.logger.warn(
        `circuit ${site}: closed → open (${entry.consecutiveFailures} consecutive failures)`,
      );
    }
    this.recordSample(entry, { at: now, success: false, latencyMs });
  }

  private recordSample(entry: BreakerEntry, sample: Sample): void {
    entry.samples.push(sample);
    if (entry.samples.length > MAX_SAMPLES) {
      // Drop oldest in-place (cheap; preserves ordering).
      entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
    }
  }

  private pruneSamples(entry: BreakerEntry, now: number): void {
    const horizon = now - entry.policy.rollingWindowMs;
    if (entry.samples.length === 0 || entry.samples[0].at >= horizon) return;
    // Find first index whose timestamp is in-window.
    let first = 0;
    while (first < entry.samples.length && entry.samples[first].at < horizon) first++;
    if (first > 0) entry.samples.splice(0, first);
  }

  private shortCircuitError(site: Site): Error & { code: string; site: Site } {
    const err = new Error(`Circuit open for site ${site}`) as Error & {
      code: string;
      site: Site;
    };
    err.code = ERR_SOURCE_CIRCUIT_OPEN;
    err.site = site;
    return err;
  }
}

/**
 * Project an arbitrary thrown value into the compact `SourceHealthError`
 * shape returned by `/api/sources/health`. Best-effort: if the throw is a
 * primitive we still capture the stringified value; an Error keeps its
 * `code`/`name`/`message`.
 */
function projectError(err: unknown, atMs: number): SourceHealthError {
  const at = new Date(atMs).toISOString();
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; name?: string; message?: unknown };
    const code =
      typeof e.code === 'string' && e.code.length > 0
        ? e.code
        : e.name ?? 'ERR_SOURCE_UNKNOWN';
    const message =
      typeof e.message === 'string' && e.message.length > 0
        ? e.message
        : String(err);
    return { code, message, at };
  }
  return { code: 'ERR_SOURCE_UNKNOWN', message: String(err), at };
}

/**
 * Linear-interpolation-free percentile. We pick the value at index
 * `floor(p * (n-1))` after a sort — fine for our 600-sample ceiling and
 * stable to add/remove the same sample twice.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}
