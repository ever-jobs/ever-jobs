import { ValidationPipe } from '@nestjs/common';

/**
 * The global request-validation pipe installed by `main.ts`.
 *
 * One definition, so the tests that boot a real app run exactly the production pipe.
 *
 * `whitelist: true` strips every property that carries no class-validator decorator. That
 * applies to REST DTOs **and to GraphQL `@InputType` classes** (`@Args` goes through global
 * pipes too): a GraphQL input field without a class-validator decorator never reaches the
 * resolver, and any validation expressed only in the resolver silently never runs
 * (Spec 1730 review). Every field of an input class must therefore carry at least one
 * class-validator decorator (`@IsOptional()` alone is enough to keep it).
 */
export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: false,
  });
}
