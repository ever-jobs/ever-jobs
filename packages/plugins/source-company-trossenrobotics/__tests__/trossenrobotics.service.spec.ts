import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import { BrowserPool } from '@ever-jobs/common';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';
import { TrossenroboticsService } from '../src/trossenrobotics.service';

describe('TrossenroboticsService', () => {
  let service: TrossenroboticsService;

  const fixturesDir = path.join(__dirname, 'fixtures');
  const listHtml = fs.readFileSync(path.join(fixturesDir, 'list.html'), 'utf-8');
  const salespersonHtml = fs.readFileSync(
    path.join(fixturesDir, 'salesperson.html'),
    'utf-8',
  );
  const internHtml = fs.readFileSync(
    path.join(fixturesDir, 'mechanical-engineer-intern.html'),
    'utf-8',
  );
  const assemblyHtml = fs.readFileSync(
    path.join(fixturesDir, 'assembly-production.html'),
    'utf-8',
  );

  function makeFetchHtmlMock() {
    return jest.fn(async (url: string) => {
      if (url.includes('/careers') && url.includes('/salesperson')) {
        return salespersonHtml;
      }
      if (url.includes('/careers') && url.includes('/mechanical-engineer-intern')) {
        return internHtml;
      }
      if (url.includes('/careers') && url.includes('/assembly-production')) {
        return assemblyHtml;
      }
      return listHtml;
    });
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TrossenroboticsService],
    }).compile();
    service = module.get<TrossenroboticsService>(TrossenroboticsService);

    jest.spyOn(BrowserPool, 'getPage').mockResolvedValue({
      goto: jest.fn().mockResolvedValue(undefined),
      content: jest.fn().mockResolvedValue(''),
      close: jest.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('scrapes all jobs from list and detail pages', async () => {
    (service as any).fetchHtml = makeFetchHtmlMock();

    const result = await service.scrape(
      new ScraperInputDto({ companyDomain: ['trossenrobotics.com'] }),
    );

    expect(result.jobs).toHaveLength(3);

    const [sales, intern, assembly] = result.jobs;

    expect(sales.id).toBe('trossenrobotics-careers-salesperson');
    expect(sales.site).toBe(Site.TROSSENROBOTICS);
    expect(sales.title).toBe('Sales Development Representative');
    expect(sales.companyName).toBe('Trossen Robotics');
    expect(sales.jobUrl).toBe(
      'https://www.trossenrobotics.com/careers/salesperson',
    );
    expect(sales.jobType).toEqual([JobType.FULL_TIME]);
    expect(sales.isRemote).toBe(false);
    expect(sales.workFromHomeType).toBe('On Site');
    expect(sales.datePosted).toEqual(new Date(2025, 5, 12));
    expect(sales.description).toContain('What You\'ll Do:');
    expect(sales.description).toContain('Generate pipeline');
    expect(sales.description).not.toContain('First name');

    expect(intern.id).toBe('trossenrobotics-careers-mechanical-engineer-intern');
    expect(intern.title).toBe('Mechanical Engineer Intern');
    expect(intern.jobType).toContain(JobType.FULL_TIME);
    expect(intern.jobType).toContain(JobType.INTERNSHIP);
    expect(intern.datePosted).toBeNull();
    expect(intern.description).toContain('CAD modeling');

    expect(assembly.id).toBe('trossenrobotics-careers-assembly-production');
    expect(assembly.title).toBe('Robot Kit Assembly & Production');
    expect(assembly.jobType).toEqual(
      expect.arrayContaining([JobType.FULL_TIME, JobType.PART_TIME]),
    );
    expect(assembly.employmentType).toBe('Full Time & Part Time');
  });

  it('filters by searchTerm', async () => {
    (service as any).fetchHtml = makeFetchHtmlMock();

    const result = await service.scrape(
      new ScraperInputDto({
        companyDomain: ['trossenrobotics.com'],
        searchTerm: 'mechanical',
      }),
    );

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe(
      'trossenrobotics-careers-mechanical-engineer-intern',
    );
  });

  it('filters by description searchTerm', async () => {
    (service as any).fetchHtml = makeFetchHtmlMock();

    const result = await service.scrape(
      new ScraperInputDto({
        companyDomain: ['trossenrobotics.com'],
        searchTerm: 'CAD',
      }),
    );

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe(
      'trossenrobotics-careers-mechanical-engineer-intern',
    );
  });

  it('filters by jobType', async () => {
    (service as any).fetchHtml = makeFetchHtmlMock();

    const internshipResult = await service.scrape(
      new ScraperInputDto({
        companyDomain: ['trossenrobotics.com'],
        jobType: JobType.INTERNSHIP,
      }),
    );
    expect(internshipResult.jobs).toHaveLength(1);
    expect(internshipResult.jobs[0].title).toBe('Mechanical Engineer Intern');

    const partTimeResult = await service.scrape(
      new ScraperInputDto({
        companyDomain: ['trossenrobotics.com'],
        jobType: JobType.PART_TIME,
      }),
    );
    expect(partTimeResult.jobs).toHaveLength(1);
    expect(partTimeResult.jobs[0].title).toBe('Robot Kit Assembly & Production');
  });

  it('filters by isRemote', async () => {
    (service as any).fetchHtml = makeFetchHtmlMock();

    const result = await service.scrape(
      new ScraperInputDto({
        companyDomain: ['trossenrobotics.com'],
        isRemote: true,
      }),
    );

    expect(result.jobs).toHaveLength(0);
  });

  it('filters by location', async () => {
    (service as any).fetchHtml = makeFetchHtmlMock();

    const result = await service.scrape(
      new ScraperInputDto({
        companyDomain: ['trossenrobotics.com'],
        location: 'Remote',
      }),
    );

    expect(result.jobs).toHaveLength(0);
  });

  it('applies resultsWanted and offset', async () => {
    (service as any).fetchHtml = makeFetchHtmlMock();

    const result = await service.scrape(
      new ScraperInputDto({
        companyDomain: ['trossenrobotics.com'],
        resultsWanted: 1,
        offset: 1,
      }),
    );

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe(
      'trossenrobotics-careers-mechanical-engineer-intern',
    );
  });

  it('returns an empty list for an empty list page', async () => {
    (service as any).fetchHtml = jest.fn(
      async () =>
        '<html><body><main><section>No openings</section></main></body></html>',
    );

    const result = await service.scrape(
      new ScraperInputDto({ companyDomain: ['trossenrobotics.com'] }),
    );

    expect(result.jobs).toHaveLength(0);
  });
});
