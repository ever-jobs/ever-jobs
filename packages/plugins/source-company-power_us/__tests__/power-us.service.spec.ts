import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const careersJson = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'careers.json'), 'utf8'),
);

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { PowerUsService } from '../src/power-us.service';

function respondWith(payload: unknown): void {
  getMock.mockResolvedValue({ data: payload });
}

describe('PowerUsService', () => {
  let service: PowerUsService;

  beforeEach(() => {
    getMock.mockReset();
    service = new PowerUsService();
  });

  it('maps all 35 jobs from the careers API', async () => {
    respondWith(careersJson);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(35);
    expect(res.diagnostics).toBeUndefined();

    const power = res.jobs.find((j) => j.title === 'Power Electronics Engineer');
    expect(power).toBeDefined();
    expect(power!.id).toBe('power_us-4455744570');
    expect(power!.atsId).toBe('4455744570');
    expect(power!.site).toBe(Site.POWER_US);
    expect(power!.atsType).toBe('power_us');
    expect(power!.companyName).toBe('Powerus');
    expect(power!.jobUrl).toBe('https://www.linkedin.com/jobs/view/4455744570');
    expect(power!.department).toBe('Engineering');
    expect(power!.location?.city).toBe('Charlotte');
    expect(power!.jobType).toEqual(['fulltime']);
  });

  it('falls back to slug-from-title when linkedInUrl has no numeric id', async () => {
    respondWith([{ title: 'Test Role', department: 'Eng', location: 'Nowhere', type: 'Full-time' }]);
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs[0].id).toBe('power_us-test-role');
  });

  it('emits description sections when the fields are populated', async () => {
    respondWith([
      {
        title: 'Described Role',
        summary: 'Build things.',
        responsibilities: ['Design boards'],
        qualifications: ['BSEE'],
        preferredSkills: ['Altium'],
        linkedInUrl: 'https://www.linkedin.com/jobs/view/1',
      },
    ]);
    const res = await service.scrape(new ScraperInputDto({}));
    const desc = res.jobs[0].description!;
    expect(desc).toContain('Build things.');
    expect(desc).toContain('Responsibilities:');
    expect(desc).toContain('- Design boards');
    expect(desc).toContain('Qualifications:');
    expect(desc).toContain('Preferred skills:');
    expect(desc).toContain('- Altium');
  });

  it('omits description when the fields are empty (live shape)', async () => {
    respondWith(careersJson);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(35);
    expect(res.jobs.every((j) => !j.description)).toBe(true);
  });

  it('returns an empty diagnostic when the API returns no jobs', async () => {
    respondWith([]);
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns diagnostics when the fetch fails', async () => {
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
  });

  it('honors resultsWanted', async () => {
    respondWith(careersJson);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 5 }));
    expect(res.jobs).toHaveLength(5);
  });
});
