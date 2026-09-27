/**
 * ReliefWeb link mapping (Specs 1751, 1752): each API entry's `href` is its API
 * resource (`https://api.reliefweb.int/v2/jobs/<id>`) and must never become
 * `jobUrl`. Response shape per the ReliefWeb API v2 (`data[].{id, href, fields}`,
 * https://apidoc.reliefweb.int/fields-tables): `url_alias` is the friendly page,
 * `url` the canonical one.
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

function entry(id: string, links: { url?: string; url_alias?: string } = {}): any {
  return {
    id,
    score: 1,
    href: `https://api.reliefweb.int/v2/jobs/${id}`,
    fields: {
      title: `Role ${id}`,
      ...links,
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

describe('ReliefWebService — job links (Specs 1751, 1752)', () => {
  it('prefers the friendly url_alias page over the canonical url', async () => {
    const result = await scrape([
      entry('4231248', {
        url: 'https://reliefweb.int/node/4231248',
        url_alias: 'https://reliefweb.int/job/4231248/full-stack-software-developer',
      }),
    ]);
    expect(result.jobs[0].jobUrl).toBe('https://reliefweb.int/job/4231248/full-stack-software-developer');
  });

  it('keeps the public canonical url when there is no url_alias', async () => {
    const result = await scrape([entry('4012345', { url: 'https://reliefweb.int/job/4012345/programme-officer' })]);
    expect(result.jobs[0].jobUrl).toBe('https://reliefweb.int/job/4012345/programme-officer');
  });

  it('never falls back to the API href; links the public node page instead', async () => {
    const result = await scrape([entry('4012346')]);
    expect(result.jobs[0].jobUrl).toBe('https://reliefweb.int/node/4012346');
    expect(result.jobs[0].jobUrl).not.toContain('api.reliefweb.int');
  });

  it('refuses API-shaped url / url_alias values', async () => {
    const result = await scrape([
      entry('4012347', {
        url: 'https://api.reliefweb.int/v2/jobs/4012347',
        url_alias: 'https://api.reliefweb.int/v2/jobs/4012347',
      }),
    ]);
    expect(result.jobs[0].jobUrl).toBe('https://reliefweb.int/node/4012347');
  });
});
