/**
 * Unit tests for the SmartRecruiters scraper's link mapping (Spec 1750).
 *
 * The fixtures are the live response shapes captured 2026-09-25 from the public
 * Posting API for company `AbbVie` (custom fields and the job-ad body trimmed):
 *
 *  - `smartrecruiters-list.json`   — `GET /v1/companies/AbbVie/postings`: every
 *    posting carries `ref` = its **API resource** URL and NO `postingUrl`,
 *    `applyUrl` or `jobAd`.
 *  - `smartrecruiters-detail.json` — `GET /v1/companies/AbbVie/postings/<id>`:
 *    carries `postingUrl` + `applyUrl` (the public pages) and no `ref`.
 *
 * Before Spec 1750 `jobUrl` was `job.ref`, so every list-mapped posting linked
 * people to raw JSON.
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      post: jest.fn(),
      setHeaders: jest.fn(),
    })),
    randomSleep: jest.fn(() => Promise.resolve()),
  };
});

import { SmartRecruitersService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const LIST: { content: any[] } = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'smartrecruiters-list.json'), 'utf8'),
);
const DETAIL: any = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'smartrecruiters-detail.json'), 'utf8'),
);

const API_HOST = 'api.smartrecruiters.com';
const PUBLIC = 'https://jobs.smartrecruiters.com';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function envelope(content: any[]): { data: { content: any[] } } {
  return { data: { offset: 0, limit: 100, totalFound: content.length, content } as any };
}

async function scrape(content: any[], companySlug = 'AbbVie', extra: Partial<ScraperInputDto> = {}) {
  mockGet.mockReset();
  mockGet.mockResolvedValueOnce(envelope(content));
  const service = new SmartRecruitersService();
  return service.scrape({
    siteType: [Site.SMARTRECRUITERS],
    companySlug,
    resultsWanted: 100,
    ...extra,
  } as ScraperInputDto);
}

describe('SmartRecruitersService — public posting links (Spec 1750)', () => {
  const savedKey = process.env.SMARTRECRUITERS_API_KEY;
  beforeEach(() => {
    delete process.env.SMARTRECRUITERS_API_KEY;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.SMARTRECRUITERS_API_KEY;
    else process.env.SMARTRECRUITERS_API_KEY = savedKey;
  });

  it('the list fixture really is the API shape: ref on the API host, no postingUrl', () => {
    // Guards the premise of every test below — a fabricated fixture whose `ref`
    // was the public page is how the bug stayed green.
    expect(LIST.content.length).toBeGreaterThan(0);
    for (const raw of LIST.content) {
      expect(raw.ref).toMatch(/^https:\/\/api\.smartrecruiters\.com\/v1\/companies\/AbbVie\/postings\//);
      expect(raw.postingUrl).toBeUndefined();
      expect(raw.applyUrl).toBeUndefined();
    }
  });

  it('maps a list posting (API ref, no postingUrl) to the public posting page', async () => {
    const result = await scrape(clone(LIST.content));

    expect(result.jobs).toHaveLength(LIST.content.length);
    result.jobs.forEach((job, i) => {
      const raw = LIST.content[i];
      expect(job.jobUrl).toBe(`${PUBLIC}/AbbVie/${raw.id}`);
      expect(job.jobUrl).not.toBe(raw.ref);
      expect(job.jobUrl).not.toContain(API_HOST);
      // the list endpoint has no applyUrl — nothing is invented
      expect(job.applyUrl ?? null).toBeNull();
      // one posting id everywhere
      expect(job.id).toBe(`sr-${raw.id}`);
      expect(job.atsId).toBe(raw.id);
      expect(job.atsType).toBe('smartrecruiters');
      expect(job.site).toBe(Site.SMARTRECRUITERS);
    });
  });

  it('uses the identifier the API returned, not the caller slug casing', async () => {
    const result = await scrape(clone(LIST.content), 'abbvie');

    expect(result.jobs[0].jobUrl).toBe(`${PUBLIC}/AbbVie/${LIST.content[0].id}`);
  });

  it('prefers the detail postingUrl and sets applyUrl from the API applyUrl', async () => {
    const withRef = { ...clone(DETAIL), ref: LIST.content[0].ref };
    const result = await scrape([withRef]);

    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0];
    expect(job.jobUrl).toBe(DETAIL.postingUrl);
    expect(job.applyUrl).toBe(DETAIL.applyUrl);
    expect(job.jobUrl).not.toContain(API_HOST);
    expect(job.applyUrl).not.toContain(API_HOST);
    expect(job.atsId).toBe(DETAIL.id);
    expect(job.id).toBe(`sr-${DETAIL.id}`);
  });

  it('refuses an API-shaped postingUrl/applyUrl and falls back to the public pattern', async () => {
    const raw = {
      ...clone(LIST.content[0]),
      postingUrl: LIST.content[0].ref,
      applyUrl: `${LIST.content[0].ref}/candidates`,
    };
    const result = await scrape([raw]);

    expect(result.jobs[0].jobUrl).toBe(`${PUBLIC}/AbbVie/${raw.id}`);
    expect(result.jobs[0].applyUrl ?? null).toBeNull();
  });

  it('reads the company identifier from ref when the posting has no company', async () => {
    const raw = clone(LIST.content[0]);
    delete raw.company;
    const result = await scrape([raw], 'abbvie');

    expect(result.jobs[0].jobUrl).toBe(`${PUBLIC}/AbbVie/${raw.id}`);
  });

  it('falls back to the caller slug when neither company nor ref names the company', async () => {
    const raw = clone(LIST.content[0]);
    delete raw.company;
    delete raw.ref;
    const result = await scrape([raw], 'Visa');

    expect(result.jobs[0].jobUrl).toBe(`${PUBLIC}/Visa/${raw.id}`);
  });

  it('reads the posting id from ref when id is missing, and keeps ids consistent', async () => {
    const raw = clone(LIST.content[0]);
    const expectedId = raw.id;
    delete raw.id;
    const result = await scrape([raw]);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].jobUrl).toBe(`${PUBLIC}/AbbVie/${expectedId}`);
    expect(result.jobs[0].id).toBe(`sr-${expectedId}`);
    expect(result.jobs[0].atsId).toBe(expectedId);
  });

  it('skips a posting with no id anywhere instead of linking to /undefined', async () => {
    const raw = clone(LIST.content[0]);
    delete raw.id;
    delete raw.ref;
    const result = await scrape([raw, clone(LIST.content[1])]);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].atsId).toBe(LIST.content[1].id);
    expect(result.jobs.every((j) => !j.jobUrl.includes('undefined'))).toBe(true);
  });

  it('the authenticated path maps links the same way', async () => {
    mockGet.mockReset();
    mockGet.mockResolvedValueOnce(envelope(clone(LIST.content)));
    const service = new SmartRecruitersService();
    const result = await service.scrape({
      siteType: [Site.SMARTRECRUITERS],
      companySlug: 'AbbVie',
      resultsWanted: 100,
      auth: { smartrecruiters: { apiKey: 'test-key' } },
    } as ScraperInputDto);

    // it really went through the X-SmartToken path
    expect(mockGet.mock.calls[0][1]?.headers?.['X-SmartToken']).toBe('test-key');
    expect(result.jobs).toHaveLength(LIST.content.length);
    for (const job of result.jobs) {
      expect(job.jobUrl.startsWith(`${PUBLIC}/AbbVie/`)).toBe(true);
      expect(job.jobUrl).not.toContain(API_HOST);
    }
  });
});
