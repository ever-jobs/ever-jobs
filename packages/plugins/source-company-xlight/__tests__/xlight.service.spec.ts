import { readFileSync } from 'fs';
import { join } from 'path';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';

const careersHtml = readFileSync(
  join(__dirname, 'fixtures', 'careers.html'),
  'utf8',
);

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { XlightService } from '../src/xlight.service';

function respondWith(payload: unknown): void {
  getMock.mockResolvedValue({ data: payload });
}

describe('XlightService', () => {
  let service: XlightService;

  beforeEach(() => {
    getMock.mockReset();
    service = new XlightService();
  });

  it('maps every card on the careers list', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(22);
    expect(res.diagnostics).toBeUndefined();
    for (const job of res.jobs) {
      expect(job.site).toBe(Site.XLIGHT);
      expect(job.atsType).toBe('xlight');
      expect(job.companyName).toBe('xLight');
      expect(job.jobUrl).toBe('https://www.xlight.com/careers');
      expect(job.id).toMatch(/^xlight-/);
      expect(job.atsId).toBeTruthy();
    }
  });

  it('uses the LinkedIn posting id as the per-role key', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({}));
    const physicist = res.jobs.find((j) => j.title === 'Accelerator Physicist');
    expect(physicist).toBeDefined();
    expect(physicist!.id).toBe('xlight-4456253914');
    expect(physicist!.atsId).toBe('4456253914');
    expect(physicist!.applyUrl).toBe('https://www.linkedin.com/jobs/view/4456253914/');
    expect(physicist!.jobUrlDirect).toBe('https://www.linkedin.com/jobs/view/4456253914/');
  });

  it('splits the label line into department, type, work mode, location', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({}));
    const physicist = res.jobs.find((j) => j.title === 'Accelerator Physicist');
    expect(physicist!.department).toBe('Engineering');
    expect(physicist!.employmentType).toBe('Full Time');
    expect(physicist!.jobType).toContain(JobType.FULL_TIME);
    expect(physicist!.workFromHomeType).toBe('Remote');
    expect(physicist!.location?.country).toBe('United States');
  });

  it('parses hybrid + city locations', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({}));
    const rf = res.jobs.find((j) => j.title === 'High-Power RF Engineer');
    expect(rf!.workFromHomeType).toBe('Hybrid');
    expect(rf!.location?.city).toBe('Palo Alto');
    const construction = res.jobs.find((j) => j.title === 'Construction & Facilities Manager');
    expect(construction!.workFromHomeType).toBe('On Site');
    expect(construction!.location?.city).toBe('Albany');
    expect(construction!.location?.state).toBe('NY');
  });

  it('parses part-time roles', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({}));
    const erp = res.jobs.find((j) => j.title === 'ERP Implementation Lead (Part-Time)');
    expect(erp!.employmentType).toBe('Part Time');
    expect(erp!.jobType).toContain(JobType.PART_TIME);
  });

  it('honors an alternate companyUrl as the board page', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(
      new ScraperInputDto({ companyUrl: 'https://www.xlight.com/careers/' }),
    );
    expect(getMock).toHaveBeenCalledWith('https://www.xlight.com/careers/');
    expect(res.jobs[0].jobUrl).toBe('https://www.xlight.com/careers/');
  });

  it('returns empty diagnostics when no cards are present', async () => {
    respondWith('<html><body><div class="careers-list"></div></body></html>');
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('maps a fetch failure to classified diagnostics', async () => {
    getMock.mockRejectedValue(new Error('socket hangup'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
  });

  it('applies searchTerm / location / resultsWanted filters', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(
      new ScraperInputDto({ searchTerm: 'physicist', resultsWanted: 9999 }),
    );
    expect(res.jobs.length).toBeGreaterThan(0);
    expect(res.jobs.every((j) => j.title?.toLowerCase().includes('physicist'))).toBe(true);

    const remote = await service.scrape(
      new ScraperInputDto({ location: 'United States', resultsWanted: 9999 }),
    );
    expect(remote.jobs.every((j) => j.location?.country === 'United States')).toBe(true);

    const paged = await service.scrape(
      new ScraperInputDto({ resultsWanted: 5, offset: 5 }),
    );
    expect(paged.jobs).toHaveLength(5);
  });
});
