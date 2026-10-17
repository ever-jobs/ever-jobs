/**
 * Spec 1689 — the Jest TypeScript transformer is selectable. `@swc/jest` is the
 * fast default (transpile-only); `JEST_TRANSFORMER=ts-jest` restores the
 * pre-fork-sync ts-jest config that type-checks specs as they run, and
 * `npm run test:typed` (scripts/jest-typed.ts) forces it.
 */

import * as path from 'path';
import type { Config } from 'jest';

import { applyTypedTransformer, TYPED_TRANSFORMER } from '../jest-typed';

const REPO_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'jest.config.js');
const TS_KEY = '^.+\\.tsx?$';
const UUID_KEY = '[/\\\\]node_modules[/\\\\]uuid[/\\\\].+\\.js$';
const PROXY_AGENTS_KEY =
  '[/\\\\]node_modules[/\\\\](https-proxy-agent|socks-proxy-agent|agent-base|proxy-agent-negotiate)[/\\\\].+\\.js$';
const NESTJS_KEY = '[/\\\\]node_modules[/\\\\](@nestjs|graphql-ws)[/\\\\].+\\.js$';

type TransformEntry = [string, Record<string, unknown>];

/** Evaluate jest.config.js afresh with `JEST_TRANSFORMER` set to `value`. */
function loadConfig(value: string | undefined): Config {
  const saved = process.env.JEST_TRANSFORMER;
  if (value === undefined) delete process.env.JEST_TRANSFORMER;
  else process.env.JEST_TRANSFORMER = value;
  try {
    let config: Config | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      config = require(CONFIG_PATH) as Config;
    });
    return config as Config;
  } finally {
    if (saved === undefined) delete process.env.JEST_TRANSFORMER;
    else process.env.JEST_TRANSFORMER = saved;
  }
}

function tsTransform(config: Config): TransformEntry {
  return (config.transform as Record<string, TransformEntry>)[TS_KEY];
}

describe('jest.config.js transformer switch (Spec 1689)', () => {
  it('defaults to @swc/jest with Nest-safe decorator settings and no preset', () => {
    const config = loadConfig(undefined);
    const [name, options] = tsTransform(config);
    expect(name).toBe('@swc/jest');
    expect(config.preset).toBeUndefined();
    const jsc = options.jsc as { transform: Record<string, unknown> };
    expect(jsc.transform).toMatchObject({
      legacyDecorator: true,
      decoratorMetadata: true,
      useDefineForClassFields: false,
    });
  });

  it('treats an empty value and an explicit "swc" as the default', () => {
    expect(tsTransform(loadConfig(''))[0]).toBe('@swc/jest');
    expect(tsTransform(loadConfig('swc'))[0]).toBe('@swc/jest');
  });

  it('JEST_TRANSFORMER=ts-jest restores the pre-fork-sync ts-jest transform + preset', () => {
    const config = loadConfig('ts-jest');
    expect(config.preset).toBe('ts-jest');
    expect(tsTransform(config)).toEqual(['ts-jest', { tsconfig: 'tsconfig.base.json' }]);
  });

  it('accepts the value case- and whitespace-insensitively', () => {
    expect(tsTransform(loadConfig(' TS-JEST '))[0]).toBe('ts-jest');
  });

  it('throws on an unknown value instead of silently falling back', () => {
    expect(() => loadConfig('babel')).toThrow(/Unknown JEST_TRANSFORMER "babel".*swc, ts-jest/);
  });

  it('changes nothing but the TypeScript transform between modes', () => {
    const swc = loadConfig(undefined);
    const typed = loadConfig('ts-jest');
    const uuid = ['ts-jest', { tsconfig: 'tsconfig.base.json', diagnostics: false }];
    expect((swc.transform as Record<string, unknown>)[UUID_KEY]).toEqual(uuid);
    expect((typed.transform as Record<string, unknown>)[UUID_KEY]).toEqual(uuid);
    expect((swc.transform as Record<string, unknown>)[PROXY_AGENTS_KEY]).toEqual(uuid);
    expect((typed.transform as Record<string, unknown>)[PROXY_AGENTS_KEY]).toEqual(uuid);
    expect((typed.transform as Record<string, unknown>)[NESTJS_KEY]).toEqual(
      (swc.transform as Record<string, unknown>)[NESTJS_KEY],
    );
    expect(typed.transformIgnorePatterns).toEqual(swc.transformIgnorePatterns);
    expect(typed.moduleNameMapper).toEqual(swc.moduleNameMapper);
    expect(typed.testMatch).toEqual(swc.testMatch);
    expect(typed.roots).toEqual(swc.roots);
    expect(typed.maxWorkers).toBe(swc.maxWorkers);
    expect(typed.testTimeout).toBe(swc.testTimeout);
  });

  // NestJS 12, uuid and the proxy agents ship ESM-only `.js`; Jest's loader
  // needs them compiled to CommonJS (still true on Node 26 with jest 30.5).
  it('compiles the ESM-only NestJS 12 packages to CommonJS with swc', () => {
    const [name, options] = (loadConfig(undefined).transform as Record<string, TransformEntry>)[NESTJS_KEY];
    expect(name).toBe('@swc/jest');
    expect(options).toMatchObject({
      jsc: { parser: { syntax: 'ecmascript' }, keepClassNames: true },
      module: { type: 'commonjs' },
    });
  });

  it('lets exactly the ESM-only packages through transformIgnorePatterns', () => {
    const patterns = (loadConfig(undefined).transformIgnorePatterns ?? []).map((p) => new RegExp(p));
    const ignored = (file: string) => patterns.some((re) => re.test(file));
    for (const file of [
      '/repo/node_modules/uuid/dist-node/index.js',
      '/repo/node_modules/@nestjs/common/index.js',
      '/repo/node_modules/@nestjs/graphql/node_modules/graphql-ws/dist/index.js',
      '/repo/node_modules/https-proxy-agent/dist/index.js',
      '/repo/node_modules/socks-proxy-agent/dist/index.js',
      '/repo/node_modules/agent-base/dist/index.js',
      '/repo/node_modules/proxy-agent-negotiate/dist/index.js',
      'C:\\repo\\node_modules\\@nestjs\\core\\index.js',
    ]) {
      expect([file, ignored(file)]).toEqual([file, false]);
    }
    for (const file of [
      '/repo/node_modules/express/index.js',
      // axios keeps its own CommonJS https-proxy-agent v5 / agent-base v6.
      '/repo/node_modules/axios/node_modules/https-proxy-agent/dist/index.js',
      '/repo/node_modules/axios/node_modules/agent-base/dist/index.js',
      '/repo/node_modules/@nestjs/graphql/node_modules/ws/index.js',
    ]) {
      expect([file, ignored(file)]).toEqual([file, true]);
    }
  });
});

describe('scripts/jest-typed.ts (npm run test:typed)', () => {
  it('forces ts-jest, even over an explicit swc in the caller env', () => {
    const env: NodeJS.ProcessEnv = { JEST_TRANSFORMER: 'swc', OTHER: 'kept' };
    applyTypedTransformer(env);
    expect(env).toEqual({ JEST_TRANSFORMER: TYPED_TRANSFORMER, OTHER: 'kept' });
    expect(TYPED_TRANSFORMER).toBe('ts-jest');
  });

  it('is what the test:typed script runs — through ts-node, not `node -e`', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(path.join(REPO_ROOT, 'package.json')) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts['test:typed'];
    expect(script).toMatch(/^ts-node .*scripts\/jest-typed\.ts$/);
    // `node -e` leaks into Jest's worker execArgv and re-runs the program in
    // every worker, breaking multi-file runs.
    expect(script).not.toMatch(/node\s+-e/);
  });
});
