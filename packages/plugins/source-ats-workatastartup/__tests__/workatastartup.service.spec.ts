import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CompensationInterval,
  DescriptionFormat,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: mockSetHeaders,
    })),
  };
});

import { WorkAtAStartupService } from '../src/workatastartup.service';

const FIX = join(__dirname, 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIX, name), 'utf-8');

/** Route the mocked GET to a fixture body by URL substring/regex (in order). */
function route(map: Array<[string | RegExp, string | Error]>) {
  mockGet.mockImplementation((url: string) => {
    for (const [matcher, value] of map) {
      const hit =
        typeof matcher === 'string' ? url.includes(matcher) : matcher.test(url);
      if (hit) {
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve({ data: value });
      }
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return {
    companySlug: 'diode-computers-inc',
    siteType: [Site.WORKATASTARTUP],
    resultsWanted: 100,
    ...overrides,
  } as ScraperInputDto;
}

function diodeRoutes(): Array<[string | RegExp, string | Error]> {
  return [
    ['/jobs/UAUsCJS', fixture('detail-diode-staff.html')],
    ['/jobs/V8LqvBH', fixture('detail-diode-senior.html')],
    ['/companies/diode-computers-inc/jobs', fixture('list-diode.html')],
  ];
}

describe('WorkAtAStartupService', () => {
  let service: WorkAtAStartupService;

  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    service = new WorkAtAStartupService();
  });

  it('returns no jobs (and makes no request) without a companySlug', async () => {
    const res = await service.scrape(input({ companySlug: undefined }));
    expect(res.jobs).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('parses the Inertia list spine into jobs with ATS metadata and URLs', async () => {
    route(diodeRoutes());
    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(2);
    for (const job of res.jobs) {
      expect(job.site).toBe(Site.WORKATASTARTUP);
      expect(job.atsType).toBe('workatastartup');
      expect(job.companyName).toBe('Diode Computers, Inc.');
      // companyUrl is the canonical workatastartup.com board (no /jobs suffix).
      expect(job.companyUrl).toBe(
        'https://www.workatastartup.com/companies/diode-computers-inc',
      );
      // jobUrl is the public YC mirror detail page.
      expect(job.jobUrl).toMatch(
        /^https:\/\/www\.ycombinator\.com\/companies\/diode-computers-inc\/jobs\//,
      );
    }

    const staff = res.jobs.find((j) => j.atsId === '84722');
    expect(staff?.id).toBe('workatastartup-84722');
    expect(staff?.title).toBe('Staff Electrical Engineer');
    expect(staff?.jobFunction).toBe('Engineering');
    expect(staff?.applyUrl).toContain('account.ycombinator.com');
  });

  it('overlays ld+json datePosted, employmentType, and jobType', async () => {
    route(diodeRoutes());
    const res = await service.scrape(input());

    const staff = res.jobs.find((j) => j.atsId === '84722');
    expect(staff?.datePosted).toBe('2025-11-05');
    expect(staff?.employmentType).toBe('FULL_TIME');
    expect(staff?.jobType).toEqual([JobType.FULL_TIME]);
  });

  it('uses the structured ld+json baseSalary as a min/max yearly range', async () => {
    route(diodeRoutes());
    const res = await service.scrape(input());

    const staff = res.jobs.find((j) => j.atsId === '84722');
    expect(staff?.compensation?.minAmount).toBe(140000);
    expect(staff?.compensation?.maxAmount).toBe(200000);
    expect(staff?.compensation?.interval).toBe(CompensationInterval.YEARLY);
    expect(staff?.salarySource).toBe('structured');
  });

  it('maps the single ld+json jobLocation', async () => {
    route(diodeRoutes());
    const res = await service.scrape(input());
    const staff = res.jobs.find((j) => j.atsId === '84722');
    expect(staff?.location?.city).toBe('New York');
    expect(staff?.location?.country).toBe('United States');
    expect(staff?.isRemote).toBeFalsy();
  });

  it('fetches one detail page per wanted job', async () => {
    route(diodeRoutes());
    await service.scrape(input());
    // 1 list + 2 details
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('respects the requested description format', async () => {
    route(diodeRoutes());

    const html = (
      await service.scrape(input({ descriptionFormat: DescriptionFormat.HTML }))
    ).jobs.find((j) => j.atsId === '84722');
    expect(html?.description).toMatch(/<\w+/);

    const plain = (
      await service.scrape(input({ descriptionFormat: DescriptionFormat.PLAIN }))
    ).jobs.find((j) => j.atsId === '84722');
    expect(plain?.description).not.toMatch(/<\w+/);
  });

  it('semicolon-joins a multi-location role from ld+json jobLocation', async () => {
    route([
      ['/jobs/7uV8QWw', fixture('detail-loombotic-software.html')],
      [/\/jobs\//, '<html></html>'],
      ['/companies/loombotic/jobs', fixture('list-loombotic.html')],
    ]);
    const res = await service.scrape(
      input({ companySlug: 'loombotic', resultsWanted: 6 }),
    );

    const software = res.jobs.find((j) => j.atsId === '95783');
    expect(software?.location?.city).toContain('Toronto');
    expect(software?.location?.city).toContain('Austin');
    expect(software?.location?.city).toContain(';');
  });

  it('falls back to list-only fields when the detail fetch fails', async () => {
    route([
      [/\/jobs\/[A-Za-z0-9]/, new Error('detail boom')],
      ['/companies/diode-computers-inc/jobs', fixture('list-diode.html')],
    ]);
    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(2);
    const staff = res.jobs.find((j) => j.atsId === '84722');
    // ld+json absent → no datePosted, but the list salaryRange text still parses.
    expect(staff?.title).toBe('Staff Electrical Engineer');
    expect(staff?.datePosted).toBeUndefined();
    expect(staff?.compensation?.minAmount).toBe(140000);
    expect(staff?.compensation?.maxAmount).toBe(200000);
    expect(staff?.salarySource).toBe('description');
  });

  it('caps results at resultsWanted', async () => {
    route([
      [/\/jobs\//, '<html></html>'],
      ['/companies/loombotic/jobs', fixture('list-loombotic.html')],
    ]);
    const res = await service.scrape(
      input({ companySlug: 'loombotic', resultsWanted: 3 }),
    );
    expect(res.jobs).toHaveLength(3);
  });

  it('returns no jobs when the list page has no jobPostings', async () => {
    route([['/companies/empty/jobs', '<html><body>nothing</body></html>']]);
    const res = await service.scrape(input({ companySlug: 'empty' }));
    expect(res.jobs).toHaveLength(0);
  });

  it('returns no jobs when the list fetch fails', async () => {
    route([[/.*/, new Error('boom')]]);
    const res = await service.scrape(input());
    expect(res.jobs).toHaveLength(0);
  });
});
