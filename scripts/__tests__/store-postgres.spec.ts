import { buildPrismaEnv } from '../store-postgres';

/**
 * Spec 1722 — the schema script reads the same URL variables as the API and
 * hands Prisma a `DATABASE_URL`.
 */
describe('scripts/store-postgres buildPrismaEnv (Spec 1722)', () => {
  it('migrate uses EVER_JOBS_STORE_DATABASE_URL as DATABASE_URL', () => {
    const env = buildPrismaEnv('migrate', {
      EVER_JOBS_STORE_DATABASE_URL: 'postgresql://u:p@h:5432/store',
      DATABASE_URL: 'postgresql://other/db',
    });
    expect(env.DATABASE_URL).toBe('postgresql://u:p@h:5432/store');
    expect(env.CHECKPOINT_DISABLE).toBe('1');
  });

  it('migrate falls back to DATABASE_URL', () => {
    expect(buildPrismaEnv('status', { DATABASE_URL: 'postgres://h/db' }).DATABASE_URL).toBe('postgres://h/db');
  });

  it('migrate without any URL fails with the variable names', () => {
    expect(() => buildPrismaEnv('migrate', {})).toThrow(/EVER_JOBS_STORE_DATABASE_URL/);
  });

  it('generate needs no database and gets a placeholder URL', () => {
    expect(buildPrismaEnv('generate', {}).DATABASE_URL).toMatch(/^postgresql:\/\/placeholder@/);
  });
});
