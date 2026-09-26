import { Module } from '@nestjs/common';
import { PluginModule, CircuitBreakerModule } from '@ever-jobs/plugin';
import { ALL_SOURCE_MODULES } from '@ever-jobs/plugin-sources';
import { AnalyticsModule } from '@ever-jobs/analytics';
import { DedupHybridModule } from '@ever-jobs/dedup-hybrid';
import { MergeDefaultModule } from '@ever-jobs/merge-default';
import { LivenessHttpModule } from '@ever-jobs/liveness-http';
import { LegitimacyDetectorModule } from '@ever-jobs/legitimacy-detector';
import { CareerLevelClassifierModule } from '@ever-jobs/career-level-classifier';
import { JobsService } from './jobs.service';
import { JobsAggregator } from './jobs.aggregator';
import { JobsController } from './jobs.controller';
import { JobsResolver } from './jobs.resolver';
import { SourcesHealthController } from './health.controller';
import { MetricsCircuitBreakerBridge } from './metrics-circuit-breaker.bridge';
import { PluginPolicyBootstrapper } from './plugin-policy.bootstrapper';
import { HealthSnapshotCron } from './health-snapshot.cron';

@Module({
  imports: [
    PluginModule,
    ...ALL_SOURCE_MODULES,
    AnalyticsModule,
    // Spec 003 / Phase 5 — bind the default dedup engine + merge resolver
    // under their tokens so the aggregator can pick them up by DI. Either
    // module can be swapped for a custom implementation that re-uses the
    // same token (FR-1 / FR-4).
    DedupHybridModule,
    MergeDefaultModule,
    // Spec 740 — opt-in corpus signals (liveness reused from Spec 721; legitimacy net-new).
    // Bound under LIVENESS_CHECKER_TOKEN / LEGITIMACY_CHECKER_TOKEN; the controller injects
    // them @Optional() and only enriches when ?liveness=true / ?legitimacy=true.
    LivenessHttpModule,
    LegitimacyDetectorModule,
    // Spec 1730 — career-level classifier under CAREER_LEVEL_CLASSIFIER_TOKEN; the aggregator
    // injects it @Optional() and classifies every returned job after dedup.
    CareerLevelClassifierModule,
    // Spec 005 / T04 — bind the circuit-breaker service + interceptor so
    // `JobsService` can wrap each per-source `scrape()` call. The
    // underlying engine is swappable by replacing this module (the
    // service is registered under `CIRCUIT_BREAKER_TOKEN`).
    CircuitBreakerModule,
  ],
  controllers: [JobsController, SourcesHealthController],
  providers: [
    JobsService,
    JobsAggregator,
    JobsResolver,
    // Spec 005 / T06 — wires CIRCUIT_BREAKER_TOKEN into MetricsService's
    // `source_circuit_state` Gauge at OnApplicationBootstrap. Pure
    // wiring; safe to register here because both deps resolve from
    // this module's import graph.
    MetricsCircuitBreakerBridge,
    // Spec 005 / T08 — discovery-side wiring for per-plugin
    // `getCircuitBreakerPolicy()` overrides (FR-3). At
    // OnApplicationBootstrap, scans `PluginRegistry` and pushes any
    // override into the breaker via `setPolicy`. Plugins with no
    // override silently keep `DEFAULT_CIRCUIT_POLICY`.
    PluginPolicyBootstrapper,
    // Spec 005 / T09 — periodic (60 s) `breaker.list() → store.putAll(...)`
    // cron. Both deps are `@Optional()`; the cron silently bypasses
    // when either is unbound (FR-8: "best-effort" + "bypass when no
    // store"). Adds zero hot-path cost and zero new dependencies
    // (uses `setInterval` rather than `@nestjs/schedule` per Q-020 /
    // Option A).
    HealthSnapshotCron,
  ],
  exports: [JobsService, JobsAggregator],
})
export class JobsModule {}
