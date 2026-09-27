import 'reflect-metadata';
import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import {
  HEALTH_SNAPSHOT_STORE_TOKEN,
  IHealthSnapshotStore,
  IJobObservationStore,
  IJobStore,
  IStoreMetadata,
  JOB_OBSERVATION_STORE_TOKEN,
  JOB_STORE_TOKEN,
  STORE_PLUGIN_METADATA_KEY,
  isHealthSnapshotStore,
} from '@ever-jobs/models';
import { StoreRegistry } from './store-registry.service';

/**
 * Options consumed by {@link StoreModule.forActive}.
 *
 * `backends` lists every `@StorePlugin()`-decorated provider class that
 * the running deployment is willing to use. Only classes named here are
 * instantiated by NestJS and registered with {@link StoreRegistry}; the
 * id passed to `forActive(storeId)` then selects which one is bound to
 * {@link JOB_STORE_TOKEN} (and, optionally,
 * {@link JOB_OBSERVATION_STORE_TOKEN}).
 *
 * Two-step setup is intentional: the framework must not auto-instantiate
 * heavyweight backends (e.g. Postgres clients) the operator hasn't asked
 * for. Listing them explicitly keeps cold-start cost (Spec 004 / NFR-4)
 * proportional to the deployment's actual store fleet.
 *
 * `bindObservationStore` (default `true`) controls whether the active
 * `IJobStore` is also bound to {@link JOB_OBSERVATION_STORE_TOKEN} as
 * an `IJobObservationStore`. Spec 004 §7 expects the same backend to
 * satisfy both contracts in production deployments — toggling this off
 * is reserved for tests that want to exercise the two interfaces
 * independently.
 */
export interface StoreModuleForActiveOptions {
  /**
   * `@StorePlugin()`-decorated provider classes participating in the
   * current run. Each must (a) be a NestJS-injectable class, (b) carry
   * {@link STORE_PLUGIN_METADATA_KEY} metadata via the decorator, and
   * (c) implement {@link IJobStore}.
   */
  readonly backends?: ReadonlyArray<Type<IJobStore>>;

  /**
   * Bind the chosen backend to {@link JOB_OBSERVATION_STORE_TOKEN} as
   * well. Defaults to `true`. Set `false` only in tests that wire a
   * separate observation store. Spec 004 §7 explicitly recommends
   * `true` in production: a single backend keeps the canonical row
   * and its source observations transactionally aligned.
   */
  readonly bindObservationStore?: boolean;

  /**
   * Bind the chosen backend to {@link HEALTH_SNAPSHOT_STORE_TOKEN} as
   * well, IF the active instance satisfies
   * {@link isHealthSnapshotStore} (Spec 005 / T09 / FR-8).
   *
   * Defaults to `true`. When the active backend doesn't implement
   * the snapshot contract (sqlite-drizzle / postgres-prisma as of
   * Spec 005 / T09), the token is left unbound — matching FR-8's
   * "bypass when no store" wording. The cron `@Optional()`-injects
   * the token and silently skips its tick.
   *
   * Set `false` to suppress auto-binding even when the backend
   * supports the contract — useful for tests that wire a separate
   * snapshot store, or for operators wanting canonical jobs in
   * Postgres but snapshots in Redis (the operator binds Redis
   * separately and disables the auto-binding).
   */
  readonly bindHealthSnapshotStore?: boolean;

  /**
   * Extra providers registered inside the store module's scope (Spec 1722).
   *
   * Backends inject their configuration through DI tokens
   * (`STORE_SQLITE_DRIZZLE_CONFIG`, `STORE_POSTGRES_PRISMA_CONFIG`). Those
   * tokens must resolve in *this* dynamic module — a provider declared in the
   * app's root module is not visible to a backend instantiated here — so the
   * bootstrap passes them through this option. Additive: omitting it keeps the
   * previous behaviour exactly.
   */
  readonly providers?: ReadonlyArray<Provider>;
}

/**
 * Marker error thrown when a class passed via `backends` is missing its
 * `@StorePlugin()` decorator. Surfaces at boot so the operator learns
 * about the misconfiguration before the first request — silent fall-back
 * (e.g. skipping the class) would leave them with a successful boot
 * and an inaccessible store id.
 *
 * Distinct from {@link import('./store-registry.service').StoreRegistryError}
 * because the failure is upstream of the registry: the class never even
 * presents itself for registration.
 */
export class StoreModuleConfigurationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'StoreModuleConfigurationError';
    this.code = code;
  }
}

/**
 * Bootstrap-time error code: a class passed in `backends` is missing
 * `@StorePlugin()` metadata. Operator-facing — exported from
 * `@ever-jobs/plugin` so log alerts can grep it literally.
 */
export const ERR_STORE_BACKEND_NOT_DECORATED = 'ERR_STORE_BACKEND_NOT_DECORATED';

/**
 * Bootstrap-time error code: `forActive('')` was called (empty / blank
 * id). Catches a common operator typo where `EVER_JOBS_STORE` is set
 * but empty.
 */
export const ERR_STORE_ACTIVE_ID_REQUIRED = 'ERR_STORE_ACTIVE_ID_REQUIRED';

/**
 * Dynamic module that binds the active persistent-store backend
 * (Spec 004 / FR-3 / FR-4 / T04).
 *
 * `StoreModule.forActive(storeId, { backends })` is the canonical entry
 * point. It returns a `DynamicModule` that:
 *
 *   1. Provides the {@link StoreRegistry} singleton (populated from the
 *      `@StorePlugin()` metadata of every class in `backends`).
 *   2. Instantiates each backend (via NestJS DI) and self-registers it
 *      into the registry.
 *   3. Resolves the backend whose `id` matches `storeId` and binds it
 *      to {@link JOB_STORE_TOKEN}.
 *   4. (default `true`) binds the same instance to
 *      {@link JOB_OBSERVATION_STORE_TOKEN} as an
 *      {@link IJobObservationStore}. Set
 *      `bindObservationStore: false` to suppress.
 *
 * Failure modes (all bootstrap, fail-fast):
 *
 *   - Empty `storeId` → throws with code
 *     {@link ERR_STORE_ACTIVE_ID_REQUIRED}.
 *   - A class in `backends` is not `@StorePlugin()`-decorated → throws
 *     with code {@link ERR_STORE_BACKEND_NOT_DECORATED}.
 *   - Two backends declare the same id → propagates
 *     `ERR_STORE_DUPLICATE_ID` from {@link StoreRegistry.register}.
 *   - `storeId` matches no registered backend → propagates
 *     `ERR_STORE_NOT_FOUND` from {@link StoreRegistry.get} (Spec 004
 *     §7.3).
 *
 * The dynamic module is `global` so any consumer (`apps/api`, future
 * `apps/cli`, integration tests) can inject `JOB_STORE_TOKEN` /
 * `JOB_OBSERVATION_STORE_TOKEN` without re-importing this module per
 * feature. Mirrors the {@link import('../plugin.module').PluginModule}
 * convention.
 *
 * @example
 * ```typescript
 * @Module({
 *   imports: [
 *     StoreModule.forActive(process.env.EVER_JOBS_STORE ?? 'memory', {
 *       backends: [InMemoryJobStore, PostgresJobStore],
 *     }),
 *   ],
 * })
 * export class AppModule {}
 *
 * // anywhere downstream:
 * @Injectable()
 * export class JobsService {
 *   constructor(
 *     @Inject(JOB_STORE_TOKEN) private readonly store: IJobStore,
 *   ) {}
 * }
 * ```
 */
@Module({})
export class StoreModule {
  static forActive(
    storeId: string,
    options: StoreModuleForActiveOptions = {},
  ): DynamicModule {
    if (typeof storeId !== 'string' || storeId.trim().length === 0) {
      throw new StoreModuleConfigurationError(
        `StoreModule.forActive() requires a non-empty storeId (got ${JSON.stringify(storeId)}). ` +
          `Set EVER_JOBS_STORE to one of: [${(options.backends ?? [])
            .map((b) => readStoreId(b))
            .filter((id): id is string => typeof id === 'string')
            .join(', ')}]`,
        ERR_STORE_ACTIVE_ID_REQUIRED,
      );
    }

    const backends = options.backends ?? [];
    const bindObservationStore = options.bindObservationStore !== false;
    const bindHealthSnapshotStore = options.bindHealthSnapshotStore !== false;

    // Pre-validate `backends` before NestJS even constructs them — a
    // missing `@StorePlugin()` decorator is a programmer error that
    // surfaces here as a structured `StoreModuleConfigurationError`
    // rather than a runtime "Cannot read 'id' of undefined" downstream.
    for (const backend of backends) {
      const meta = readStorePluginMetadata(backend);
      if (!meta) {
        throw new StoreModuleConfigurationError(
          `Class ${backend.name} is listed in StoreModule.forActive({ backends }) ` +
            `but is not decorated with @StorePlugin({ id }). ` +
            `Add @StorePlugin({ id: '<kebab-case-id>' }) to the class.`,
          ERR_STORE_BACKEND_NOT_DECORATED,
        );
      }
    }

    const backendProviders: Provider[] = backends.map((b) => b);

    /**
     * Factory provider for {@link JOB_STORE_TOKEN}. NestJS instantiates
     * `StoreRegistry` and every class in `inject` (i.e. every backend)
     * before invoking this factory, so all backends are constructed and
     * available as `instances` here. We then walk the parallel
     * `backends` / `instances` arrays, attach metadata, and register
     * each into the registry — after which `registry.get(storeId)`
     * resolves the active backend.
     *
     * `register()` is called unconditionally: two backends advertising
     * the same id is a configuration bug and MUST raise
     * `ERR_STORE_DUPLICATE_ID` (Spec 004 §7.3 spirit; the registry
     * enforces this). Silent skip-on-duplicate would let an operator
     * ship a deployment where a typo in one backend's id silently
     * binds the wrong implementation. A future refactor that needs
     * idempotence (e.g. hot-swap support) MUST opt in explicitly via
     * a separate API on the registry.
     */
    const activeStoreProvider: Provider = {
      provide: JOB_STORE_TOKEN,
      useFactory: (registry: StoreRegistry, ...instances: IJobStore[]) => {
        for (let i = 0; i < backends.length; i++) {
          const cls = backends[i];
          const meta = readStorePluginMetadata(cls);
          // Already validated above; the cast is safe.
          const m = meta as IStoreMetadata;
          registry.register(m, instances[i]);
        }
        return registry.get(storeId);
      },
      inject: [StoreRegistry, ...backends],
    };

    const providers: Provider[] = [
      ...(options.providers ?? []),
      StoreRegistry,
      ...backendProviders,
      activeStoreProvider,
    ];

    if (bindObservationStore) {
      /**
       * Factory provider for {@link JOB_OBSERVATION_STORE_TOKEN}. By
       * default we bind it to the same instance as `JOB_STORE_TOKEN`
       * (Spec 004 §7: the same backend implements both interfaces in
       * production). Backends that only implement `IJobStore` and
       * leave `IJobObservationStore` unimplemented should set
       * `bindObservationStore: false` and bind a separate observation
       * store explicitly.
       *
       * The cast `as unknown as IJobObservationStore` is intentional —
       * TypeScript can't prove a runtime instance satisfies a second
       * interface, but the contract documented in
       * `IStoreMetadata` / `IJobStore` JSDoc commits backends to
       * implementing both. Conformance tests (Spec 004 / Phase 2+) will
       * gate this at the per-backend level.
       */
      providers.push({
        provide: JOB_OBSERVATION_STORE_TOKEN,
        useFactory: (active: IJobStore): IJobObservationStore =>
          active as unknown as IJobObservationStore,
        inject: [JOB_STORE_TOKEN],
      });
    }

    if (bindHealthSnapshotStore) {
      /**
       * Factory provider for {@link HEALTH_SNAPSHOT_STORE_TOKEN}
       * (Spec 005 / T09 / FR-8).
       *
       * Unlike `JOB_OBSERVATION_STORE_TOKEN` (which Spec 004 makes a
       * MUST-implement), the health-snapshot contract is OPTIONAL —
       * sqlite-drizzle / postgres-prisma as of Spec 005 / T09 don't
       * implement it. We runtime type-guard via
       * {@link isHealthSnapshotStore} and return `null` for backends
       * that don't satisfy the contract. The cron
       * `@Optional()`-injects this token and treats `null` as
       * "no store bound; bypass" — matching FR-8's
       * "bypass when no store" wording exactly.
       *
       * Returning `null` (not `undefined`) is intentional: NestJS
       * factory providers that return `undefined` are treated by
       * some Nest internals as "no value" and synthesised into
       * `MissingProvider` errors; `null` survives the DI graph
       * cleanly and reaches the consumer's `@Optional()` slot.
       */
      providers.push({
        provide: HEALTH_SNAPSHOT_STORE_TOKEN,
        useFactory: (active: IJobStore): IHealthSnapshotStore | null =>
          isHealthSnapshotStore(active) ? active : null,
        inject: [JOB_STORE_TOKEN],
      });
    }

    const exports_: Array<string | symbol | Type<unknown>> = [
      JOB_STORE_TOKEN,
      StoreRegistry,
    ];
    if (bindObservationStore) {
      exports_.push(JOB_OBSERVATION_STORE_TOKEN);
    }
    if (bindHealthSnapshotStore) {
      exports_.push(HEALTH_SNAPSHOT_STORE_TOKEN);
    }

    return {
      module: StoreModule,
      global: true,
      providers,
      exports: exports_,
    };
  }
}

/**
 * Resolve the `id` advertised by a backend class via `@StorePlugin()`.
 * Returns `undefined` when the class is not decorated. Used in error
 * messages so operators see "Set EVER_JOBS_STORE to one of: [...]"
 * with the backend ids actually configured.
 */
function readStoreId(cls: Type<IJobStore>): string | undefined {
  const meta = readStorePluginMetadata(cls);
  return meta?.id;
}

/**
 * Read the `@StorePlugin()` metadata from a backend class without
 * pulling in `Reflector` (we're outside Nest DI here — the dynamic
 * module factory runs at module-definition time).
 */
function readStorePluginMetadata(
  cls: Type<IJobStore>,
): IStoreMetadata | undefined {
  return Reflect.getMetadata(STORE_PLUGIN_METADATA_KEY, cls) as
    | IStoreMetadata
    | undefined;
}
