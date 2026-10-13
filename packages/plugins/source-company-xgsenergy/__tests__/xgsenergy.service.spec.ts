import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const careersHtml = readFileSync(join(__dirname, 'fixtures', 'careers.html'), 'utf8');

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { XgsEnergyService } from '../src/xgsenergy.service';

function live(): void {
  getMock.mockReset();
  getMock.mockResolvedValue({ data: careersHtml });
}

describe('XgsEnergyService', () => {
  let service: XgsEnergyService;

  beforeEach(() => {
    getMock.mockReset();
    service = new XgsEnergyService();
  });

  it('maps every accordion item to a job', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(7);
    expect(res.diagnostics).toBeUndefined();

    const ee = res.jobs.find((j) => j.title.startsWith('Senior Electrical Engineer'));
    expect(ee).toBeDefined();
    expect(ee!.id).toBe(
      'xgsenergy-senior-electrical-engineer-power-generation-grid-interconnection-and-substations',
    );
    expect(ee!.site).toBe(Site.XGSENERGY);
    expect(ee!.atsType).toBe('xgsenergy');
    expect(ee!.companyName).toBe('XGS Energy');
    expect(ee!.location?.city).toBe('Houston');
    expect(ee!.location?.state).toBe('TX');
  });

  it('issues a single static GET of the careers page', async () => {
    live();
    await service.scrape(new ScraperInputDto({}));
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith('https://www.xgsenergy.com/careers/');
  });

  it('splits multi-site locations into locations[]', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    const sa = res.jobs.find((j) => j.title === 'Strategy Associate');
    expect(sa).toBeDefined();
    const cities = sa!.locations!.map((l) => `${l.city}, ${l.state}`);
    expect(cities).toEqual(['Seattle, WA', 'Austin, TX', 'Houston, TX']);
    expect(sa!.location?.city).toBe('Seattle');
  });

  it('treats a Hybrid fragment as work mode, not location', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    const geo = res.jobs.find((j) => j.title === 'Operational Geologist');
    expect(geo).toBeDefined();
    expect(geo!.workFromHomeType).toBe('Hybrid');
    const cities = geo!.locations!.map((l) => `${l.city}, ${l.state}`);
    expect(cities).toEqual(['Houston, TX']);
  });

  it('anchors jobUrl to the accordion tab id', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    for (const job of res.jobs) {
      expect(job.jobUrl).toMatch(
        /^https:\/\/www\.xgsenergy\.com\/careers\/#elementor-tab-title-\d+$/,
      );
      expect(job.jobUrlDirect).toBe(job.jobUrl);
    }
  });

  it('decodes the Cloudflare-protected apply mailto', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    for (const job of res.jobs) {
      expect(job.applyUrl).toBe('mailto:info@xgsenergy.com');
    }
  });

  it('carries the full posting body as description', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    const ee = res.jobs.find((j) => j.title.startsWith('Senior Electrical Engineer'))!;
    expect(ee.description).toContain('Position Overview');
    expect(ee.description).toContain('Responsibilities');
    expect(ee.description!.length).toBeGreaterThan(500);
  });

  it('returns an empty diagnostic when no accordion items exist', async () => {
    getMock.mockResolvedValue({ data: '<html><body>empty</body></html>' });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns a classified diagnostic when the fetch throws', async () => {
    getMock.mockRejectedValue(new Error('ECONNRESET'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBeDefined();
  });

  it('honours searchTerm, location, and resultsWanted filters', async () => {
    live();
    const res = await service.scrape(
      new ScraperInputDto({ searchTerm: 'Integrated Thermal Systems' }),
    );
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Sr. Integrated Thermal Systems Engineer');

    live();
    const loc = await service.scrape(new ScraperInputDto({ location: 'seattle' }));
    expect(loc.jobs).toHaveLength(1);
    expect(loc.jobs[0].title).toBe('Strategy Associate');

    live();
    const limited = await service.scrape(
      new ScraperInputDto({ resultsWanted: 2, offset: 5 }),
    );
    expect(limited.jobs).toHaveLength(2);
    expect(limited.jobs[0].title).toBe('Drilling Engineer');
  });
});
