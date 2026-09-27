/**
 * Spec 1722 — schema tooling for the Postgres store (`store-postgres-prisma`).
 *
 *   npm run store:postgres:generate   # prisma generate  → @prisma/client for this schema
 *   npm run store:postgres:migrate    # prisma migrate deploy → creates/updates the tables
 *   npm run store:postgres:status     # prisma migrate status
 *
 * `migrate` and `status` read the SAME variables the API reads —
 * `EVER_JOBS_STORE_DATABASE_URL`, falling back to `DATABASE_URL` — and hand the
 * value to Prisma as `DATABASE_URL` (what `prisma/schema.prisma` declares), so a
 * forker never has to set the URL twice. The URL is never printed; only
 * `postgresql://host:port/db`.
 *
 * The migration (`prisma/migrations/0_init/migration.sql`) runs
 * `CREATE EXTENSION IF NOT EXISTS "pg_trgm"`, so the migrating role needs the
 * privilege to create that extension (or a DBA creates it once beforehand).
 *
 * Dev tooling only — never required at runtime (AGENTS.md §3).
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import { redactDatabaseUrl, resolvePostgresUrl } from '../apps/api/src/config/store-config';

const SCHEMA = path.resolve(__dirname, '../packages/plugins/store-postgres-prisma/prisma/schema.prisma');

type Command = 'generate' | 'migrate' | 'status';

const PRISMA_ARGS: Record<Command, string[]> = {
  generate: ['generate', '--schema', SCHEMA],
  migrate: ['migrate', 'deploy', '--schema', SCHEMA],
  status: ['migrate', 'status', '--schema', SCHEMA],
};

function prismaCli(): string {
  try {
    return require.resolve('prisma/build/index.js');
  } catch {
    throw new Error('The `prisma` CLI is not installed. Run `npm ci` first (it is a devDependency).');
  }
}

export function buildPrismaEnv(
  command: Command,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, CHECKPOINT_DISABLE: env.CHECKPOINT_DISABLE ?? '1' };
  if (command === 'generate') {
    // `prisma generate` validates the schema's env("DATABASE_URL") reference
    // but never connects; a placeholder keeps it runnable in CI/Docker builds
    // that have no database.
    out.DATABASE_URL = env.DATABASE_URL ?? 'postgresql://placeholder@localhost:5432/placeholder';
    return out;
  }
  out.DATABASE_URL = resolvePostgresUrl(env);
  return out;
}

function main(argv: string[]): number {
  const command = argv[0] as Command | undefined;
  if (!command || !(command in PRISMA_ARGS)) {
    process.stderr.write('usage: ts-node scripts/store-postgres.ts <generate|migrate|status>\n');
    return 2;
  }
  let env: NodeJS.ProcessEnv;
  try {
    env = buildPrismaEnv(command, process.env);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (command !== 'generate') {
    process.stdout.write(`store-postgres: ${command} against ${redactDatabaseUrl(env.DATABASE_URL!)}\n`);
  }
  const result = spawnSync(process.execPath, [prismaCli(), ...PRISMA_ARGS[command]], {
    stdio: 'inherit',
    env,
  });
  return result.status ?? 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
