import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ERR_STORE_BACKEND_DOWN, IJobStore, JOB_STORE_TOKEN } from '@ever-jobs/models';
import { StoreModule } from '@ever-jobs/plugin';
import { InMemoryJobStore } from '@ever-jobs/store-memory';
import { SqliteDrizzleJobStore } from '@ever-jobs/store-sqlite-drizzle';
import { PostgresPrismaJobStore } from '@ever-jobs/store-postgres-prisma';
import {
  ERR_STORE_CONFIG_MISSING,
  ERR_STORE_CONFLICT,
  StoreConfigError,
} from '../../config/store-config';
import {
  POSTGRES_STORE_CLIENT,
  PrismaClientCtor,
  connectPostgresStoreClient,
  resolveStoreBootstrap,
  resolveStoreProviders,
} from '../store-bootstrap.factory';

/**
 * Spec 1722 — every backend is functional from env alone, and fails fast with
 * a clear message when its required variable is missing.
 */

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

/** Structural stand-in for a generated PrismaClient. */
function fakePrismaCtor(behaviour: { connect?: () => Promise<void> } = {}) {
  const instances: Array<{ options: unknown; connected: boolean; disconnected: boolean }> = [];
  class FakePrismaClient {
    readonly state = { options: undefined as unknown, connected: false, disconnected: false };
    canonicalJob = {} as never;
    sourceObservation = {} as never;
    constructor(options: unknown) {
      this.state.options = options;
      instances.push(this.state);
    }
    async $connect(): Promise<void> {
      if (behaviour.connect) await behaviour.connect();
      this.state.connected = true;
    }
    async $disconnect(): Promise<void> {
      this.state.disconnected = true;
    }
    async $transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      return fn(this as never);
    }
  }
  return { ctor: FakePrismaClient as unknown as PrismaClientCtor, instances };
}

describe('resolveStoreBootstrap — Spec 1722 additions', () => {
  it('our deployment (no store, PERSIST=false) → memory, no persistence, no providers', () => {
    const env = { EVER_JOBS_PERSIST_SEARCH: 'false', NODE_ENV: 'production' };
    const boot = resolveStoreBootstrap(env);
    expect(boot).toMatchObject({ id: 'memory', explicit: false, persistSearch: false });
    expect(boot.backendClass).toBe(InMemoryJobStore);
    expect(resolveStoreProviders(boot.id, env)).toEqual([]);
  });

  it('accepts plugin package names', () => {
    expect(resolveStoreBootstrap({ EVER_JOBS_STORE: 'store-postgres-prisma' }).backendClass).toBe(
      PostgresPrismaJobStore,
    );
    expect(resolveStoreBootstrap({ EVER_JOBS_STORE_PLUGIN: 'store-sqlite-drizzle' }).backendClass).toBe(
      SqliteDrizzleJobStore,
    );
  });

  it('postgres selected → persistSearch defaults to true; explicit false wins', () => {
    expect(resolveStoreBootstrap({ EVER_JOBS_STORE: 'postgres' }).persistSearch).toBe(true);
    expect(
      resolveStoreBootstrap({ EVER_JOBS_STORE: 'postgres', EVER_JOBS_PERSIST_SEARCH: 'false' }).persistSearch,
    ).toBe(false);
  });

  it('conflicting selectors fail fast', () => {
    const fn = () => resolveStoreBootstrap({ EVER_JOBS_STORE: 'sqlite', EVER_JOBS_STORE_PLUGIN: 'postgres' });
    expect(fn).toThrow(StoreConfigError);
    expect(codeOf(fn)).toBe(ERR_STORE_CONFLICT);
  });

  describe('production warning', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    it('is silent for memory when nothing persists (the default now)', () => {
      resolveStoreBootstrap({ NODE_ENV: 'production' });
      resolveStoreBootstrap({ NODE_ENV: 'production', EVER_JOBS_PERSIST_SEARCH: 'false' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('fires when persistence into memory is switched on in production', () => {
      resolveStoreBootstrap({ NODE_ENV: 'production', EVER_JOBS_PERSIST_SEARCH: 'true' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('in-memory backend'));
    });
  });
});

describe('resolveStoreProviders — sqlite (Spec 1722)', () => {
  it('missing EVER_JOBS_STORE_SQLITE_PATH fails fast (no silent :memory:)', () => {
    const fn = () => resolveStoreProviders('sqlite', {});
    expect(codeOf(fn)).toBe(ERR_STORE_CONFIG_MISSING);
  });

  it('boots a file-backed SQLite store from env alone, creating the directory', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMP ?? os.tmpdir(), 'ej-sqlite-'));
    const dbPath = path.join(dir, 'nested', 'jobs.db');
    try {
      const env = { EVER_JOBS_STORE: 'sqlite', EVER_JOBS_STORE_SQLITE_PATH: dbPath };
      const boot = resolveStoreBootstrap(env);
      const moduleRef = await Test.createTestingModule({
        imports: [
          StoreModule.forActive(boot.id, {
            backends: [boot.backendClass],
            providers: resolveStoreProviders(boot.id, env),
          }),
        ],
      }).compile();
      const store = moduleRef.get<IJobStore>(JOB_STORE_TOKEN);
      expect(store).toBeInstanceOf(SqliteDrizzleJobStore);
      await store.upsert({
        canonicalJobId: 'k1',
        title: 'engineer',
        company: 'acme',
        location: 'austin',
        url: 'https://example.com/1',
        mergedAt: '2026-09-24T00:00:00.000Z',
        fields: {},
        sources: [],
      });
      expect((await store.getById('k1'))?.company).toBe('acme');
      expect(fs.existsSync(dbPath)).toBe(true);
      (store as unknown as { client: { close(): void } }).client.close();
      await moduleRef.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveStoreProviders — postgres (Spec 1722)', () => {
  it('missing URL fails fast at resolve time, before Nest builds anything', () => {
    const fn = () => resolveStoreProviders('postgres', {});
    expect(codeOf(fn)).toBe(ERR_STORE_CONFIG_MISSING);
    expect(() => resolveStoreProviders('postgres', {})).toThrow(/EVER_JOBS_STORE_DATABASE_URL/);
  });

  it('wires a connected client into PostgresPrismaJobStore and disconnects on close', async () => {
    const { ctor, instances } = fakePrismaCtor();
    const url = 'postgresql://ever:pw@db.example:5432/jobs';
    const moduleRef = await Test.createTestingModule({
      imports: [
        StoreModule.forActive('postgres', {
          backends: [PostgresPrismaJobStore],
          providers: resolveStoreProviders(
            'postgres',
            { EVER_JOBS_STORE_DATABASE_URL: url, DATABASE_URL: 'postgresql://ignored/x' },
            { loadPrismaClient: () => ctor },
          ),
        }),
      ],
    }).compile();

    expect(moduleRef.get(JOB_STORE_TOKEN)).toBeInstanceOf(PostgresPrismaJobStore);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.options).toEqual({ datasourceUrl: url });
    expect(instances[0]!.connected).toBe(true);
    expect(moduleRef.get(POSTGRES_STORE_CLIENT)).toBeDefined();

    await moduleRef.close();
    expect(instances[0]!.disconnected).toBe(true);
  });

  it('falls back to DATABASE_URL', async () => {
    const { ctor, instances } = fakePrismaCtor();
    const moduleRef = await Test.createTestingModule({
      imports: [
        StoreModule.forActive('postgres', {
          backends: [PostgresPrismaJobStore],
          providers: resolveStoreProviders(
            'postgres',
            { DATABASE_URL: 'postgresql://u@h/db' },
            { loadPrismaClient: () => ctor },
          ),
        }),
      ],
    }).compile();
    expect(instances[0]!.options).toEqual({ datasourceUrl: 'postgresql://u@h/db' });
    await moduleRef.close();
  });

  it('an unreachable database fails the boot with ERR_STORE_BACKEND_DOWN and no password', async () => {
    const { ctor, instances } = fakePrismaCtor({
      connect: async () => {
        throw new Error("Can't reach database server using postgresql://ever:topsecret@db:5432/jobs (pw topsecret)");
      },
    });
    const url = 'postgresql://ever:topsecret@db:5432/jobs';
    let caught: unknown;
    try {
      await connectPostgresStoreClient(url, () => ctor);
    } catch (err) {
      caught = err;
    }
    expect((caught as StoreConfigError).code).toBe(ERR_STORE_BACKEND_DOWN);
    const message = (caught as Error).message;
    expect(message).toContain('postgresql://db:5432/jobs');
    expect(message).not.toContain('topsecret');
    expect(instances[0]!.disconnected).toBe(true);
  });

  it('a client that was never generated fails with the generate hint', async () => {
    const notGenerated = class {
      constructor() {
        throw new Error('@prisma/client did not initialize yet. Please run "prisma generate"');
      }
    } as unknown as PrismaClientCtor;
    await expect(connectPostgresStoreClient('postgresql://h/db', () => notGenerated)).rejects.toThrow(
      /store:postgres:generate/,
    );
  });
});
