import 'reflect-metadata';
import * as path from 'path';
import { ScraperInputDto } from '@ever-jobs/models';
import { SearchCommand } from '../src/commands/search.command';

/**
 * Spec 1701 (T12) — `--linkedin-fetch-company-details` sets
 * `linkedinFetchCompanyDetails: true`; without the flag the key stays unset so
 * the plugin still reads `EVER_JOBS_LINKEDIN_FETCH_COMPANY_DETAILS`.
 *
 * Options are parsed with the commander build nest-commander uses, registered
 * the way it registers them, so the real flag grammar is exercised.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OptionMeta } = require('nest-commander/src/constants');
const commanderPath = require.resolve('commander', {
  paths: [path.dirname(require.resolve('nest-commander'))],
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Command: Program, Option: CommanderOption } = require(commanderPath);

function parse(instance: object, argv: string[]): Record<string, any> {
  const program = new Program();
  program.exitOverride();
  const proto = Object.getPrototypeOf(instance);
  for (const name of Object.getOwnPropertyNames(proto)) {
    const fn = proto[name];
    if (typeof fn !== 'function') continue;
    const meta = Reflect.getMetadata(OptionMeta, fn);
    if (!meta) continue;
    program.addOption(
      new CommanderOption(meta.flags, meta.description)
        .default(undefined)
        .preset(undefined)
        .argParser(fn.bind(instance)),
    );
  }
  program.parse(argv, { from: 'user' });
  return program.opts();
}

function makeSearch() {
  const jobsService = { searchJobs: jest.fn().mockResolvedValue([]) };
  const analytics = { analyze: jest.fn(), analyzeCompanies: jest.fn().mockReturnValue([]) };
  return { cmd: new SearchCommand(jobsService as any, analytics as any), jobsService };
}

let stdout: jest.SpyInstance;
let stderr: jest.SpyInstance;

beforeEach(() => {
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
});

describe('search command — --linkedin-fetch-company-details (Spec 1701)', () => {
  it('parses the flag as a boolean switch', () => {
    const { cmd } = makeSearch();
    const opts = parse(cmd, ['-q', 'engineer', '--linkedin-fetch-company-details']);
    expect(opts.linkedinFetchCompanyDetails).toBe(true);
    expect(parse(cmd, ['-q', 'engineer']).linkedinFetchCompanyDetails).toBeUndefined();
  });

  it('maps the flag onto the DTO', async () => {
    const { cmd, jobsService } = makeSearch();
    await cmd.run([], { searchTerm: 'engineer', linkedinFetchCompanyDetails: true } as any);
    const input = jobsService.searchJobs.mock.calls[0][0] as ScraperInputDto;
    expect(input.linkedinFetchCompanyDetails).toBe(true);
  });

  it('leaves the key unset without the flag so the env var still decides', async () => {
    const { cmd, jobsService } = makeSearch();
    await cmd.run([], { searchTerm: 'engineer' } as any);
    const input = jobsService.searchJobs.mock.calls[0][0];
    expect('linkedinFetchCompanyDetails' in input).toBe(false);
  });
});
