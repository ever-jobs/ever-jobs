/**
 * Barrel for `@ever-jobs/store-postgres-prisma` (Spec 004 / Phase 4 /
 * T09–T10). Re-exports the public surface so consumers don't need to
 * reach into per-file paths.
 */
export {
  PostgresPrismaJobStore,
  STORE_POSTGRES_PRISMA_ID,
  STORE_POSTGRES_PRISMA_DESCRIPTION,
  STORE_POSTGRES_PRISMA_CONFIG,
  DEFAULT_POSTGRES_BATCH_SIZE,
  UPSERT_CANONICAL_CHUNK_SQL,
  REPLACE_OBSERVATIONS_CHUNK_SQL,
} from './store-postgres-prisma.service';
export type {
  PrismaJobsClient,
  StorePostgresPrismaConfig,
} from './store-postgres-prisma.service';
export { StorePostgresPrismaModule } from './store-postgres-prisma.module';
