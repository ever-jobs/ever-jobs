/**
 * `npm run test:typed` — Jest with the ts-jest transformer (Spec 1689).
 *
 * The default transformer is @swc/jest, which only transpiles: a spec with a
 * type error still runs (and can pass). This entry point forces
 * `JEST_TRANSFORMER=ts-jest` — see the top of `jest.config.js` — so every spec
 * is type-checked as it runs, which is how `npm test` behaved before the fork
 * sync switched to swc. Any Jest CLI arguments pass straight through:
 *
 *   npm run test:typed -- --testPathPatterns packages/models/
 *
 * Why a script and not `node -e "…"`: Jest starts its workers with the parent's
 * `process.execArgv`, so an inline `-e` program re-ran inside every worker and
 * broke any multi-file run. `cross-env` is not a dependency, and a bare
 * `JEST_TRANSFORMER=ts-jest jest` does not work under cmd.exe.
 */

import { run } from 'jest';

export const TYPED_TRANSFORMER = 'ts-jest';

/**
 * Point `env` at the ts-jest transformer. Forced, not defaulted: a stray
 * `JEST_TRANSFORMER=swc` in the caller's shell must not turn a "typed" run
 * back into a transpile-only one.
 */
export function applyTypedTransformer(env: NodeJS.ProcessEnv): void {
  env.JEST_TRANSFORMER = TYPED_TRANSFORMER;
}

// CLI entry — CJS/ESM-tolerant, same detection as `scripts/docs-lint.ts`.
function isCliEntry(): boolean {
  try {
    if (typeof require !== 'undefined' && require.main === module) {
      return true;
    }
  } catch {
    /* not running in CJS — fall through */
  }
  const entry = process.argv[1] ?? '';
  return entry.endsWith('jest-typed.ts') || entry.endsWith('jest-typed.js');
}

if (isCliEntry()) {
  applyTypedTransformer(process.env);
  run(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`test:typed failed: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
