import { Module } from '@nestjs/common';
import { ApponeService } from './appone.service';

/**
 * Spec 5036 — `ApponeModule`.
 *
 * Bundles `ApponeService` as a NestJS provider so `JobsModule` (via
 * `ALL_SOURCE_MODULES`) can fan out to the AppOne JSON REST API.
 */
@Module({
  providers: [ApponeService],
  exports: [ApponeService],
})
export class ApponeModule {}
