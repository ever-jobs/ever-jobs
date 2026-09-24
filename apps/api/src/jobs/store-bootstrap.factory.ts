import * as fs from 'fs';
import * as path from 'path';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Provider,
  Type,
} from '@nestjs/common';
import { ERR_STORE_NOT_FOUND, IJobStore } from '@ever-jobs/models';
import { StoreRegistryError } from '@ever-jobs/plugin';
import { InMemoryJobStore } from '@ever-jobs/store-memory';
import {
  STORE_SQLITE_DRIZZLE_CONFIG,
  SqliteDrizzleJobStore,
  StoreSqliteDrizzleConfig,
} from '@ever-jobs/store-sqlite-drizzle';
import {
  PostgresPrismaJobStore,
  PrismaJobsClient,
  STORE_POSTGRES_PRISMA_CONFIG,
  StorePostgresPrismaConfig,
} from '@ever-jobs/store-postgres-prisma';
import {
  DEFAULT_STORE_ID,
  ERR_STORE_BACKEND_DOWN,
  EVER_JOBS_STORE_ENV_VAR,
  KNOWN_STORE_IDS,
  KnownStoreId,
  StoreConfigError,
  redactDatabaseUrl,
  resolvePersistSearch,
  resolvePostgresUrl,
  resolveSqlitePath,
  resolveStoreSelection,
} from '../config/store-config';

/**
 * Spec 004 / T12 — `EVER_JOBS_STORE` env-var bootstrap factory; made
 * functional from the environment alone by Spec 1722.
 *
 * Two steps, both run synchronously at module evaluation in `app.module.ts`
 * so a misconfiguration fails before any HTTP listener is attached
 * (Spec 004 §7.3):
 *
 *   1. {@link resolveStoreBootstrap} — which backend (`EVER_JOBS_STORE`, alias
 *      `EVER_JOBS_STORE_PLUGIN`, package names accepted) and whether the search
 *      path persists (`EVER_JOBS_PERSIST_SEARCH`, defaulting from the backend).
 *   2. {@link resolveStoreProviders} — the config providers the chosen backend
 *      needs, resolved from env (`EVER_JOBS_STORE_SQLITE_PATH`,
 *      `EVER_JOBS_STORE_DATABASE_URL` / `DATABASE_URL`). A missing required
 *      variable throws {@link StoreConfigError} (`ERR_STORE_CONFIG_MISSING`).
 *
 * Choice of "lazy resolve by id" over "eager declare every backend" is locked
 * in by Q-019 (Option C). Prisma in particular is only `require`d when
 * `postgres` is selected.
 *
 * @see {@link KNOWN_STORE_IDS} — the literal set of recognised ids.
 * @see {@link DEFAULT_STORE_ID} — fallback when no selector is set.
 */

export { DEFAULT_STORE_ID, EVER_JOBS_STORE_ENV_VAR, KNOWN_STORE_IDS };
export type { KnownStoreId };

/**
 * Map of recognised store id → `@StorePlugin()`-decorated backend class. The
 * single source of truth for the "id → class" relationship; a fourth backend
 * is wired here and in `KNOWN_STORE_IDS` / `STORE_ID_ALIASES`.
 */
const STORE_BACKEND_BY_ID: Readonly<Record<KnownStoreId, Type<IJobStore>>> = {
  memory: InMemoryJobStore,
  sqlite: SqliteDrizzleJobStore,
  postgres: PostgresPrismaJobStore,
};

/** Result of {@link resolveStoreBootstrap}. */
export interface ResolvedStoreBootstrap {
  /** Resolved id — always a member of {@link KNOWN_STORE_IDS}. */
  readonly id: KnownStoreId;
  /** `@StorePlugin()`-decorated backend class for `StoreModule.forActive`. */
  readonly backendClass: Type<IJobStore>;
  /** A selector variable was set (vs. the silent `memory` default). */
  readonly explicit: boolean;
  /**
   * Effective `EVER_JOBS_PERSIST_SEARCH` (Spec 1722): explicit value wins,
   * otherwise `true` only for an explicitly selected durable backend. The
   * same value `configuration.ts` exposes as `store.persistSearch`.
   */
  readonly persistSearch: boolean;
}

/**
 * Resolve the active store backend.
 *
 *   - Nothing set → `memory`, persistence off (the stock and our deployment's
 *     behaviour).
 *   - `EVER_JOBS_STORE` / `EVER_JOBS_STORE_PLUGIN` = `memory|sqlite|postgres`
 *     or a plugin package name (`store-postgres-prisma`, …) → that backend.
 *   - Unknown id → {@link StoreRegistryError} `ERR_STORE_NOT_FOUND`, naming
 *     the recognised ids (operator dashboards grep the code literally).
 *   - Both selectors set to different backends → {@link StoreConfigError}
 *     `ERR_STORE_CONFLICT`.
 *
 * Pure apart from one warning log: same env → same result. `env` defaults to
 * `process.env`; tests pass a synthetic record.
 */
export function resolveStoreBootstrap(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedStoreBootstrap {
  let selection;
  try {
    selection = resolveStoreSelection(env);
  } catch (err) {
    // Keep the Spec 004 / T12 contract: an unknown id is a StoreRegistryError.
    if (err instanceof StoreConfigError && err.code === ERR_STORE_NOT_FOUND) {
      throw new StoreRegistryError(err.message, ERR_STORE_NOT_FOUND);
    }
    throw err;
  }
  const persistSearch = resolvePersistSearch(env);

  // Spec 5024, narrowed by Spec 1722 — the in-memory backend retains every
  // persisted row in-process. That is only a hazard when something actually
  // writes to it, which since Spec 1722 requires opting in explicitly.
  if (selection.id === 'memory' && persistSearch && env.NODE_ENV === 'production') {
    new Logger('StoreBootstrap').warn(
      `EVER_JOBS_PERSIST_SEARCH is on while the store is '${DEFAULT_STORE_ID}' and NODE_ENV=production. ` +
        `The in-memory backend keeps every persisted canonical job and observation in the process heap ` +
        `(bounded by EVER_JOBS_STORE_MAX_ROWS) and nothing reads it back. Select a durable backend via ` +
        `${EVER_JOBS_STORE_ENV_VAR}=postgres|sqlite, or unset EVER_JOBS_PERSIST_SEARCH.`,
    );
  }

  return {
    id: selection.id,
    backendClass: STORE_BACKEND_BY_ID[selection.id],
    explicit: selection.explicit,
    persistSearch,
  };
}

/**
 * DI token for the connected Prisma client of the Postgres store. Exported so
 * tests and operators' own modules can reach the same client.
 */
export const POSTGRES_STORE_CLIENT = 'EVER_JOBS_POSTGRES_STORE_CLIENT';

/** Minimal surface of a generated `PrismaClient` this bootstrap relies on. */
export type ConnectablePrismaClient = PrismaJobsClient & {
  $connect(): Promise<void>;
};

/** Constructor of a generated `PrismaClient`. */
export type PrismaClientCtor = new (options: { datasourceUrl: string }) => ConnectablePrismaClient;

/** How to generate the client — repeated in every Prisma-related error. */
const PRISMA_GENERATE_HINT =
  'Run `npm run store:postgres:generate` (prisma generate for packages/plugins/store-postgres-prisma) ' +
  'after installing dependencies.';

/**
 * Load `PrismaClient` from `@prisma/client` at call time, so no deployment
 * that does not select `postgres` ever loads Prisma.
 *
 * @throws {@link StoreConfigError} `ERR_STORE_BACKEND_DOWN` when the package
 *         is missing or exports no constructor.
 */
export function loadPrismaClientCtor(): PrismaClientCtor {
  let mod: { PrismaClient?: unknown };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    mod = require('@prisma/client');
  } catch (err) {
    throw new StoreConfigError(
      `EVER_JOBS_STORE=postgres needs the @prisma/client package: ${
        err instanceof Error ? err.message : String(err)
      }. ${PRISMA_GENERATE_HINT}`,
      ERR_STORE_BACKEND_DOWN,
    );
  }
  if (typeof mod?.PrismaClient !== 'function') {
    throw new StoreConfigError(
      `@prisma/client exports no PrismaClient. ${PRISMA_GENERATE_HINT}`,
      ERR_STORE_BACKEND_DOWN,
    );
  }
  return mod.PrismaClient as PrismaClientCtor;
}

/**
 * Remove anything credential-shaped from a driver error before it reaches a
 * log: the full URL and the decoded password, if the URL carried one.
 */
function scrubSecrets(message: string, url: string): string {
  let out = message.split(url).join(redactDatabaseUrl(url));
  try {
    const password = decodeURIComponent(new URL(url).password);
    if (password.length >= 3) out = out.split(password).join('***');
  } catch {
    // unparsable URL — nothing more to scrub
  }
  return out;
}

/**
 * Construct and connect a Prisma client for the store (Spec 1722 FR-7).
 *
 * Connecting at boot is what turns a wrong host, port, password or database
 * into a failed deploy instead of a stream of `persistError`s on every
 * search (Q-102). The message names the host and database only.
 *
 * @throws {@link StoreConfigError} `ERR_STORE_BACKEND_DOWN`
 */
export async function connectPostgresStoreClient(
  url: string,
  loadCtor: () => PrismaClientCtor = loadPrismaClientCtor,
): Promise<ConnectablePrismaClient> {
  const Ctor = loadCtor();
  let client: ConnectablePrismaClient;
  try {
    client = new Ctor({ datasourceUrl: url });
  } catch (err) {
    throw new StoreConfigError(
      `Could not construct the Prisma client for the Postgres store: ${scrubSecrets(
        err instanceof Error ? err.message : String(err),
        url,
      )}. ${PRISMA_GENERATE_HINT}`,
      ERR_STORE_BACKEND_DOWN,
    );
  }
  try {
    await client.$connect();
  } catch (err) {
    await client.$disconnect().catch(() => undefined);
    throw new StoreConfigError(
      `Postgres store unreachable at ${redactDatabaseUrl(url)}: ${scrubSecrets(
        err instanceof Error ? err.message : String(err),
        url,
      )}. Check EVER_JOBS_STORE_DATABASE_URL / DATABASE_URL, and that the schema exists ` +
        '(`npm run store:postgres:migrate`).',
      ERR_STORE_BACKEND_DOWN,
    );
  }
  new Logger('StoreBootstrap').log(`Postgres store connected: ${redactDatabaseUrl(url)}`);
  return client;
}

/**
 * Disconnects the store's Prisma client when the Nest application closes, so
 * `app.close()` (and Jest) never leaves a pool open.
 */
@Injectable()
export class PostgresStoreClientLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(POSTGRES_STORE_CLIENT)
    private readonly client: Pick<ConnectablePrismaClient, '$disconnect'>,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect().catch(() => undefined);
  }
}

/** Options for {@link resolveStoreProviders}; test seams only. */
export interface ResolveStoreProvidersOptions {
  /** Replace the lazy `@prisma/client` loader (tests inject a fake). */
  readonly loadPrismaClient?: () => PrismaClientCtor;
}

/**
 * Config providers the selected backend needs, for
 * `StoreModule.forActive(id, { backends, providers })` (Spec 1722).
 *
 *   - `memory` → none.
 *   - `sqlite` → `STORE_SQLITE_DRIZZLE_CONFIG` = `{ databaseUrl: <path> }`;
 *     the parent directory is created on first use.
 *   - `postgres` → a connected Prisma client under {@link POSTGRES_STORE_CLIENT},
 *     `STORE_POSTGRES_PRISMA_CONFIG` = `{ client }`, and a lifecycle provider
 *     that disconnects on shutdown.
 *
 * Required variables are read **synchronously here**, so a missing one fails
 * at module evaluation, before Nest constructs anything.
 *
 * @throws {@link StoreConfigError} `ERR_STORE_CONFIG_MISSING` / `ERR_STORE_CONFIG_INVALID`
 */
export function resolveStoreProviders(
  id: KnownStoreId,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveStoreProvidersOptions = {},
): Provider[] {
  switch (id) {
    case 'memory':
      return [];
    case 'sqlite': {
      const databaseUrl = resolveSqlitePath(env);
      return [
        {
          provide: STORE_SQLITE_DRIZZLE_CONFIG,
          useFactory: (): StoreSqliteDrizzleConfig => {
            if (databaseUrl !== ':memory:') {
              fs.mkdirSync(path.dirname(path.resolve(databaseUrl)), { recursive: true });
            }
            new Logger('StoreBootstrap').log(`SQLite store: ${databaseUrl}`);
            return { databaseUrl };
          },
        },
      ];
    }
    case 'postgres': {
      const url = resolvePostgresUrl(env);
      const loadCtor = options.loadPrismaClient ?? loadPrismaClientCtor;
      return [
        {
          provide: POSTGRES_STORE_CLIENT,
          useFactory: () => connectPostgresStoreClient(url, loadCtor),
        },
        {
          provide: STORE_POSTGRES_PRISMA_CONFIG,
          useFactory: (client: ConnectablePrismaClient): StorePostgresPrismaConfig => ({
            client,
          }),
          inject: [POSTGRES_STORE_CLIENT],
        },
        PostgresStoreClientLifecycle,
      ];
    }
    default: {
      const unreachable: never = id;
      throw new StoreConfigError(`Unhandled store id ${String(unreachable)}`, ERR_STORE_NOT_FOUND);
    }
  }
}
