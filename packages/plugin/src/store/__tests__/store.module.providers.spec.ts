import 'reflect-metadata';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CanonicalJob,
  IJobStore,
  JOB_STORE_TOKEN,
  JobStorePage,
} from '@ever-jobs/models';
import { StorePlugin } from '../store-plugin.decorator';
import { StoreModule } from '../store.module';

/**
 * Spec 1722 — `StoreModule.forActive({ providers })`.
 *
 * A backend's config token must resolve inside the store module's own scope;
 * before this option there was no way to bind one from outside, which is why
 * `EVER_JOBS_STORE=postgres` could not boot without editing the app module.
 */

const FAKE_CONFIG = 'FAKE_STORE_CONFIG';

@StorePlugin({ id: 'configured', description: 'needs a config token' })
@Injectable()
class ConfiguredStore implements IJobStore {
  constructor(@Optional() @Inject(FAKE_CONFIG) readonly config?: { dsn: string }) {
    if (!config) throw new Error('ConfiguredStore: FAKE_STORE_CONFIG is not bound');
  }
  async upsert(job: CanonicalJob): Promise<CanonicalJob> {
    return job;
  }
  async upsertMany(): Promise<{ inserted: number; updated: number }> {
    return { inserted: 0, updated: 0 };
  }
  async getById(): Promise<CanonicalJob | null> {
    return null;
  }
  async findByCanonicalId(): Promise<CanonicalJob | null> {
    return null;
  }
  async listByQuery(): Promise<JobStorePage<CanonicalJob>> {
    return { items: [] };
  }
  async delete(): Promise<boolean> {
    return false;
  }
}

describe('StoreModule.forActive — providers option (Spec 1722)', () => {
  it('makes a config token visible to the backend it constructs', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StoreModule.forActive('configured', {
          backends: [ConfiguredStore],
          providers: [{ provide: FAKE_CONFIG, useValue: { dsn: 'x://y' } }],
        }),
      ],
    }).compile();

    const store = moduleRef.get<ConfiguredStore>(JOB_STORE_TOKEN);
    expect(store).toBeInstanceOf(ConfiguredStore);
    expect(store.config).toEqual({ dsn: 'x://y' });
    await moduleRef.close();
  });

  it('supports async factory providers (a connected client)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StoreModule.forActive('configured', {
          backends: [ConfiguredStore],
          providers: [
            {
              provide: FAKE_CONFIG,
              useFactory: async () => {
                await new Promise((resolve) => setImmediate(resolve));
                return { dsn: 'async://ok' };
              },
            },
          ],
        }),
      ],
    }).compile();

    expect(moduleRef.get<ConfiguredStore>(JOB_STORE_TOKEN).config).toEqual({ dsn: 'async://ok' });
    await moduleRef.close();
  });

  it('without the option the backend cannot see a config token (the pre-1722 failure)', async () => {
    await expect(
      Test.createTestingModule({
        imports: [StoreModule.forActive('configured', { backends: [ConfiguredStore] })],
        providers: [{ provide: FAKE_CONFIG, useValue: { dsn: 'root-module' } }],
      }).compile(),
    ).rejects.toThrow(/FAKE_STORE_CONFIG is not bound/);
  });
});
