import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DescriptionFormat, ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
const mockCreateHttpClient = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: (...args: unknown[]) => {
      mockCreateHttpClient(...args);
      return { get: mockGet, setHeaders: mockSetHeaders };
    },
    randomSleep: () => Promise.resolve(),
  };
});

import { BdjobsLegacyHtmlScraper } from '../src/bdjobs.legacy-html';
import { BDJobsService } from '../src/bdjobs.service';
import { BDJOBS_LEGACY_SEARCH_URL, BDJOBS_MAX_PAGES } from '../src/bdjobs.constants';

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const SEARCH = read('bdjobs-legacy-search.html');
const DETAIL = read('bdjobs-legacy-detail.html');
const SPA_SHELL = read('bdjobs-spa-shell.html');

const searchCalls = () => mockGet.mock.calls.filter(([url]) => url === BDJOBS_LEGACY_SEARCH_URL);
const detailCalls = () => mockGet.mock.calls.filter(([url]) => url !== BDJOBS_LEGACY_SEARCH_URL);

function route(search: (pg: number) => string | Error, detail: string | Error = DETAIL): void {
  mockGet.mockImplementation(async (url: string, config: { params?: Record<string, any> }) => {
    const value = url === BDJOBS_LEGACY_SEARCH_URL ? search(config?.params?.pg ?? 1) : detail;
    if (value instanceof Error) throw value;
    return { status: 200, data: value };
  });
}

function input(partial: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({ siteType: [Site.BDJOBS], searchTerm: 'developer', resultsWanted: 10, ...partial });
}

const scraper = () => new BdjobsLegacyHtmlScraper(new Logger('BdjobsLegacyHtmlSpec'));

/** Spec 1711 — the legacy HTML path stays reachable (BDJOBS_MODE=html) and is patched. */
describe('BdjobsLegacyHtmlScraper — Spec 1711', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockCreateHttpClient.mockReset();
  });

  afterEach(() => {
    delete process.env.BDJOBS_MODE;
  });

  it('is what BDJOBS_MODE=html runs', async () => {
    process.env.BDJOBS_MODE = 'html';
    route(() => SEARCH);
    const res = await new BDJobsService().scrape(input());
    expect(res.jobs.map((j) => j.id)).toEqual(['111', '222']);
  });

  it('still maps cards the old way', async () => {
    route(() => SEARCH);
    const res = await scraper().scrape(input({ descriptionFormat: DescriptionFormat.MARKDOWN }));
    const [first, second] = res.jobs;
    expect(first).toMatchObject({
      id: '111',
      title: 'Software Engineer',
      jobUrl: 'https://jobs.bdjobs.com/jobdetails.asp?id=111&jobid=111&ln=1',
      site: Site.BDJOBS,
      description: 'Build features\nWrite tests',
    });
    expect(first.location).toMatchObject({ city: 'Dhaka' });
    expect(second.isRemote).toBe(true);
    expect(res.diagnostics).toBeUndefined();
  });

  it('reads the first company element instead of concatenating every match', async () => {
    route(() => SEARCH);
    const res = await scraper().scrape(input());
    expect(res.jobs[0].companyName).toBe('Acme Ltd');
  });

  it('regression: a deadline is never the posting date', async () => {
    route(() => SEARCH);
    const res = await scraper().scrape(input());
    expect(res.jobs[0].datePosted).toBe('2025-10-05');
    expect(res.jobs[1].datePosted).toBeNull();
  });

  it('checks the seen ids before fetching a detail page, and stops on a page with no new ids', async () => {
    route(() => SEARCH);
    const res = await scraper().scrape(input());
    expect(res.jobs).toHaveLength(2);
    expect(detailCalls()).toHaveLength(2);
    expect(searchCalls()).toHaveLength(2);
  });

  it('caps the pages it fetches', async () => {
    route(
      (pg) =>
        `<div class="job-item"><a href="jobdetails.asp?jobid=${pg}01">Job A</a></div>` +
        `<div class="job-item"><a href="jobdetails.asp?jobid=${pg}02">Job B</a></div>`,
    );
    const res = await scraper().scrape(input({ resultsWanted: 1000 }));
    expect(searchCalls()).toHaveLength(BDJOBS_MAX_PAGES);
    expect(res.jobs).toHaveLength(BDJOBS_MAX_PAGES * 2);
  });

  it('regression: the new site shell on page 1 is a diagnostic, not an empty board', async () => {
    route(() => SPA_SHELL);
    const res = await scraper().scrape(input());
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBe('fetch_error');
    expect(res.diagnostics?.detail).toContain('BDJOBS_MODE');
  });

  it('a challenge page on page 1 is blocked', async () => {
    route(() => '<html><title>Attention Required! | Cloudflare</title></html>');
    const res = await scraper().scrape(input());
    expect(res.diagnostics?.reason).toBe('blocked');
  });

  it('a genuinely empty legacy results page stays diagnostic-free', async () => {
    route(() => '<html><body><div class="no-results">No jobs found</div></body></html>');
    const res = await scraper().scrape(input());
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics).toBeUndefined();
  });

  it('a page-1 failure is classified', async () => {
    route(() => Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } }));
    const res = await scraper().scrape(input());
    expect(res.diagnostics?.reason).toBe('blocked');
  });

  it('a failed detail page keeps the card', async () => {
    route(() => SEARCH, new Error('socket hang up'));
    const res = await scraper().scrape(input());
    expect(res.jobs).toHaveLength(2);
    expect(res.jobs[0].description).toBeUndefined();
  });

  it('identifies itself honestly and passes the timeout under both keys', async () => {
    route(() => SEARCH);
    await scraper().scrape(input({ requestTimeout: 15 }));
    const headers = mockSetHeaders.mock.calls[0][0];
    expect(headers['User-Agent']).toContain('EverJobs/1.0');
    expect(headers['User-Agent']).not.toMatch(/Chrome\//);
    expect(headers.Accept).toContain('text/html');
    expect(mockCreateHttpClient).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15, requestTimeout: 15 }));
  });
});
