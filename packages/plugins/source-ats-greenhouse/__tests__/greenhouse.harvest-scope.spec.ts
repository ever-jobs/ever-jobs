import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: jest.fn(),
    })),
  };
});

import { GreenhouseService } from '../src';
import {
  GREENHOUSE_API_KEY_ENV_VAR,
  GREENHOUSE_API_URL,
  GREENHOUSE_HARVEST_API_URL,
  GREENHOUSE_HARVEST_BOARD_ENV_VAR,
} from '../src/greenhouse.constants';

const SLUG = 'janestreet';
const PUBLIC_URL = `${GREENHOUSE_API_URL}/${SLUG}/jobs?content=true`;

const PUBLIC_BOARD = {
  jobs: [
    {
      id: 42,
      title: 'Software Engineer Intern',
      updated_at: '2026-09-24T00:00:00.000Z',
      location: { name: 'New York, NY' },
      absolute_url: `https://job-boards.greenhouse.io/${SLUG}/jobs/42`,
      content: '<p>Public posting.</p>',
    },
  ],
};

const HARVEST_JOBS = [
  { id: 7, name: 'Operator Internal Role', status: 'open', confidential: true, offices: [], departments: [] },
];

/** Serve the public board and the Harvest list; anything else is a 404. */
function serve(url: string): Promise<{ data: unknown }> {
  if (url === PUBLIC_URL) return Promise.resolve({ data: JSON.parse(JSON.stringify(PUBLIC_BOARD)) });
  if (url.startsWith(`${GREENHOUSE_HARVEST_API_URL}/jobs`)) {
    return Promise.resolve({ data: JSON.parse(JSON.stringify(HARVEST_JOBS)) });
  }
  const err: any = new Error(`Request failed with status code 404 (${url})`);
  err.response = { status: 404 };
  return Promise.reject(err);
}

function requestedUrls(): string[] {
  return mockGet.mock.calls.map((c) => String(c[0]));
}

/**
 * Spec 1735 §4.5 — the env Harvest key is scoped to its own board.
 *
 * Harvest `/v1/jobs` lists the key owner's jobs (confidential ones included)
 * whatever `companySlug` says. Company plugins now delegate to this adapter in
 * the default fan-out, so an unscoped `GREENHOUSE_API_KEY` made every one of
 * them return the operator's own jobs under another firm's name.
 */
describe('GreenhouseService — Harvest key scoping (Spec 1735 §4.5)', () => {
  const saved = {
    key: process.env[GREENHOUSE_API_KEY_ENV_VAR],
    board: process.env[GREENHOUSE_HARVEST_BOARD_ENV_VAR],
  };

  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockImplementation(serve);
    delete process.env[GREENHOUSE_API_KEY_ENV_VAR];
    delete process.env[GREENHOUSE_HARVEST_BOARD_ENV_VAR];
  });

  afterAll(() => {
    for (const [name, value] of [
      [GREENHOUSE_API_KEY_ENV_VAR, saved.key],
      [GREENHOUSE_HARVEST_BOARD_ENV_VAR, saved.board],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function scrape(service = new GreenhouseService(), extra: Partial<ScraperInputDto> = {}) {
    return service.scrape({
      siteType: [Site.GREENHOUSE],
      companySlug: SLUG,
      resultsWanted: 5,
      ...extra,
    } as ScraperInputDto);
  }

  it('names the env vars it reads', () => {
    expect(GREENHOUSE_API_KEY_ENV_VAR).toBe('GREENHOUSE_API_KEY');
    expect(GREENHOUSE_HARVEST_BOARD_ENV_VAR).toBe('GREENHOUSE_HARVEST_BOARD');
  });

  it('ignores an env key with no board scope and reads only the public board', async () => {
    process.env[GREENHOUSE_API_KEY_ENV_VAR] = 'operator-harvest-key';

    const result = await scrape();

    expect(requestedUrls()).toEqual([PUBLIC_URL]);
    expect(result.jobs.map((j) => j.title)).toEqual(['Software Engineer Intern']);
  });

  it('ignores an env key scoped to a different board', async () => {
    process.env[GREENHOUSE_API_KEY_ENV_VAR] = 'operator-harvest-key';
    process.env[GREENHOUSE_HARVEST_BOARD_ENV_VAR] = 'operatorco';

    const result = await scrape();

    expect(requestedUrls()).toEqual([PUBLIC_URL]);
    expect(result.jobs.map((j) => j.title)).toEqual(['Software Engineer Intern']);
  });

  it('uses the env key for the board it is scoped to (case-insensitive, trimmed)', async () => {
    process.env[GREENHOUSE_API_KEY_ENV_VAR] = 'janestreet-harvest-key';
    process.env[GREENHOUSE_HARVEST_BOARD_ENV_VAR] = '  JaneStreet ';

    const result = await scrape();

    expect(requestedUrls()).toHaveLength(1);
    expect(requestedUrls()[0].startsWith(`${GREENHOUSE_HARVEST_API_URL}/jobs?`)).toBe(true);
    expect(result.jobs.map((j) => j.title)).toEqual(['Operator Internal Role']);
  });

  it('still honours an explicit per-request key', async () => {
    const result = await scrape(new GreenhouseService(), {
      auth: { greenhouse: { apiKey: 'caller-harvest-key' } },
    } as Partial<ScraperInputDto>);

    expect(requestedUrls()[0].startsWith(`${GREENHOUSE_HARVEST_API_URL}/jobs?`)).toBe(true);
    expect(result.jobs.map((j) => j.title)).toEqual(['Operator Internal Role']);
  });

  it('warns once per adapter instance about an unscoped env key, never printing it', async () => {
    process.env[GREENHOUSE_API_KEY_ENV_VAR] = 'operator-harvest-key';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const service = new GreenhouseService();
      await scrape(service);
      await scrape(service);

      const scopeWarnings = warn.mock.calls.filter((c) => String(c[0]).includes(GREENHOUSE_HARVEST_BOARD_ENV_VAR));
      expect(scopeWarnings).toHaveLength(1);
      expect(String(scopeWarnings[0][0])).not.toContain('operator-harvest-key');
    } finally {
      warn.mockRestore();
    }
  });
});
