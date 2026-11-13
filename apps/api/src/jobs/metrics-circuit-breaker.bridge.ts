import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import {
  CIRCUIT_BREAKER_TOKEN,
  ICircuitBreakerService,
} from '@ever-jobs/models';
import { PluginRegistry } from '@ever-jobs/plugin';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Spec 005 / T06 — bridges {@link ICircuitBreakerService} into
 * {@link MetricsService.sourceCircuitState}.
 *
 * **Why a bridge instead of injecting `CIRCUIT_BREAKER_TOKEN` straight
 * into `MetricsService`?** `MetricsModule` is `@Global()` and pulled
 * into every app bootstrap (including narrow test bootstraps);
 * `CircuitBreakerModule` is intentionally *not* global — it's a
 * pluggable engine imported once at the application boundary by
 * `JobsModule`. Reaching across that boundary from `MetricsService`
 * would either force `CircuitBreakerModule` to become global (bloating
 * every test bootstrap) or violate AGENTS.md §5's "no peer-plugin
 * imports" rule. The bridge owns *both* dependencies (it lives in
 * `JobsModule` where the breaker is bound, and `MetricsService` is
 * resolvable via the global module) and writes the breaker into the
 * Gauge's `collect()` callback at `OnApplicationBootstrap`. When the
 * breaker isn't bound (`@Optional()`), the bridge is a no-op and the
 * Gauge stays absent from `/metrics`.
 *
 * The closure captures `breaker.list` bound to `breaker` so a future
 * swap of the engine through `CIRCUIT_BREAKER_TOKEN` doesn't require
 * touching this file.
 *
 * Q-015 / Option A.
 */
@Injectable()
export class MetricsCircuitBreakerBridge implements OnApplicationBootstrap {
  private readonly logger = new Logger(MetricsCircuitBreakerBridge.name);

  constructor(
    private readonly metrics: MetricsService,
    @Optional()
    @Inject(CIRCUIT_BREAKER_TOKEN)
    private readonly breaker?: ICircuitBreakerService,
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  onApplicationBootstrap(): void {
    // `ever_jobs_sources_total` follows the plugin registry; it does not
    // depend on the breaker, so bind it before the breaker's early return.
    if (this.registry) {
      const registry = this.registry;
      this.metrics.bindSourceCountSource(() => registry.size);
    }
    if (!this.breaker) {
      this.logger.warn(
        'No circuit-breaker bound under CIRCUIT_BREAKER_TOKEN; ' +
          'source_circuit_state Gauge will be absent from /metrics',
      );
      return;
    }
    this.metrics.bindCircuitBreakerSource(() => this.breaker!.list());
  }
}
