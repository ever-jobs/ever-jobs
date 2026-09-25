/**
 * ReliefWeb link mapping (Spec 1751): each API entry's `href` is its API
 * resource (`https://api.reliefweb.int/v1/jobs/<id>`) and must never become
 * `jobUrl`. Response shape per the ReliefWeb v1 API (`data[].{id, href, fields}`).
 */
import 'reflect-metadata';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, post: jest.fn(), setHeaders: jest.fn() })),
  };
});

import { ReliefWebService } from '../src/reliefweb.service';

function entry(id: string, url?: string): any {
  return {
    id,
    score: 1,
    href: `https://api.reliefweb.int/v1/jobs/${id}`,
    fields: {
      title: `Role ${id}`,
      ...(url ? { url } : {}),
      source: [{ name: 'UNICEF' }],
      country: [{ name: 'Kenya' }],
      date: { created: '2026-09-20T00:00:00+00:00' },
    },
  };
}

async function scrape(entries: any[]) {
  mockGet.mockReset();
  mockGet.mockResolvedValueOnce({ data: { href: 'x', count: entries.length, totalCount: entries.length, data: entries } });
  return new ReliefWebService().scrape({ siteType: [Site.RELIEFWEB], resultsWanted: 10 } as ScraperInputDto);
}

describe('ReliefWebService — job links (Spec 1751)', () => {
  it('keeps the public fields.url', async () => {
    const result = await scrape([entry('4012345', 'https://reliefweb.int/job/4012345/programme-officer')]);
    expect(result.jobs[0].jobUrl).toBe('https://reliefweb.int/job/4012345/programme-officer');
  });

  it('never falls back to the API href; links the public node page instead', async () => {
    const result = await scrape([entry('4012346')]);
    expect(result.jobs[0].jobUrl).toBe('https://reliefweb.int/node/4012346');
    expect(result.jobs[0].jobUrl).not.toContain('api.reliefweb.int');
  });

  it('refuses an API-shaped fields.url', async () => {
    const result = await scrape([entry('4012347', 'https://api.reliefweb.int/v1/jobs/4012347')]);
    expect(result.jobs[0].jobUrl).toBe('https://reliefweb.int/node/4012347');
  });
});
