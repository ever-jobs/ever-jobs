import { ERR_STORE_NOT_FOUND } from '@ever-jobs/models';
import {
  ERR_STORE_CONFIG_INVALID,
  ERR_STORE_CONFIG_MISSING,
  ERR_STORE_CONFLICT,
  StoreConfigError,
  redactDatabaseUrl,
  resolvePersistSearch,
  resolvePostgresUrl,
  resolveSqlitePath,
  resolveStoreSelection,
  storeIdFromValue,
} from '../store-config';
import configuration from '../configuration';

/**
 * Spec 1722 (contract C6) — the storage matrix.
 */

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return '';
}

describe('store selection (Spec 1722)', () => {
  it('nothing set → memory, not explicit', () => {
    expect(resolveStoreSelection({})).toEqual({ id: 'memory', explicit: false, source: 'default' });
  });

  it.each([
    ['memory', 'memory'],
    ['in-memory', 'memory'],
    ['store-memory', 'memory'],
    ['@ever-jobs/store-memory', 'memory'],
    ['sqlite', 'sqlite'],
    ['sqlite-drizzle', 'sqlite'],
    ['store-sqlite-drizzle', 'sqlite'],
    ['postgres', 'postgres'],
    ['postgresql', 'postgres'],
    ['postgres-prisma', 'postgres'],
    ['store-postgres-prisma', 'postgres'],
    ['@ever-jobs/store-postgres-prisma', 'postgres'],
    ['  postgres  ', 'postgres'],
  ])('EVER_JOBS_STORE=%j → %s', (value, id) => {
    expect(storeIdFromValue(value)).toBe(id);
    expect(resolveStoreSelection({ EVER_JOBS_STORE: value })).toMatchObject({
      id,
      explicit: true,
      source: 'EVER_JOBS_STORE',
    });
  });

  it('keeps Spec 004 case-sensitivity: POSTGRES is not a known id', () => {
    expect(codeOf(() => resolveStoreSelection({ EVER_JOBS_STORE: 'POSTGRES' }))).toBe(ERR_STORE_NOT_FOUND);
  });

  it('unknown value → ERR_STORE_NOT_FOUND naming the ids and the aliases', () => {
    const msg = messageOf(() => resolveStoreSelection({ EVER_JOBS_STORE: 'mongo' }));
    expect(codeOf(() => resolveStoreSelection({ EVER_JOBS_STORE: 'mongo' }))).toBe(ERR_STORE_NOT_FOUND);
    for (const s of ['memory', 'sqlite', 'postgres', 'store-postgres-prisma', 'mongo']) expect(msg).toContain(s);
  });

  it('EVER_JOBS_STORE_PLUGIN is read when EVER_JOBS_STORE is unset or blank', () => {
    expect(resolveStoreSelection({ EVER_JOBS_STORE_PLUGIN: 'store-postgres-prisma' })).toMatchObject({
      id: 'postgres',
      explicit: true,
      source: 'EVER_JOBS_STORE_PLUGIN',
    });
    expect(
      resolveStoreSelection({ EVER_JOBS_STORE: '  ', EVER_JOBS_STORE_PLUGIN: 'store-sqlite-drizzle' }),
    ).toMatchObject({ id: 'sqlite', source: 'EVER_JOBS_STORE_PLUGIN' });
  });

  it('both selectors agreeing is fine; disagreeing fails fast with ERR_STORE_CONFLICT', () => {
    expect(
      resolveStoreSelection({ EVER_JOBS_STORE: 'postgres', EVER_JOBS_STORE_PLUGIN: 'store-postgres-prisma' }).id,
    ).toBe('postgres');
    const conflict = () =>
      resolveStoreSelection({ EVER_JOBS_STORE: 'postgres', EVER_JOBS_STORE_PLUGIN: 'store-memory' });
    expect(codeOf(conflict)).toBe(ERR_STORE_CONFLICT);
    expect(messageOf(conflict)).toMatch(/EVER_JOBS_STORE.*EVER_JOBS_STORE_PLUGIN/);
  });

  it('an unknown EVER_JOBS_STORE_PLUGIN value also fails fast', () => {
    expect(codeOf(() => resolveStoreSelection({ EVER_JOBS_STORE_PLUGIN: 'redis' }))).toBe(ERR_STORE_NOT_FOUND);
  });
});

describe('EVER_JOBS_PERSIST_SEARCH default (Spec 1722 matrix)', () => {
  it.each([
    // [label, env, expected]
    ['nothing set → memory, persistence OFF (new default)', {}, false],
    ['our deployment: PERSIST=false, no store', { EVER_JOBS_PERSIST_SEARCH: 'false' }, false],
    ['memory + PERSIST=true → ON', { EVER_JOBS_PERSIST_SEARCH: 'true' }, true],
    ['explicit memory, persist unset → OFF', { EVER_JOBS_STORE: 'memory' }, false],
    ['postgres selected, persist unset → ON', { EVER_JOBS_STORE: 'postgres' }, true],
    ['postgres via package name → ON', { EVER_JOBS_STORE: 'store-postgres-prisma' }, true],
    ['postgres via EVER_JOBS_STORE_PLUGIN → ON', { EVER_JOBS_STORE_PLUGIN: 'store-postgres-prisma' }, true],
    ['sqlite selected, persist unset → ON', { EVER_JOBS_STORE: 'sqlite' }, true],
    ['postgres + explicit false wins → OFF', { EVER_JOBS_STORE: 'postgres', EVER_JOBS_PERSIST_SEARCH: 'false' }, false],
    ['postgres + explicit 0 wins → OFF', { EVER_JOBS_STORE: 'postgres', EVER_JOBS_PERSIST_SEARCH: '0' }, false],
    ['postgres + blank persist → default ON', { EVER_JOBS_STORE: 'postgres', EVER_JOBS_PERSIST_SEARCH: ' ' }, true],
    ['PERSIST=on → ON', { EVER_JOBS_PERSIST_SEARCH: 'on' }, true],
    ['PERSIST=YES → ON', { EVER_JOBS_PERSIST_SEARCH: 'YES' }, true],
    ['PERSIST=garbage → OFF', { EVER_JOBS_PERSIST_SEARCH: 'garbage' }, false],
    ['invalid store → OFF here (the bootstrap fails fast instead)', { EVER_JOBS_STORE: 'mongo' }, false],
  ] as Array<[string, Record<string, string>, boolean]>)('%s', (_label, env, expected) => {
    expect(resolvePersistSearch(env)).toBe(expected);
  });

  describe('through configuration()', () => {
    const keys = ['EVER_JOBS_STORE', 'EVER_JOBS_STORE_PLUGIN', 'EVER_JOBS_PERSIST_SEARCH'];
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const k of keys) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    });
    afterEach(() => {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it('our deployment (PERSIST=false, no store) → store.persistSearch=false', () => {
      process.env.EVER_JOBS_PERSIST_SEARCH = 'false';
      expect(configuration().store.persistSearch).toBe(false);
    });

    it('unconfigured → false; postgres selected → true', () => {
      expect(configuration().store.persistSearch).toBe(false);
      process.env.EVER_JOBS_STORE = 'postgres';
      expect(configuration().store.persistSearch).toBe(true);
    });
  });
});

describe('backend config resolvers (Spec 1722)', () => {
  it('sqlite: EVER_JOBS_STORE_SQLITE_PATH, then the legacy EVER_JOBS_SQLITE_PATH', () => {
    expect(resolveSqlitePath({ EVER_JOBS_STORE_SQLITE_PATH: '/data/jobs.db' })).toBe('/data/jobs.db');
    expect(resolveSqlitePath({ EVER_JOBS_SQLITE_PATH: '/legacy.db' })).toBe('/legacy.db');
    expect(
      resolveSqlitePath({ EVER_JOBS_STORE_SQLITE_PATH: '/new.db', EVER_JOBS_SQLITE_PATH: '/legacy.db' }),
    ).toBe('/new.db');
    expect(resolveSqlitePath({ EVER_JOBS_STORE_SQLITE_PATH: ':memory:' })).toBe(':memory:');
  });

  it('sqlite: missing path fails fast naming the variable', () => {
    const fn = () => resolveSqlitePath({});
    expect(codeOf(fn)).toBe(ERR_STORE_CONFIG_MISSING);
    expect(messageOf(fn)).toContain('EVER_JOBS_STORE_SQLITE_PATH');
  });

  it('postgres: EVER_JOBS_STORE_DATABASE_URL wins, DATABASE_URL is the fallback', () => {
    expect(
      resolvePostgresUrl({
        EVER_JOBS_STORE_DATABASE_URL: 'postgresql://a@h1/db1',
        DATABASE_URL: 'postgresql://b@h2/db2',
      }),
    ).toBe('postgresql://a@h1/db1');
    expect(resolvePostgresUrl({ DATABASE_URL: 'postgres://b@h2/db2' })).toBe('postgres://b@h2/db2');
  });

  it('postgres: a missing URL fails fast with a clear message naming both variables', () => {
    const fn = () => resolvePostgresUrl({ EVER_JOBS_STORE_DATABASE_URL: '  ' });
    expect(codeOf(fn)).toBe(ERR_STORE_CONFIG_MISSING);
    const msg = messageOf(fn);
    expect(msg).toContain('EVER_JOBS_STORE_DATABASE_URL');
    expect(msg).toContain('DATABASE_URL');
    expect(msg).toContain('store:postgres:migrate');
  });

  it('postgres: a non-postgres URL is ERR_STORE_CONFIG_INVALID and the value is not echoed', () => {
    const fn = () => resolvePostgresUrl({ DATABASE_URL: 'mysql://root:hunter2@db/x' });
    expect(codeOf(fn)).toBe(ERR_STORE_CONFIG_INVALID);
    expect(messageOf(fn)).not.toContain('hunter2');
  });

  it('errors are StoreConfigError instances', () => {
    expect(() => resolveSqlitePath({})).toThrow(StoreConfigError);
  });
});

describe('redactDatabaseUrl', () => {
  it('drops user, password and query', () => {
    expect(redactDatabaseUrl('postgresql://ever:s3cr3t@db.internal:5432/jobs?sslmode=require')).toBe(
      'postgresql://db.internal:5432/jobs',
    );
  });

  it('never echoes an unparsable value', () => {
    expect(redactDatabaseUrl('not a url with password=abc')).toBe('<unparsable database url>');
  });
});
