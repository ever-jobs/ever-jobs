/**
 * Shared test helper — bootstraps the full NestJS application for E2E tests.
 *
 * Uses AppModule (not JobsModule) so all guards, interceptors, filters,
 * and config are active. Mirrors main.ts by applying ValidationPipe.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { createGlobalValidationPipe } from '../../src/pipes/global-validation.pipe';

export async function createTestApp(): Promise<INestApplication> {
  const module: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = module.createNestApplication();

  app.useGlobalPipes(createGlobalValidationPipe());

  await app.init();
  return app;
}
