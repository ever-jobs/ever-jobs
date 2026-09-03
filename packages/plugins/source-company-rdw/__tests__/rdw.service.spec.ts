import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import { BrowserPool } from '@ever-jobs/common';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';
import { RdwService } from '../src/rdw.service';

describe('RdwService', () => {
  let service: RdwService;

  const fixturesDir = path.join(__dirname, 'fixtures');
  const searchHtml = fs.readFileSync(
    path.join(fixturesDir, 'search.html'),
    'utf-8',
  );
  const detail1Html = fs.readFileSync(
    path.join(fixturesDir, 'detail1.html'),
    'utf-8',
  );
  const detail2Html = fs.readFileSync(
    path.join(fixturesDir, 'detail2.html'),
    'utf-8',
  );

  function makeFetchHtmlMock() {
    return jest.fn(async (url: string) => {
      if (url.includes('/jobs/search')) return searchHtml;
      if (url.includes('temporary-instructional-designer')) return detail1Html;
      if (url.includes('contract-assembly-technician')) return detail2Html;
      return '<html></html>';
    });
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RdwService],
    }).compile();
    service = module.get<RdwService>(RdwService);

    jest.spyOn(BrowserPool, 'getPage').mockResolvedValue({
      goto: jest.fn().mockResolvedValue(undefined),
      content: jest.fn().mockResolvedValue(''),
      close: jest.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('scrapes all jobs from search and detail pages', async () => {
    (service as any).fetchHtml = makeFetchHtmlMock();

    const result = await service.scrape(
      new ScraperInputDto({ companyDomain: ['rdw.com'] }),
    );

    expect(result.jobs).toHaveLength(2);

    const [first, second] = result.jobs;

    expect(first.id).toBe('rdw-3168');
    expect(first.site).toBe(Site.RDW);
    expect(first.title).toBe('Instructional Designer');
    expect(first.companyName).toBe('Redwire Corporation');
    expect(first.jobType).toEqual([JobType.TEMPORARY]);
    expect(first.isRemote).toBe(true);
    expect(first.workFromHomeType).toBe('Remote');
    expect(first.location?.city).toBe('Remote');
    expect(first.location?.country).toBe('US');
    expect(first.department).toBe('Human Resources');
    expect(first.atsId).toBe('3168');

    expect(second.id).toBe('rdw-3132');
    expect(second.title).toBe('Assembly Technician, level 4');
    expect(second.jobType).toEqual([JobType.CONTRACT]);
    expect(second.isRemote).toBe(false);
    expect(second.workFromHomeType).toBe('On Site');
    expect(second.location?.city).toBe('Marlborough');
    expect(second.location?.state).toBe('MA');
    expect(second.location?.country).toBe('United States');
    expect(second.department).toBe('Operations');
  });

  it('filters by searchTerm and location', async () => {
    (service as any).fetchHtml = makeFetchHtmlMock();

    const termResult = await service.scrape(
      new ScraperInputDto({
        companyDomain: ['rdw.com'],
        searchTerm: 'hardware',
      }),
    );
    expect(termResult.jobs).toHaveLength(1);
    expect(termResult.jobs[0].id).toBe('rdw-3132');

    const locationResult = await service.scrape(
      new ScraperInputDto({
        companyDomain: ['rdw.com'],
        location: 'Marlborough',
      }),
    );
    expect(locationResult.jobs).toHaveLength(1);
    expect(locationResult.jobs[0].id).toBe('rdw-3132');
  });

  it('returns an empty list for an empty search page', async () => {
    (service as any).fetchHtml = jest.fn(
      async () =>
        '<html><body><div aria-label="Jobs search results"></div></body></html>',
    );
    const result = await service.scrape(
      new ScraperInputDto({ companyDomain: ['rdw.com'] }),
    );
    expect(result.jobs).toHaveLength(0);
  });
});
