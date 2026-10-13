import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const indexHtml = readFileSync(join(__dirname, 'fixtures', 'careers.html'), 'utf8');
const tubeLaserHtml = readFileSync(
  join(__dirname, 'fixtures', 'detail-tube-laser-operator.html'),
  'utf8',
);
const pressBrakeHtml = readFileSync(
  join(__dirname, 'fixtures', 'detail-cnc-press-brake-operator.html'),
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

import { WercoMfgService } from '../src/wercomfg.service';

/** Route the index + detail fetches to their fixtures by URL. */
function respondWithSite(detailHtmlBySlug: Record<string, string>): void {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/careers/')) {
      const slug = url.split('/careers/')[1]?.replace(/\/+$/, '');
      const html = detailHtmlBySlug[slug];
      if (!html) return Promise.reject(new Error(`unstubbed detail ${url}`));
      return Promise.resolve({ data: html });
    }
    return Promise.resolve({ data: indexHtml });
  });
}

const ALL_DETAILS = {
  'tube-laser-operator': tubeLaserHtml,
  'cnc-press-brake-operator': pressBrakeHtml,
  'fitter-welder': tubeLaserHtml,
  'general-shop-assistant': tubeLaserHtml,
  'general-shop-assistant-2nd': tubeLaserHtml,
  'laser-operator-1st': tubeLaserHtml,
  'laser-operator-2nd': tubeLaserHtml,
  'plate-roll-operator': tubeLaserHtml,
  'production-scheduler': tubeLaserHtml,
  'sandblaster': tubeLaserHtml,
  'shipping-receiving': tubeLaserHtml,
};

describe('WercoMfgService', () => {
  let service: WercoMfgService;

  beforeEach(() => {
    getMock.mockReset();
    service = new WercoMfgService();
  });

  it('scrapes every detail link on the careers index', async () => {
    respondWithSite(ALL_DETAILS);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(11);
    expect(res.diagnostics).toBeUndefined();
    for (const job of res.jobs) {
      expect(job.site).toBe(Site.WERCOMFG);
      expect(job.atsType).toBe('wercomfg');
      expect(job.companyName).toBe('Werco Manufacturing');
      expect(job.applyUrl).toBe('mailto:info@wercomfg.com');
      expect(job.jobUrl).toContain('https://www.wercomfg.com/careers/');
    }
  });

  it('maps JSON-LD fields: title, datePosted, type, location', async () => {
    respondWithSite(ALL_DETAILS);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    const job = res.jobs.find((j) => j.atsId === 'cnc-press-brake-operator');
    expect(job).toBeDefined();
    expect(job!.title).toBe('CNC Press Brake Operator');
    expect(job!.id).toBe('wercomfg-cnc-press-brake-operator');
    expect(String(job!.datePosted)).toContain('2026-03-15');
    expect(job!.employmentType).toBe('FULL_TIME');
    expect(job!.location?.city).toBe('Broken Arrow');
    expect(job!.location?.state).toBe('OK');
  });

  it('emits the JSON-LD description plus published extras', async () => {
    respondWithSite(ALL_DETAILS);
    const res = await service.scrape(new ScraperInputDto({}));
    const job = res.jobs.find((j) => j.atsId === 'tube-laser-operator');
    expect(job!.description).toContain('tube laser cutting equipment');
    expect(job!.description).toContain('Industry: Manufacturing');
    expect(job!.description).toContain('Shift: 1st Shift');
  });

  it('tolerates a detail fetch failure', async () => {
    const details = { ...ALL_DETAILS };
    delete (details as Record<string, string>)['sandblaster'];
    getMock.mockImplementation((url: string) => {
      if (url.includes('sandblaster')) return Promise.reject(new Error('socket hangup'));
      if (url.includes('/careers/')) {
        const slug = url.split('/careers/')[1]?.replace(/\/+$/, '');
        return Promise.resolve({ data: (details as Record<string, string>)[slug] });
      }
      return Promise.resolve({ data: indexHtml });
    });
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(10);
    expect(res.diagnostics).toBeUndefined();
  });

  it('returns empty diagnostics when the index has no detail links', async () => {
    getMock.mockResolvedValue({ data: '<html><body><p>nothing here</p></body></html>' });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('maps an index fetch failure to classified diagnostics', async () => {
    getMock.mockRejectedValue(new Error('socket hangup'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
  });

  it('applies searchTerm / offset / resultsWanted', async () => {
    respondWithSite(ALL_DETAILS);
    const res = await service.scrape(
      new ScraperInputDto({ searchTerm: 'press brake', resultsWanted: 9999 }),
    );
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].atsId).toBe('cnc-press-brake-operator');

    const paged = await service.scrape(
      new ScraperInputDto({ resultsWanted: 2, offset: 1 }),
    );
    expect(paged.jobs).toHaveLength(2);
  });

  it('honours a companyUrl override for the index fetch', async () => {
    respondWithSite(ALL_DETAILS);
    await service.scrape(
      new ScraperInputDto({ companyUrl: 'https://wercomfg.com/careers' }),
    );
    expect(getMock).toHaveBeenCalledWith('https://wercomfg.com/careers');
  });
});
