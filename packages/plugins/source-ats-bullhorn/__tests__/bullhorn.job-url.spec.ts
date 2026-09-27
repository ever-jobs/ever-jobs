/**
 * Bullhorn link mapping (Spec 1751): Bullhorn exposes no public posting page,
 * so the caller's careers page is the link when given; the REST entity URL is
 * only a last resort (Q-110).
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

import { BullhornService } from '../src/bullhorn.service';

const ORDER = {
  id: 501,
  title: 'Recruiter',
  publicDescription: '<p>Body</p>',
  address: { city: 'Boston', state: 'MA', country: 'US' },
  employmentType: 'Permanent',
  dateAdded: 1_758_000_000_000,
};

async function scrape(companyUrl?: string) {
  mockGet.mockReset();
  mockGet.mockResolvedValueOnce({ data: { data: [ORDER], total: 1, count: 1 } });
  const saved = process.env.BULLHORN_CORP_TOKEN;
  delete process.env.BULLHORN_CORP_TOKEN;
  try {
    return await new BullhornService().scrape({
      siteType: [Site.BULLHORN],
      companySlug: '91:abc123',
      resultsWanted: 10,
      ...(companyUrl ? { companyUrl } : {}),
    } as ScraperInputDto);
  } finally {
    if (saved !== undefined) process.env.BULLHORN_CORP_TOKEN = saved;
  }
}

describe('BullhornService — job links (Spec 1751)', () => {
  it('links the caller careers page instead of the REST entity', async () => {
    const result = await scrape('https://careers.acme.com/');
    expect(result.jobs[0].jobUrl).toBe('https://careers.acme.com/');
  });

  it('refuses an API-shaped companyUrl', async () => {
    const result = await scrape('https://public-rest91.bullhornstaffing.com/rest-services/abc123/search/JobOrder');
    expect(result.jobs[0].jobUrl).toBe(
      'https://public-rest91.bullhornstaffing.com/rest-services/abc123/entity/JobOrder/501',
    );
  });

  it('documents the last resort when nothing public is known (Q-110)', async () => {
    const result = await scrape();
    expect(result.jobs[0].jobUrl).toBe(
      'https://public-rest91.bullhornstaffing.com/rest-services/abc123/entity/JobOrder/501',
    );
  });
});
