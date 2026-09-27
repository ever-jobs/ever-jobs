/**
 * Spec 1689 — guards on `.github/workflows/ci.yml` and the `test:core` script.
 *
 * - Jest worker counts come from repo variables sized to the ARC runners'
 *   cgroup CPU limit, never from a `%` (jest resolves that against the HOST's
 *   CPUs, so `75%` meant ~27 workers on a 6-CPU pod).
 * - The blocking `Test (Core)` job exists and runs `npm run test:core`.
 * - `test:core` covers EVERY non-e2e spec under apps/ and the core packages.
 *   The set is derived from the filesystem, not a hand list, so a new spec
 *   directory cannot silently fall outside CI again.
 *
 * String-level parsing on purpose: no YAML parser is a declared dependency.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..');
const CI_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const ciText = fs.readFileSync(CI_PATH, 'utf8');
// Comments may quote the old flags when explaining a change; only live YAML counts.
const ciConfigOnly = ciText
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require(path.join(REPO_ROOT, 'package.json')) as {
  scripts: Record<string, string>;
};

/** Top-level job blocks under `jobs:`, keyed by job id. */
function jobBlocks(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const blocks = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) blocks.set(current, body.join('\n'));
      current = header[1];
      body = [];
    } else if (current) {
      body.push(line);
    }
  }
  if (current) blocks.set(current, body.join('\n'));
  return blocks;
}

/** The job's steps up to and including `npm ci`, comments stripped. */
function setupSteps(block: string): string {
  const cut = block.indexOf('run: npm ci');
  return block
    .slice(block.indexOf('steps:'), cut + 'run: npm ci'.length)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

const jobs = jobBlocks(ciText);

describe('ci.yml jest sizing (Spec 1689)', () => {
  it('never sizes jest workers as a percentage of host CPUs', () => {
    expect(ciConfigOnly).toContain('--maxWorkers='); // control: the flag is in use
    expect(ciConfigOnly).not.toMatch(/--maxWorkers=\d+%/);
  });

  it('source unit shards take workers and runner from repo variables', () => {
    const block = jobs.get('test-sources') ?? '';
    expect(block).toContain(
      "runs-on: ${{ vars.RUNNER_SOURCE_UNIT || vars.RUNNER_LINUX_X64_8 || 'ubuntu-latest' }}",
    );
    expect(block).toContain(
      "--maxWorkers=${{ vars.JEST_SOURCE_UNIT_MAX_WORKERS || '5' }}",
    );
    // The Verdaccio VIP is expected exactly when a self-hosted runner is used.
    expect(block).toContain(
      "expect-vip: ${{ (vars.RUNNER_SOURCE_UNIT || vars.RUNNER_LINUX_X64_8) != '' }}",
    );
  });
});

describe('ci.yml Test (Core) job (Spec 1689)', () => {
  const core = jobs.get('test-core') ?? '';

  it('exists, needs build and is blocking', () => {
    expect(core).toContain('name: Test (Core)');
    expect(core).toMatch(/^ {4}needs: build\s*$/m);
    expect(core).not.toContain('continue-on-error');
  });

  it('runs the test:core script with a variable-sized worker pool', () => {
    expect(core).toContain(
      "run: npm run test:core -- --maxWorkers=${{ vars.JEST_CORE_MAX_WORKERS || '3' }}",
    );
  });

  it('uses the same checkout / node / registry / install steps as the other test jobs', () => {
    expect(setupSteps(core)).toBe(setupSteps(jobs.get('test-fast') ?? ''));
    expect(setupSteps(core)).toBe(
      setupSteps(jobs.get('test-feature-plugins') ?? ''),
    );
  });

  it('receives no secrets beyond the registry token', () => {
    const secrets = core.match(/secrets\.[A-Z_]+/g) ?? [];
    expect([...new Set(secrets)]).toEqual(['secrets.VERDACCIO_TOKEN']);
  });
});

describe('test:core coverage (Spec 1689)', () => {
  const script = pkg.scripts['test:core'];
  const pattern = /--testPathPatterns "([^"]+)"/.exec(script)?.[1] ?? '';
  const include = new RegExp(pattern);

  it('excludes e2e specs', () => {
    expect(script).toMatch(/--testPathIgnorePatterns e2e-spec(\s|$)/);
  });

  it.each([
    'packages/common/__tests__/helpers.spec.ts',
    'packages/common/src/browser/__tests__/browser-pool.spec.ts',
    'packages/plugin/__tests__/disabled-sources.spec.ts',
    'packages/models/__tests__/scrape-diagnostics.spec.ts',
    'packages/analytics/__tests__/analytics.spec.ts',
    'apps/api/src/jobs/__tests__/jobs.service.spec.ts',
    'apps/api/__tests__/jobs/corpus-signals.spec.ts',
    'apps/api/__tests__/integration/source-ats-batch-1.integration.spec.ts',
    'apps/mcp/__tests__/tools.spec.ts',
    'apps/cli/__tests__/search-filters.command.spec.ts',
    'apps/cli/__tests__/crawl-options.spec.ts',
  ])('includes %s', (file) => {
    expect(include.test(file)).toBe(true);
  });

  it.each([
    'packages/plugins/source-ats-gem/__tests__/gem.service.spec.ts',
    'packages/plugins/dedup-hybrid/__tests__/dedup-perf.spec.ts',
    'apps/api/__tests__/search.e2e-spec.ts',
    'apps/api/__tests__/e2e/source-ats-batch-1.e2e-spec.ts',
    'apps/cli/__tests__/search.e2e-spec.ts',
    'scripts/__tests__/docs-lint.spec.ts',
  ])('leaves %s to its own job', (file) => {
    const ignored = file.includes('e2e-spec');
    expect(include.test(file) && !ignored).toBe(false);
  });

  it('covers every non-e2e spec under apps/ and the core packages', () => {
    const roots = [
      'apps',
      'packages/common',
      'packages/plugin',
      'packages/models',
      'packages/analytics',
    ];
    const specs: string[] = [];
    const walk = (rel: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(child);
        else if (
          e.isFile() &&
          e.name.endsWith('.spec.ts') &&
          !e.name.includes('e2e-spec') &&
          child.includes('/__tests__/')
        ) {
          specs.push(child);
        }
      }
    };
    roots.forEach(walk);

    // Control: the walk must actually find the suites (an empty list would
    // make the assertion below pass vacuously).
    expect(specs.length).toBeGreaterThanOrEqual(40);
    expect(specs).toContain('apps/api/__tests__/jobs/corpus-signals.spec.ts');
    expect(specs.filter((s) => !include.test(s))).toEqual([]);
  });
});

describe('ci.yml live Softy e2e gate (Spec 1715 FR-19)', () => {
  const LIVE_ENV =
    "EVER_JOBS_LIVE_SOFTY: ${{ (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && '1' || vars.EVER_JOBS_LIVE_SOFTY || '0' }}";
  const onBlock = (() => {
    const lines = ciConfigOnly.split('\n');
    const start = lines.findIndex((l) => /^on:\s*$/.test(l));
    const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
    return lines.slice(start + 1, end).join('\n');
  })();
  const e2e = jobs.get('test-source-e2e') ?? '';

  it('keeps the push / pull_request triggers and adds a weekly schedule plus a manual dispatch', () => {
    expect(onBlock).toMatch(/^ {2}push:\n {4}branches: \[main, develop\]$/m);
    expect(onBlock).toMatch(/^ {2}pull_request:\n {4}branches: \[main, develop\]$/m);
    expect(onBlock).toMatch(/^ {2}workflow_dispatch:\s*$/m);
    expect(onBlock).toMatch(/^ {2}schedule:\n {4}- cron: '23 4 \* \* 1'$/m);
  });

  it('passes EVER_JOBS_LIVE_SOFTY to the source e2e step: 1 on schedule / dispatch, else the repo variable, else 0', () => {
    const step = e2e.slice(e2e.indexOf('- name: Run source scraper e2e tests'));
    expect(step).toContain(LIVE_ENV);
    expect(step).toContain('EXA_API_KEY: ${{ secrets.EXA_API_KEY }}');
  });

  it('writes a notice naming the skip reason before the e2e step', () => {
    const gate = e2e.indexOf('- name: Live Softy e2e gate');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(e2e.indexOf('- name: Run source scraper e2e tests'));
    const block = e2e.slice(gate, e2e.indexOf('- name: Run source scraper e2e tests'));
    expect(block).toContain(LIVE_ENV);
    expect(block).toContain('::notice title=Live Softy e2e skipped::');
    expect(block).toContain('EVER_JOBS_LIVE_SOFTY');
  });

  it('the Softy e2e spec is gated on the same variable (skipped with a visible reason otherwise)', () => {
    const spec = fs.readFileSync(
      path.join(REPO_ROOT, 'packages', 'plugins', 'source-ats-softy', '__tests__', 'softy.e2e-spec.ts'),
      'utf8',
    );
    expect(spec).toContain("const LIVE_SOFTY_ENV = 'EVER_JOBS_LIVE_SOFTY'");
    expect(spec).toContain("process.env[LIVE_SOFTY_ENV] === '1'");
    expect(spec).toContain('describe.skip');
  });
});
