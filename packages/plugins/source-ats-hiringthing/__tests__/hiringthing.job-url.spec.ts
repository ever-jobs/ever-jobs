/**
 * HiringThing link mapping (Spec 1751): the posting's public `url` first, then
 * the caller's careers page; the api-host link is only a last resort (Q-110).
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

import { HiringThingService } from '../src/hiringthing.service';

function job(id: number, url: string | null): any {
  return {
    id,
    title: `Role ${id}`,
    description: '<p>Body</p>',
    location: 'Austin, TX',
    department: 'Ops',
    type: 'Full-time',
    created_at: '2026-09-20T00:00:00Z',
    url,
    company_name: 'Acme',
    status: 'open',
    salary: null,
    experience: null,
  };
}

async function scrape(jobs: any[], companyUrl?: string) {
  mockGet.mockReset();
  mockGet.mockResolvedValueOnce({ data: { jobs } });
  return new HiringThingService().scrape({
    siteType: [Site.HIRINGTHING],
    resultsWanted: 10,
    auth: { hiringThing: { apiKey: 'k' } } as any,
    ...(companyUrl ? { companyUrl } : {}),
  } as ScraperInputDto);
}

describe('HiringThingService — job links (Spec 1751)', () => {
  it('keeps the posting public url', async () => {
    const result = await scrape([job(1, 'https://acme.hiringthing.com/job/1/role-1')]);
    expect(result.jobs[0].jobUrl).toBe('https://acme.hiringthing.com/job/1/role-1');
  });

  it('prefers the caller careers page over the api-host fallback', async () => {
    const result = await scrape([job(2, null)], 'https://careers.acme.com/');
    expect(result.jobs[0].jobUrl).toBe('https://careers.acme.com/');
  });

  it('refuses an API-shaped url and uses the careers page', async () => {
    const result = await scrape([job(3, 'https://api.hiringthing.com/api/v1/jobs/3')], 'https://careers.acme.com/');
    expect(result.jobs[0].jobUrl).toBe('https://careers.acme.com/');
  });

  it('documents the last resort when nothing public is known (Q-110)', async () => {
    const result = await scrape([job(4, null)]);
    expect(result.jobs[0].jobUrl).toBe('https://api.hiringthing.com/jobs/4');
  });
});
