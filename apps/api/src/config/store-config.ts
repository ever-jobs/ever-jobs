/**
 * Pure store-selection and store-config resolvers (Spec 1722).
 *
 * Both `configuration.ts` (for `store.persistSearch`) and the store bootstrap
 * factory (for the backend class and its config providers) read this module,
 * so the persistence default and the selected backend can never disagree.
 *
 * Deliberately free of backend imports: resolving the selection must not load
 * `better-sqlite3` or `@prisma/client` (Spec 004 NFR-4 cold-start budget).
 */
import { ERR_STORE_BACKEND_DOWN, ERR_STORE_NOT_FOUND } from '@ever-jobs/models';

type Env = Readonly<Record<string, string | undefined>>;

/** Primary selector (Spec 004 / T12). */
export const EVER_JOBS_STORE_ENV_VAR = 'EVER_JOBS_STORE';
/** Alias selector read only when {@link EVER_JOBS_STORE_ENV_VAR} is unset/blank. */
export const EVER_JOBS_STORE_PLUGIN_ENV_VAR = 'EVER_JOBS_STORE_PLUGIN';
/** Persist every search result (Spec 5024; default changed by Spec 1722). */
export const PERSIST_SEARCH_ENV_VAR = 'EVER_JOBS_PERSIST_SEARCH';
/** SQLite database file (Spec 1722). */
export const STORE_SQLITE_PATH_ENV_VAR = 'EVER_JOBS_STORE_SQLITE_PATH';
/** Name the sqlite plugin's own docs used; honoured as a fallback. */
export const LEGACY_SQLITE_PATH_ENV_VAR = 'EVER_JOBS_SQLITE_PATH';
/** Postgres connection URL for the store (Spec 1722). */
export const STORE_DATABASE_URL_ENV_VAR = 'EVER_JOBS_STORE_DATABASE_URL';
/** Conventional fallback; also what `prisma/schema.prisma` reads. */
export const DATABASE_URL_ENV_VAR = 'DATABASE_URL';

/** Literal set of built-in store ids. Order is part of the error-message contract. */
export const KNOWN_STORE_IDS = ['memory', 'sqlite', 'postgres'] as const;
export type KnownStoreId = (typeof KNOWN_STORE_IDS)[number];

/** Backend used when nothing is selected. Never implies persistence. */
export const DEFAULT_STORE_ID: KnownStoreId = 'memory';

/**
 * Accepted spellings → backend id. The plugin package names are accepted so
 * a forker can copy the directory name they see under `packages/plugins/`.
 * Lower-case only: Spec 004 / T12 deliberately rejects `MEMORY`/`Postgres`
 * so a config drift is loud rather than silently normalised.
 */
export const STORE_ID_ALIASES: Readonly<Record<string, KnownStoreId>> = {
  memory: 'memory',
  'in-memory': 'memory',
  'store-memory': 'memory',
  sqlite: 'sqlite',
  'sqlite-drizzle': 'sqlite',
  'store-sqlite-drizzle': 'sqlite',
  postgres: 'postgres',
  postgresql: 'postgres',
  'postgres-prisma': 'postgres',
  'store-postgres-prisma': 'postgres',
};

/** Both selectors are set and name different backends. */
export const ERR_STORE_CONFLICT = 'ERR_STORE_CONFLICT';
/** The selected backend's required variable is unset. */
export const ERR_STORE_CONFIG_MISSING = 'ERR_STORE_CONFIG_MISSING';
/** The variable is set but unusable. */
export const ERR_STORE_CONFIG_INVALID = 'ERR_STORE_CONFIG_INVALID';

/**
 * Boot-time store configuration error. Carries a wire-stable `code` so log
 * alerts can grep it, exactly like `StoreRegistryError`.
 */
export class StoreConfigError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'StoreConfigError';
    this.code = code;
  }
}

export interface StoreSelection {
  /** Resolved backend id. */
  readonly id: KnownStoreId;
  /** `true` when a selector variable was set (not the silent default). */
  readonly explicit: boolean;
  /** Which variable decided (`'default'` when none was set). */
  readonly source: typeof EVER_JOBS_STORE_ENV_VAR | typeof EVER_JOBS_STORE_PLUGIN_ENV_VAR | 'default';
  /** The raw value as the operator wrote it (for error messages). */
  readonly raw?: string;
}

function blankToUndefined(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Map one selector value to a backend id, or `undefined` when unrecognised.
 * Strips an optional `@ever-jobs/` scope so the npm package name works too.
 */
export function storeIdFromValue(value: string): KnownStoreId | undefined {
  const bare = value.trim().replace(/^@ever-jobs\//, '');
  return Object.prototype.hasOwnProperty.call(STORE_ID_ALIASES, bare)
    ? STORE_ID_ALIASES[bare]
    : undefined;
}

function unknownStore(variable: string, raw: string): StoreConfigError {
  return new StoreConfigError(
    `${variable}=${JSON.stringify(raw)} does not match any built-in store id. ` +
      `Known ids: [${KNOWN_STORE_IDS.join(', ')}] ` +
      `(also accepted: ${Object.keys(STORE_ID_ALIASES)
        .filter((alias) => !(KNOWN_STORE_IDS as readonly string[]).includes(alias))
        .join(', ')}). ` +
      `Set ${EVER_JOBS_STORE_ENV_VAR} to one of those, or unset it to use the default ('${DEFAULT_STORE_ID}').`,
    ERR_STORE_NOT_FOUND,
  );
}

/**
 * Resolve which backend the operator selected.
 *
 * `EVER_JOBS_STORE` wins; `EVER_JOBS_STORE_PLUGIN` is read only when it is
 * unset/blank. When both are set and name different backends the boot fails
 * with {@link ERR_STORE_CONFLICT} — guessing which one was meant is how a
 * "durable" deployment ends up on the heap.
 *
 * @throws {@link StoreConfigError} `ERR_STORE_NOT_FOUND` / `ERR_STORE_CONFLICT`
 */
export function resolveStoreSelection(env: Env): StoreSelection {
  const primaryRaw = blankToUndefined(env[EVER_JOBS_STORE_ENV_VAR]);
  const aliasRaw = blankToUndefined(env[EVER_JOBS_STORE_PLUGIN_ENV_VAR]);

  const primary = primaryRaw === undefined ? undefined : storeIdFromValue(primaryRaw);
  if (primaryRaw !== undefined && primary === undefined) {
    throw unknownStore(EVER_JOBS_STORE_ENV_VAR, env[EVER_JOBS_STORE_ENV_VAR] ?? primaryRaw);
  }
  const alias = aliasRaw === undefined ? undefined : storeIdFromValue(aliasRaw);
  if (aliasRaw !== undefined && alias === undefined) {
    throw unknownStore(EVER_JOBS_STORE_PLUGIN_ENV_VAR, env[EVER_JOBS_STORE_PLUGIN_ENV_VAR] ?? aliasRaw);
  }

  if (primary !== undefined && alias !== undefined && primary !== alias) {
    throw new StoreConfigError(
      `${EVER_JOBS_STORE_ENV_VAR}=${JSON.stringify(primaryRaw)} (→ ${primary}) conflicts with ` +
        `${EVER_JOBS_STORE_PLUGIN_ENV_VAR}=${JSON.stringify(aliasRaw)} (→ ${alias}). ` +
        `Set only one of them.`,
      ERR_STORE_CONFLICT,
    );
  }

  if (primary !== undefined) {
    return { id: primary, explicit: true, source: EVER_JOBS_STORE_ENV_VAR, raw: primaryRaw };
  }
  if (alias !== undefined) {
    return { id: alias, explicit: true, source: EVER_JOBS_STORE_PLUGIN_ENV_VAR, raw: aliasRaw };
  }
  return { id: DEFAULT_STORE_ID, explicit: false, source: 'default' };
}

/** `true/1/yes/on` (any case) → true; any other non-blank value → false. */
function parseExplicitBool(raw: string): boolean {
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Should the interactive search path persist its results? (Spec 1722.)
 *
 * - `EVER_JOBS_PERSIST_SEARCH` set to a non-blank value → that value wins,
 *   for every backend (`true/1/yes/on` → on, anything else → off).
 * - Unset/blank → `true` only when a durable backend (`sqlite`/`postgres`)
 *   was **explicitly** selected; `false` for `memory`, which is also what
 *   an unconfigured deployment gets.
 *
 * Tolerant of an invalid selector (returns the memory default) so that the
 * single fail-fast for a bad `EVER_JOBS_STORE` stays in the bootstrap factory
 * with its full message, instead of surfacing first from the config loader.
 */
export function resolvePersistSearch(env: Env): boolean {
  const explicit = blankToUndefined(env[PERSIST_SEARCH_ENV_VAR]);
  if (explicit !== undefined) return parseExplicitBool(explicit);

  let selection: StoreSelection;
  try {
    selection = resolveStoreSelection(env);
  } catch {
    return false;
  }
  return selection.explicit && selection.id !== 'memory';
}

/**
 * The SQLite database path for `EVER_JOBS_STORE=sqlite`.
 * `:memory:` is accepted when written explicitly (useful for smoke tests).
 *
 * @throws {@link StoreConfigError} `ERR_STORE_CONFIG_MISSING`
 */
export function resolveSqlitePath(env: Env): string {
  const path =
    blankToUndefined(env[STORE_SQLITE_PATH_ENV_VAR]) ??
    blankToUndefined(env[LEGACY_SQLITE_PATH_ENV_VAR]);
  if (path === undefined) {
    throw new StoreConfigError(
      `${EVER_JOBS_STORE_ENV_VAR}=sqlite requires ${STORE_SQLITE_PATH_ENV_VAR} ` +
        `(a database file path, e.g. /var/lib/ever-jobs/jobs.db; ${LEGACY_SQLITE_PATH_ENV_VAR} is also read). ` +
        `Refusing to fall back to an in-memory database for a backend selected for durability.`,
      ERR_STORE_CONFIG_MISSING,
    );
  }
  return path;
}

/**
 * The Postgres connection URL for `EVER_JOBS_STORE=postgres`:
 * `EVER_JOBS_STORE_DATABASE_URL`, falling back to `DATABASE_URL`.
 *
 * @throws {@link StoreConfigError} `ERR_STORE_CONFIG_MISSING` / `ERR_STORE_CONFIG_INVALID`
 */
export function resolvePostgresUrl(env: Env): string {
  const url =
    blankToUndefined(env[STORE_DATABASE_URL_ENV_VAR]) ??
    blankToUndefined(env[DATABASE_URL_ENV_VAR]);
  if (url === undefined) {
    throw new StoreConfigError(
      `${EVER_JOBS_STORE_ENV_VAR}=postgres requires ${STORE_DATABASE_URL_ENV_VAR} ` +
        `(or ${DATABASE_URL_ENV_VAR}) = postgresql://USER:PASSWORD@HOST:5432/DATABASE. ` +
        `Create the schema once with \`npm run store:postgres:migrate\`.`,
      ERR_STORE_CONFIG_MISSING,
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new StoreConfigError(
      `${STORE_DATABASE_URL_ENV_VAR}/${DATABASE_URL_ENV_VAR} must be a postgres:// or postgresql:// URL ` +
        `(got a value starting with ${JSON.stringify(url.split(':')[0])}).`,
      ERR_STORE_CONFIG_INVALID,
    );
  }
  return url;
}

/**
 * Render a database URL for logs and errors without credentials or query
 * string: `postgresql://host:5432/db`. Never throws; an unparsable value
 * becomes `<unparsable database url>` rather than being echoed.
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`;
  } catch {
    return '<unparsable database url>';
  }
}

/** Re-exported so the bootstrap factory raises the same code Spec 004 defines. */
export { ERR_STORE_BACKEND_DOWN };
