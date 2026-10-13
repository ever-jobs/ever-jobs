import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const careersHtml = readFileSync(join(__dirname, 'fixtures', 'careers.html'), 'utf8');
const bundleJs = readFileSync(join(__dirname, 'fixtures', 'index.js'), 'utf8');

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { ThoronUsService } from '../src/thoron-us.service';

function respond(): void {
  getMock
    .mockResolvedValueOnce({ data: careersHtml })
    .mockResolvedValueOnce({ data: bundleJs });
}

describe('ThoronUsService', () => {
  let service: ThoronUsService;

  beforeEach(() => {
    getMock.mockReset();
    service = new ThoronUsService();
  });

  it('maps every entry in the embedded jobs array', async () => {
    respond();
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(3);
    expect(res.diagnostics).toBeUndefined();
    const titles = res.jobs.map((j) => j.title).sort();
    expect(titles).toEqual([
      'Full-Stack Hardware Engineer',
      'PCB Designer',
      'Senior Mechanical Engineer - Electronics Packaging',
    ]);
    for (const job of res.jobs) {
      expect(job.site).toBe(Site.THORON_US);
      expect(job.atsType).toBe('thoron_us');
      expect(job.companyName).toBe('Thoron');
      expect(job.department).toBe('Engineering');
      expect(job.location?.city).toBe('Seattle');
      expect(job.location?.state).toBe('WA');
      expect(job.jobUrl).toBe('https://www.thoron.us/careers');
      expect(job.jobUrlDirect).toBe('https://www.thoron.us/careers');
      expect(job.applyUrl).toBe('https://www.thoron.us/careers');
    }
  });

  it('keys roles by their native numeric id', async () => {
    respond();
    const res = await service.scrape(new ScraperInputDto({}));
    const pcb = res.jobs.find((j) => j.title === 'PCB Designer');
    expect(pcb!.id).toBe('thoron_us-1');
    expect(pcb!.atsId).toBe('1');
  });

  it('maps type and composes descriptions from the three sections', async () => {
    respond();
    const res = await service.scrape(new ScraperInputDto({}));
    const pcb = res.jobs.find((j) => j.title === 'PCB Designer');
    expect(pcb!.employmentType).toBe('Full or Part Time');
    expect(pcb!.description).toContain('Perform detailed layout for PCBs');
    expect(pcb!.description).toContain('What you bring:');
    expect(pcb!.description).toContain('- You thrive in fast paced environments');
    expect(pcb!.description).toContain('Nice to have:');
    const mech = res.jobs.find((j) => j.title === 'Senior Mechanical Engineer - Electronics Packaging');
    expect(mech!.employmentType).toBe('Full Time');
  });

  it('fetches the shell then the referenced bundle', async () => {
    respond();
    await service.scrape(new ScraperInputDto({}));
    expect(getMock).toHaveBeenNthCalledWith(1, 'https://www.thoron.us/careers');
    expect(getMock).toHaveBeenNthCalledWith(
      2,
      'https://www.thoron.us/assets/index-CQn35CTl.js',
    );
  });

  it('ignores bundle arrays that lack the job-entry field run', async () => {
    const fake = `const x=[{id:1,title:"Not a job",name:"distractor"}];`;
    getMock
      .mockResolvedValueOnce({ data: careersHtml })
      .mockResolvedValueOnce({ data: fake });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns empty diagnostics when the shell has no bundle link', async () => {
    getMock.mockResolvedValueOnce({ data: '<html><body></body></html>' });
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
    respond();
    const res = await service.scrape(
      new ScraperInputDto({ searchTerm: 'full-stack', resultsWanted: 9999 }),
    );
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Full-Stack Hardware Engineer');

    respond();
    const located = await service.scrape(
      new ScraperInputDto({ location: 'seattle', resultsWanted: 9999 }),
    );
    expect(located.jobs).toHaveLength(3);

    respond();
    const paged = await service.scrape(
      new ScraperInputDto({ resultsWanted: 1, offset: 1 }),
    );
    expect(paged.jobs).toHaveLength(1);
  });
});
