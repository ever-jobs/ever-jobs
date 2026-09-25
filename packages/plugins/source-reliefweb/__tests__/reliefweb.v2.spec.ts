/**
 * ReliefWeb API v2 migration (Spec 1752).
 *
 * Fixtures:
 *  - `reliefweb-v1-410-decommissioned.json` and
 *    `reliefweb-v2-403-unapproved-appname.json` are VERBATIM live bodies
 *    (2026-09-25: `GET /v1/jobs` → 410; `GET /v2/jobs?appname=ever-jobs` → 403).
 *  - `reliefweb-v2-jobs.json` is CONSTRUCTED from the v2 field tables
 *    (https://apidoc.reliefweb.int/fields-tables) — the API refused our
 *    unapproved appname, so no live v2 job list could be captured. Its ids and
 *    `url_alias` values are real (seen live on reliefweb.int); the shape of the
 *    canonical `url` (`/node/<id>`) is an assumption the mapping does not rely on.
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DescriptionFormat, ScraperInputDto, Site } from '@ever-jobs/models';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const fixture = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
const jobsFixture = fixture('reliefweb-v2-jobs.json');
const unapprovedAppName = fixture('reliefweb-v2-403-unapproved-appname.json');
const v1Decommissioned = fixture('reliefweb-v1-410-decommissioned.json');

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, post: jest.fn(), setHeaders: jest.fn() })),
  };
});

import { ReliefWebService } from '../src/reliefweb.service';
import { RELIEFWEB_API_URL, RELIEFWEB_APP_NAME_ENV } from '../src/reliefweb.constants';

function httpError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

async function scrape(input: Partial<ScraperInputDto> = {}) {
  return new ReliefWebService().scrape({ siteType: [Site.RELIEFWEB], resultsWanted: 10, ...input } as ScraperInputDto);
}

describe('ReliefWebService — API v2 (Spec 1752)', () => {
  const saved = process.env[RELIEFWEB_APP_NAME_ENV];

  beforeEach(() => {
    mockGet.mockReset();
    delete process.env[RELIEFWEB_APP_NAME_ENV];
  });

  afterAll(() => {
    if (saved === undefined) delete process.env[RELIEFWEB_APP_NAME_ENV];
    else process.env[RELIEFWEB_APP_NAME_ENV] = saved;
  });

  describe('request', () => {
    it('calls /v2/jobs (never the decommissioned v1) with the neutral default appname', async () => {
      mockGet.mockResolvedValueOnce({ data: jobsFixture });
      await scrape({ searchTerm: 'data' });

      expect(mockGet).toHaveBeenCalledTimes(1);
      const url = new URL(mockGet.mock.calls[0][0]);
      expect(`${url.origin}${url.pathname}`).toBe('https://api.reliefweb.int/v2/jobs');
      expect(RELIEFWEB_API_URL).not.toContain('/v1/');
      expect(url.searchParams.get('appname')).toBe('ever-jobs');
      expect(url.searchParams.get('limit')).toBe('10');
      expect(url.searchParams.get('query[value]')).toBe('data');
      expect(url.searchParams.getAll('fields[include][]')).toEqual(
        expect.arrayContaining(['title', 'body', 'body-html', 'url', 'url_alias', 'source', 'date', 'country']),
      );
    });

    it('takes the appname from RELIEFWEB_APPNAME (trimmed), read per scrape', async () => {
      process.env[RELIEFWEB_APP_NAME_ENV] = '  acme-jobs-search-x7k2  ';
      mockGet.mockResolvedValueOnce({ data: jobsFixture });
      await scrape();
      expect(new URL(mockGet.mock.calls[0][0]).searchParams.get('appname')).toBe('acme-jobs-search-x7k2');
    });

    it('falls back to the default when RELIEFWEB_APPNAME is blank', async () => {
      process.env[RELIEFWEB_APP_NAME_ENV] = '   ';
      mockGet.mockResolvedValueOnce({ data: jobsFixture });
      await scrape();
      expect(new URL(mockGet.mock.calls[0][0]).searchParams.get('appname')).toBe('ever-jobs');
    });
  });

  describe('errors', () => {
    it('reports an unapproved appname (live 403 body) as bad_input naming RELIEFWEB_APPNAME', async () => {
      mockGet.mockRejectedValueOnce(httpError(403, unapprovedAppName));
      const result = await scrape();

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('bad_input');
      expect(result.diagnostics?.detail).toContain('"ever-jobs"');
      expect(result.diagnostics?.detail).toContain('RELIEFWEB_APPNAME');
      expect(result.diagnostics?.detail).toContain('https://apidoc.reliefweb.int/parameters#appname');
    });

    it('keeps any other 403 a block (no appname in the message)', async () => {
      mockGet.mockRejectedValueOnce(httpError(403, { status: 403, error: { message: 'Forbidden' } }));
      const result = await scrape();
      expect(result.diagnostics?.reason).toBe('blocked');
    });

    it('a 410 like v1\'s decommission answer is bad_input, not an empty board', async () => {
      mockGet.mockRejectedValueOnce(httpError(410, v1Decommissioned));
      const result = await scrape();
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('bad_input');
    });
  });

  describe('mapping', () => {
    it('maps every v2 entry, linking the public page and never the API href', async () => {
      mockGet.mockResolvedValueOnce({ data: jobsFixture });
      const result = await scrape();

      expect(result.jobs.map((j) => [j.id, j.jobUrl])).toEqual([
        ['reliefweb-4231248', 'https://reliefweb.int/job/4231248/full-stack-software-developer'],
        ['reliefweb-4228316', 'https://reliefweb.int/node/4228316'],
        ['reliefweb-4225051', 'https://reliefweb.int/node/4225051'],
      ]);
      for (const job of result.jobs) expect(job.jobUrl).not.toContain('api.reliefweb.int');

      const first = result.jobs[0];
      expect(first.title).toBe('Full Stack Software Developer');
      expect(first.companyName).toBe('UN Office for the Coordination of Humanitarian Affairs');
      expect(first.datePosted).toBe('2026-09-18');
      expect(first.site).toBe(Site.RELIEFWEB);
      expect(first.emails).toEqual(['jobs@example.org']);
    });

    it('serves each description format from the matching v2 field', async () => {
      const run = async (descriptionFormat?: DescriptionFormat) => {
        mockGet.mockResolvedValueOnce({ data: jobsFixture });
        return (await scrape({ descriptionFormat })).jobs[0].description;
      };

      expect(await run(DescriptionFormat.HTML)).toContain('<strong>humanitarian data</strong>');
      expect(await run(DescriptionFormat.MARKDOWN)).toContain('**humanitarian data**');
      const plain = await run(DescriptionFormat.PLAIN);
      expect(plain).toContain('humanitarian data');
      expect(plain).not.toMatch(/<[^>]+>|\*\*/);
      expect(await run()).toContain('## About the role'); // unchanged default: the Markdown body
    });

    it('falls back to the Markdown body for HTML / plain when body-html is absent', async () => {
      mockGet.mockResolvedValueOnce({ data: jobsFixture });
      const html = (await scrape({ descriptionFormat: DescriptionFormat.HTML })).jobs[2].description;
      expect(html).toBe('Lead partnerships.');
    });
  });
});
