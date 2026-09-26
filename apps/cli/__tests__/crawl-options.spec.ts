import 'reflect-metadata';
import { CrawlPolicyDto, ScraperInputDto } from '@ever-jobs/models';
import { CRAWL_ENV, readCrawlPolicyEnv, resetCrawlPolicyEnvCache, resolveCrawlPolicy } from '@ever-jobs/common';
import {
  applyCrawlCliOptions,
  applyCrawlProcessOptions,
  buildCrawlPolicyFromCli,
  parseNonNegativeInt,
} from '../src/commands/crawl-options';
import { SearchCommand } from '../src/commands/search.command';
import { CompareCommand } from '../src/commands/compare.command';

/**
 * Spec 1690 §5.2 — CLI crawl flags: `--crawl <json>` plus the convenience
 * flags (`--user-agent-mode`, `--proxy-rotation`, `--max-per-host`,
 * `--min-interval-ms`, `--crawl-retries`, `--robots-txt`, `--discovery`),
 * alongside the unchanged `--user-agent` / `--rate-delay-*` flags. The preset
 * is env-only (`EVER_JOBS_CRAWL_PRESET`).
 */

let stderr: jest.SpyInstance;
let stdout: jest.SpyInstance;
let consoleError: jest.SpyInstance;
beforeEach(() => {
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  stderr.mockRestore();
  stdout.mockRestore();
  consoleError.mockRestore();
});

describe('parseNonNegativeInt', () => {
  it('parses non-negative integers and returns NaN for anything else', () => {
    expect(parseNonNegativeInt('0')).toBe(0);
    expect(parseNonNegativeInt(' 1000 ')).toBe(1000);
    expect(parseNonNegativeInt('-1')).toBeNaN();
    expect(parseNonNegativeInt('1.5')).toBeNaN();
    expect(parseNonNegativeInt('fast')).toBeNaN();
  });
});

describe('buildCrawlPolicyFromCli (Spec 1690)', () => {
  it('returns no crawl when no crawl flag was given', () => {
    expect(buildCrawlPolicyFromCli({})).toEqual({ warnings: [] });
  });

  it('maps each convenience flag to its crawl field', () => {
    const { crawl, warnings } = buildCrawlPolicyFromCli({
      userAgentMode: 'strict',
      proxyRotation: 'per-request',
      maxPerHost: 1,
      minIntervalMs: 1000,
      crawlRetries: 0,
      robotsTxt: 'respect',
      discovery: 'sitemap',
    });
    expect(warnings).toEqual([]);
    expect(crawl).toBeInstanceOf(CrawlPolicyDto);
    expect({ ...crawl }).toEqual({
      userAgentMode: 'strict',
      proxyRotation: 'per-request',
      maxConcurrentPerHost: 1,
      minIntervalMs: 1000,
      retries: 0,
      robotsTxt: 'respect',
      discovery: 'sitemap',
    });
  });

  it('takes any field from --crawl JSON; convenience flags win over the same field', () => {
    const { crawl } = buildCrawlPolicyFromCli({
      crawl: '{"maxConcurrentPerHost":4,"jitterMs":250,"retryStatuses":[429]}',
      maxPerHost: 1,
    });
    expect({ ...crawl }).toEqual({ maxConcurrentPerHost: 1, jitterMs: 250, retryStatuses: [429] });
  });

  it('warns and ignores invalid values instead of failing the command', () => {
    const { crawl, warnings } = buildCrawlPolicyFromCli({
      crawl: '{broken',
      proxyRotation: 'sideways',
      maxPerHost: Number.NaN,
      discovery: 'listing',
    });
    expect({ ...crawl }).toEqual({ discovery: 'listing' });
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toMatch(/--crawl/);
    expect(warnings.join('\n')).toMatch(/--proxy-rotation must be one of per-request, per-scrape, per-host, off/);
    expect(warnings.join('\n')).toMatch(/--max-per-host/);
  });

  it('rejects a --crawl JSON that is not an object', () => {
    expect(buildCrawlPolicyFromCli({ crawl: '[1,2]' })).toEqual({
      warnings: ['--crawl must be a JSON object; ignoring'],
    });
  });
});

describe('applyCrawlCliOptions', () => {
  it('merges flags into an existing crawl (e.g. from --stdin JSON), flags winning', () => {
    const input = new ScraperInputDto({ crawl: { retries: 1, discovery: 'listing' } as CrawlPolicyDto });
    applyCrawlCliOptions(input, { discovery: 'sitemap' });
    expect(input.crawl).toBeInstanceOf(CrawlPolicyDto);
    expect({ ...input.crawl }).toEqual({ retries: 1, discovery: 'sitemap' });
  });

  it('leaves the input untouched without crawl flags and prints warnings to stderr', () => {
    const input = new ScraperInputDto({ searchTerm: 'x' });
    applyCrawlCliOptions(input, { robotsTxt: 'sometimes' });
    expect(input.crawl).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Warning: --robots-txt must be one of'));
  });
});

describe('SearchCommand crawl flags (Spec 1690)', () => {
  const makeCommand = () => {
    const jobsService = { searchJobs: jest.fn().mockResolvedValue([]) };
    const analytics = { analyze: jest.fn(), analyzeCompanies: jest.fn() };
    return { cmd: new SearchCommand(jobsService as any, analytics as any), jobsService };
  };

  it('keeps the legacy flags and adds crawl from the new ones', () => {
    const { cmd } = makeCommand();
    const input: ScraperInputDto = (cmd as any).buildInputFromOptions({
      searchTerm: 'engineer',
      userAgent: 'AcmeBot/1.0',
      rateDelayMin: 1,
      rateDelayMax: 2,
      maxPerHost: 1,
      discovery: 'sitemap',
    });
    expect(input).toMatchObject({ searchTerm: 'engineer', userAgent: 'AcmeBot/1.0', rateDelayMin: 1, rateDelayMax: 2 });
    expect({ ...input.crawl }).toEqual({ maxConcurrentPerHost: 1, discovery: 'sitemap' });
  });

  it('builds no crawl when only legacy flags are used (the DTO is exactly as before)', () => {
    const { cmd } = makeCommand();
    const input: ScraperInputDto = (cmd as any).buildInputFromOptions({ searchTerm: 'engineer', rateDelayMin: 1 });
    expect(input.crawl).toBeUndefined();
    expect(input.rateDelayMin).toBe(1);
  });

  it('--stdin JSON: crawl flags override the JSON crawl fields', async () => {
    const { cmd, jobsService } = makeCommand();
    await (cmd as any).runWithJson(
      { searchTerm: 'engineer', crawl: { retries: 2, discovery: 'listing' } },
      { discovery: 'sitemap', crawlRetries: 0 },
    );
    const input: ScraperInputDto = jobsService.searchJobs.mock.calls[0][0];
    expect({ ...input.crawl }).toEqual({ retries: 0, discovery: 'sitemap' });
  });
});

describe('CompareCommand crawl flags (Spec 1690)', () => {
  it('applies the crawl flags to every per-site search', async () => {
    const jobsService = { searchJobs: jest.fn().mockResolvedValue([]) };
    const analytics = { compareSites: jest.fn().mockReturnValue([]), summarize: jest.fn().mockReturnValue({}) };
    const cmd = new CompareCommand(jobsService as any, analytics as any);

    await cmd.run([], { searchTerm: 'engineer', crawl: '{"minIntervalMs":1500}', maxPerHost: 1 });

    expect(jobsService.searchJobs.mock.calls.length).toBeGreaterThan(1);
    for (const [input] of jobsService.searchJobs.mock.calls.slice(0, 3)) {
      expect({ ...input.crawl }).toEqual({ minIntervalMs: 1500, maxConcurrentPerHost: 1 });
    }
  });
});

describe('--crawl-preset / --caller-overrides (process-wide, this CLI run)', () => {
  const saved = { preset: process.env[CRAWL_ENV.PRESET], caller: process.env[CRAWL_ENV.CALLER_OVERRIDES] };
  afterEach(() => {
    for (const [name, value] of [
      [CRAWL_ENV.PRESET, saved.preset],
      [CRAWL_ENV.CALLER_OVERRIDES, saved.caller],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetCrawlPolicyEnvCache();
  });

  it('sets the env for a given env object, and warns on invalid values', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyCrawlProcessOptions({ crawlPreset: 'Legacy', callerOverrides: 'stricter' }, env)).toEqual([]);
    expect(env).toEqual({ [CRAWL_ENV.PRESET]: 'legacy', [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' });
    const warnings = applyCrawlProcessOptions({ crawlPreset: 'rude', callerOverrides: 'all' }, {});
    expect(warnings).toEqual([expect.stringContaining('--crawl-preset'), expect.stringContaining('--caller-overrides')]);
  });

  it('applyCrawlCliOptions switches the preset this process resolves with (the cached parse is dropped)', () => {
    readCrawlPolicyEnv(); // warm the cache under the current preset
    applyCrawlCliOptions(new ScraperInputDto({ searchTerm: 'x' }), { crawlPreset: 'legacy' });

    expect(readCrawlPolicyEnv().preset).toBe('legacy');
    expect(resolveCrawlPolicy({}).maxConcurrentPerHost).toBe(0);
  });

  it('SearchCommand accepts --crawl-preset and --caller-overrides', () => {
    const jobsService = { searchJobs: jest.fn().mockResolvedValue([]) };
    const analytics = { analyze: jest.fn(), analyzeCompanies: jest.fn() };
    const cmd = new SearchCommand(jobsService as any, analytics as any);
    expect(cmd.parseCrawlPreset('strict')).toBe('strict');
    expect(cmd.parseCallerOverrides('none')).toBe('none');

    (cmd as any).buildInputFromOptions({ searchTerm: 'engineer', crawlPreset: 'strict', callerOverrides: 'none' });

    expect(readCrawlPolicyEnv().preset).toBe('strict');
    expect(readCrawlPolicyEnv().callerOverrides).toBe('none');
  });
});
