/**
 * Ceipal link mapping (Spec 1751): `apply_job`, then the caller's career
 * portal, then the syndication pages; the JSON detail resource
 * (`https://api.ceipal.com/{key}/job-postings/{id}/`) is only a last resort
 * (Q-110), and `applyUrl` is never that API URL.
 */
import 'reflect-metadata';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, post: jest.fn(), setHeaders: jest.fn() })),
    randomSleep: jest.fn(() => Promise.resolve()),
  };
});

import { CeipalService } from '../src/ceipal.service';

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function row(id: number, extra: Record<string, unknown> = {}): any {
  return { id, position_title: `Role ${id}`, public_job_desc: '<p>Body</p>', city: 'Austin', ...extra };
}

async function scrape(rows: any[], companyUrl?: string) {
  mockGet.mockReset();
  mockGet.mockResolvedValueOnce({
    data: { status: 1, success: 1, count: rows.length, num_pages: 1, page_number: 1, results: rows },
  });
  return new CeipalService().scrape({
    siteType: [Site.CEIPAL],
    companySlug: KEY,
    resultsWanted: 10,
    ...(companyUrl ? { companyUrl } : {}),
  } as ScraperInputDto);
}

describe('CeipalService — job links (Spec 1751)', () => {
  it('keeps the portal apply_job', async () => {
    const result = await scrape([row(1, { apply_job: 'https://joblist.acme.com/#/job/1' })]);
    expect(result.jobs[0].jobUrl).toBe('https://joblist.acme.com/#/job/1');
    expect(result.jobs[0].applyUrl).toBe('https://joblist.acme.com/#/job/1');
  });

  it('uses the caller portal before the syndication links and the API', async () => {
    const result = await scrape(
      [row(2, { apply_job_indeed: 'https://www.indeed.com/viewjob?jk=2' })],
      'https://joblist.acme.com/',
    );
    expect(result.jobs[0].jobUrl).toBe('https://joblist.acme.com/');
  });

  it('uses a syndication page when no portal is known', async () => {
    const result = await scrape([row(3, { apply_job_monster: 'https://www.monster.com/job-openings/3' })]);
    expect(result.jobs[0].jobUrl).toBe('https://www.monster.com/job-openings/3');
  });

  it('never takes an api.ceipal.com companyUrl as the portal', async () => {
    const result = await scrape([row(4)], `https://api.ceipal.com/${KEY}/job-postings/`);
    expect(result.jobs[0].jobUrl).toBe(`https://api.ceipal.com/${KEY}/job-postings/4/`);
    expect(result.jobs[0].applyUrl ?? null).toBeNull();
  });

  it('documents the last resort when nothing public is known, with no API applyUrl (Q-110)', async () => {
    const result = await scrape([row(5)]);
    expect(result.jobs[0].jobUrl).toBe(`https://api.ceipal.com/${KEY}/job-postings/5/`);
    expect(result.jobs[0].applyUrl ?? null).toBeNull();
  });
});
