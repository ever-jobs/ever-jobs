import { Module } from '@nestjs/common';
import { AnalyticsModule } from '@ever-jobs/analytics';
import { AppConfigModule } from '../../api/src/config/config.module';
import { AppCacheModule } from '../../api/src/cache/cache.module';
import { MetricsModule } from '../../api/src/metrics/metrics.module';
import { JobsModule } from '../../api/src/jobs/jobs.module';
import { SearchCommand } from './commands/search.command';
import { CompareCommand } from './commands/compare.command';

/**
 * CLI root module.
 *
 * Reuses the API's `JobsModule` rather than wiring sources by hand, so the
 * CLI sees exactly the same plugin set (`ALL_SOURCE_MODULES` via
 * `PluginRegistry`), circuit breaker, dedup and merge bindings as the API.
 * `JobsService` now depends on `PluginRegistry`, `ConfigService` and
 * `MetricsService`; a hand-maintained source list here drifted out of sync
 * and failed DI at startup.
 */
@Module({
  imports: [
    // Global config (loads .env) — provides ConfigService
    AppConfigModule,
    // Global cache — JobsController (part of JobsModule) injects CacheService
    AppCacheModule,
    // Global metrics — JobsService injects MetricsService
    MetricsModule,
    // Sources, PluginRegistry, circuit breaker; exports JobsService
    JobsModule,
    // AnalyticsService for the search/compare commands
    AnalyticsModule,
  ],
  providers: [SearchCommand, CompareCommand],
})
export class CliModule {}
