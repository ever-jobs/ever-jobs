import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StoreModule } from '@ever-jobs/plugin';
import { AppConfigModule } from './config/config.module';
import { AppCacheModule } from './cache/cache.module';
import { MetricsModule } from './metrics/metrics.module';
import { MetricsInterceptor } from './metrics/metrics.interceptor';

import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { ApiKeyGuard } from './auth/api-key.guard';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { resolveStoreBootstrap } from './jobs/store-bootstrap.factory';

/**
 * Spec 004 / T12 — `EVER_JOBS_STORE` env-var honoured at bootstrap.
 *
 * `resolveStoreBootstrap()` runs at module-evaluation time (synchronously)
 * and either returns the `{ id, backendClass }` for the active backend
 * OR throws `StoreRegistryError` (`ERR_STORE_NOT_FOUND`) when the env
 * var names an unrecognised id. A throw here surfaces during NestJS
 * `bootstrap()` BEFORE any HTTP listener is attached — exactly the
 * fail-fast posture Spec 004 §7.3 requires.
 *
 * The choice to lazy-resolve (one backend per boot, not all three) is
 * locked in by Q-019 / Option C: cold-start cost is proportional to
 * the active backend (NFR-4 budgets 750 ms; eager-all would pay for
 * `better-sqlite3` native bindings even in `memory` mode).
 */
const ACTIVE_STORE = resolveStoreBootstrap();

@Module({
  imports: [
    // Global config (loads .env)
    AppConfigModule,

    // Rate limiting (configurable via env vars)
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: (config.get<number>('rateLimit.timeframeSec', 3600)) * 1000,
            limit: config.get<number>('rateLimit.maxRequests', 100),
          },
        ],
        // Skip throttling when disabled
        skipIf: () => !config.get<boolean>('rateLimit.enabled', false),
      }),
    }),

    // GraphQL API (alongside REST)
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        autoSchemaFile: true,
        sortSchema: true,
        // Apollo Server 5 removed the bundled GraphQL Playground (the old
        // `playground: true` pulled the deprecated, unmaintained
        // `@apollo/server-plugin-landing-page-graphql-playground`). @nestjs/apollo
        // v13 serves the modern Apollo Sandbox landing page by default, so no
        // explicit landing-page plugin is configured here — adding one throws
        // "Only one plugin can implement renderLandingPage" at startup.
        path: config.get<string>('graphql.path', 'graphql'),
        introspection: true,
        // Disable GraphQL module entirely if env var is set
        ...(config.get<boolean>('graphql.enabled', true) ? {} : { autoSchemaFile: false }),
      }),
    }),

    // Global cache (Redis or in-memory)
    AppCacheModule,

    // Health endpoints
    HealthModule,

    // Spec 004 / T12 — `EVER_JOBS_STORE` env-var resolved into the
    // active `IJobStore` + `IJobObservationStore` bindings before
    // `JobsModule` imports. Importing `StoreModule.forActive(...)` here
    // (above `JobsModule`) keeps the global-module ordering clean: the
    // aggregator's `@Optional() @Inject(JOB_STORE_TOKEN)` slots resolve
    // against the bound provider rather than `undefined`.
    StoreModule.forActive(ACTIVE_STORE.id, {
      backends: [ACTIVE_STORE.backendClass],
    }),

    // Job scraping
    JobsModule,

    // Metrics tracking
    MetricsModule,


  ],
  providers: [
    // Global API key guard
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
    // Global rate limit guard
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Global metrics tracking
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
    // Global request logging
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
