/**
 * Unit tests — Spec 1760 — the bridge binds the plugin registry's size into
 * `ever_jobs_sources_total`, with or without a circuit breaker.
 */
import { ICircuitBreakerService } from '@ever-jobs/models';
import { PluginRegistry } from '@ever-jobs/plugin';
import { MetricsService } from '../../metrics/metrics.service';
import { MetricsCircuitBreakerBridge } from '../metrics-circuit-breaker.bridge';

const sourcesLine = (text: string): string | undefined =>
  text.split('\n').find((l) => l.startsWith('ever_jobs_sources_total '));

describe('MetricsCircuitBreakerBridge — ever_jobs_sources_total (Spec 1760)', () => {
  it('reports the registry size, following later registrations', async () => {
    const metrics = new MetricsService();
    const registry = { size: 3 } as unknown as PluginRegistry;
    new MetricsCircuitBreakerBridge(metrics, undefined, registry).onApplicationBootstrap();

    expect(sourcesLine(await metrics.getMetrics())).toBe('ever_jobs_sources_total 3');

    (registry as unknown as { size: number }).size = 4;
    expect(sourcesLine(await metrics.getMetrics())).toBe('ever_jobs_sources_total 4');
  });

  it('binds the count even when no circuit breaker is available', async () => {
    const metrics = new MetricsService();
    const registry = { size: 7 } as unknown as PluginRegistry;
    new MetricsCircuitBreakerBridge(metrics, undefined, registry).onApplicationBootstrap();
    expect(sourcesLine(await metrics.getMetrics())).toBe('ever_jobs_sources_total 7');
  });

  it('binds both the source count and the circuit state when a breaker is present', async () => {
    const metrics = new MetricsService();
    const registry = { size: 9 } as unknown as PluginRegistry;
    const breaker = {
      list: () => [
        { site: 'linkedin', state: 'open', successRate: 0, p95LatencyMs: 0, windowMs: 60_000 },
      ],
    } as unknown as ICircuitBreakerService;
    new MetricsCircuitBreakerBridge(metrics, breaker, registry).onApplicationBootstrap();

    const text = await metrics.getMetrics();
    expect(sourcesLine(text)).toBe('ever_jobs_sources_total 9');
    expect(text).toMatch(/ever_jobs_source_circuit_state\{site="linkedin"\} 2\b/);
  });

  it('leaves the gauge at 0 when there is no registry', async () => {
    const metrics = new MetricsService();
    new MetricsCircuitBreakerBridge(metrics).onApplicationBootstrap();
    expect(sourcesLine(await metrics.getMetrics())).toBe('ever_jobs_sources_total 0');
  });
});
