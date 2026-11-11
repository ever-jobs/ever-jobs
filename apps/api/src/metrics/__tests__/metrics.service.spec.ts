/**
 * Unit tests — Spec 005 / T06 — `source_circuit_state` Gauge.
 *
 * The Gauge's `collect()` callback is invoked by `prom-client` on every
 * `getMetrics()` call. These tests drive that hook directly (no Nest
 * bootstrap, no breaker) so we can assert the wire-level shape of the
 * Prometheus exposition for the `closed/half-open/open` encoding.
 *
 * The Q-015 / Option A contract is:
 *   - When no source is bound → `ever_jobs_source_circuit_state` is
 *     absent from `/metrics`.
 *   - When a source is bound → one sample per `SourceHealth` entry,
 *     labelled `{site=...}` with value 0 (closed) / 1 (half-open) / 2 (open).
 *   - A throw inside the source closure does NOT corrupt the
 *     `/metrics` response — it logs and returns normally.
 */
import { CircuitState, Site, SourceHealth } from '@ever-jobs/models';
import {
  CIRCUIT_STATE_GAUGE_VALUE,
  MetricsService,
} from '../metrics.service';

function makeHealth(site: Site, state: CircuitState): SourceHealth {
  return {
    site,
    state,
    successRate: state === 'closed' ? 1 : 0,
    p95LatencyMs: 0,
    windowMs: 60_000,
  };
}

describe('MetricsService — sources_total Gauge (Spec 1760)', () => {
  const line = (text: string): string | undefined =>
    text.split('\n').find((l) => l.startsWith('ever_jobs_sources_total '));

  it('no longer reports a made-up constant when no source is bound', async () => {
    const service = new MetricsService();
    service.onModuleInit();
    expect(line(await service.getMetrics())).toBe('ever_jobs_sources_total 0');
  });

  it('reports the live count from the bound source on every scrape', async () => {
    const service = new MetricsService();
    let count = 212;
    service.bindSourceCountSource(() => count);
    expect(line(await service.getMetrics())).toBe('ever_jobs_sources_total 212');

    count = 213;
    expect(line(await service.getMetrics())).toBe('ever_jobs_sources_total 213');
  });

  it('keeps /metrics available when the source throws', async () => {
    const service = new MetricsService();
    service.bindSourceCountSource(() => {
      throw new Error('registry gone');
    });
    const text = await service.getMetrics();
    expect(text).toContain('# TYPE ever_jobs_sources_total gauge');
  });

  it('ignores a negative or non-finite count', async () => {
    const service = new MetricsService();
    let count = 5;
    service.bindSourceCountSource(() => count);
    expect(line(await service.getMetrics())).toBe('ever_jobs_sources_total 5');

    count = -1;
    expect(line(await service.getMetrics())).toBe('ever_jobs_sources_total 5');
    count = Number.NaN;
    expect(line(await service.getMetrics())).toBe('ever_jobs_sources_total 5');
  });
});

describe('MetricsService — source_circuit_state Gauge (Spec 005 / T06)', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  describe('encoding', () => {
    it('uses closed=0, half-open=1, open=2', () => {
      expect(CIRCUIT_STATE_GAUGE_VALUE.closed).toBe(0);
      expect(CIRCUIT_STATE_GAUGE_VALUE['half-open']).toBe(1);
      expect(CIRCUIT_STATE_GAUGE_VALUE.open).toBe(2);
    });
  });

  describe('without bindCircuitBreakerSource', () => {
    it('omits ever_jobs_source_circuit_state samples (Gauge has no values)', async () => {
      const text = await service.getMetrics();
      // The HELP+TYPE preamble is always emitted because the Gauge is
      // registered, but with no values prom-client emits the metadata
      // lines and no samples.
      expect(text).toContain('# TYPE ever_jobs_source_circuit_state gauge');
      // No `ever_jobs_source_circuit_state{site="..."} N` data line
      // should be present.
      const sampleLines = text
        .split('\n')
        .filter(
          (l) =>
            l.startsWith('ever_jobs_source_circuit_state') && l.includes('{'),
        );
      expect(sampleLines).toEqual([]);
    });
  });

  describe('with bindCircuitBreakerSource', () => {
    it('emits one sample per Site with the correct numeric encoding', async () => {
      service.bindCircuitBreakerSource(() => [
        makeHealth(Site.LINKEDIN, 'open'),
        makeHealth(Site.INDEED, 'closed'),
        makeHealth(Site.GLASSDOOR, 'half-open'),
      ]);

      const text = await service.getMetrics();
      expect(text).toContain('# TYPE ever_jobs_source_circuit_state gauge');
      expect(text).toMatch(
        /ever_jobs_source_circuit_state\{site="linkedin"\} 2\b/,
      );
      expect(text).toMatch(
        /ever_jobs_source_circuit_state\{site="indeed"\} 0\b/,
      );
      expect(text).toMatch(
        /ever_jobs_source_circuit_state\{site="glassdoor"\} 1\b/,
      );
    });

    it('reflects state changes between scrapes (closure is re-evaluated)', async () => {
      let snapshots: SourceHealth[] = [makeHealth(Site.LINKEDIN, 'closed')];
      service.bindCircuitBreakerSource(() => snapshots);

      const before = await service.getMetrics();
      expect(before).toMatch(
        /ever_jobs_source_circuit_state\{site="linkedin"\} 0\b/,
      );

      snapshots = [makeHealth(Site.LINKEDIN, 'open')];

      const after = await service.getMetrics();
      expect(after).toMatch(
        /ever_jobs_source_circuit_state\{site="linkedin"\} 2\b/,
      );
      // And the stale `0` sample is gone (reset() between collects).
      const leakedZero = after
        .split('\n')
        .find(
          (l) => l === 'ever_jobs_source_circuit_state{site="linkedin"} 0',
        );
      expect(leakedZero).toBeUndefined();
    });

    it('drops sites that have aged out of the source between scrapes', async () => {
      let snapshots: SourceHealth[] = [
        makeHealth(Site.LINKEDIN, 'open'),
        makeHealth(Site.INDEED, 'open'),
      ];
      service.bindCircuitBreakerSource(() => snapshots);

      const before = await service.getMetrics();
      expect(before).toMatch(/ever_jobs_source_circuit_state\{site="indeed"\} 2\b/);

      // Indeed disappears (e.g. evicted by a future policy).
      snapshots = [makeHealth(Site.LINKEDIN, 'open')];

      const after = await service.getMetrics();
      const indeedLine = after
        .split('\n')
        .find((l) => l.includes('ever_jobs_source_circuit_state{site="indeed"}'));
      expect(indeedLine).toBeUndefined();
      expect(after).toMatch(
        /ever_jobs_source_circuit_state\{site="linkedin"\} 2\b/,
      );
    });

    it('does not crash /metrics when the source closure throws', async () => {
      service.bindCircuitBreakerSource(() => {
        throw new Error('breaker blew up');
      });

      // Must NOT throw — the controller would otherwise return 500.
      const text = await service.getMetrics();
      expect(text).toContain('# TYPE ever_jobs_source_circuit_state gauge');
      // No data lines.
      const sampleLines = text
        .split('\n')
        .filter(
          (l) =>
            l.startsWith('ever_jobs_source_circuit_state') && l.includes('{'),
        );
      expect(sampleLines).toEqual([]);
    });

    it('rebinding the source replaces (not appends) the previous one', async () => {
      service.bindCircuitBreakerSource(() => [
        makeHealth(Site.LINKEDIN, 'open'),
      ]);
      service.bindCircuitBreakerSource(() => [
        makeHealth(Site.INDEED, 'closed'),
      ]);

      const text = await service.getMetrics();
      expect(text).toMatch(/ever_jobs_source_circuit_state\{site="indeed"\} 0\b/);
      // The previously-bound LinkedIn-open sample must NOT appear.
      const leaked = text
        .split('\n')
        .find((l) => l.includes('ever_jobs_source_circuit_state{site="linkedin"}'));
      expect(leaked).toBeUndefined();
    });
  });
});
