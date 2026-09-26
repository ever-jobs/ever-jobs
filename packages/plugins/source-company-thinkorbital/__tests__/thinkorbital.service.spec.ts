import * as fs from 'fs';
import * as path from 'path';
import { createHttpClient } from '@ever-jobs/common';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';
import { ThinkorbitalService } from '../src/thinkorbital.service';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(),
  };
});

const fixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'careers.html'),
  'utf8',
);

describe('ThinkorbitalService', () => {
  let service: ThinkorbitalService;
  let getMock: jest.Mock;

  beforeEach(() => {
    service = new ThinkorbitalService();
    getMock = jest.fn();
    (createHttpClient as jest.Mock).mockReturnValue({ get: getMock });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns the three visible jobs and ignores the hidden accordion entries', async () => {
    getMock.mockResolvedValueOnce({ data: fixture });

    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    expect(response.jobs).toHaveLength(3);
    const titles = response.jobs.map((job) => job.title);
    expect(titles).toContain('Assembly Integration and Test Engineer');
    expect(titles).toContain('Electrical Engineer');
    expect(titles).toContain('Lead Avionics Software Engineer');
    expect(titles).not.toContain('Senior Mechanical Engineer');
    expect(titles).not.toContain('Vice President of Government Affairs & Strategic Partnerships');
    expect(titles).not.toContain('Drone Software Engineer');
  });

  it('sets ThinkOrbital metadata and leaves applyUrl unset', async () => {
    getMock.mockResolvedValueOnce({ data: fixture });

    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    for (const job of response.jobs) {
      expect(job.site).toBe(Site.THINKORBITAL);
      expect(job.companyName).toBe('ThinkOrbital');
      expect(job.companyUrl).toBe('https://thinkorbital.com/careers/');
      expect(job.jobUrl).toBe('https://thinkorbital.com/careers/');
      expect(job.jobUrlDirect).toBe('https://thinkorbital.com/careers/');
      expect(job.applyUrl).toBeUndefined();
      expect(job.isRemote).toBe(false);
      expect(job.workFromHomeType).toBe('On Site');
      expect(job.jobType).toEqual([JobType.FULL_TIME]);
      expect(job.employmentType).toBe('Full-time');
    }
  });

  it('extracts Boulder, Colorado locations', async () => {
    getMock.mockResolvedValueOnce({ data: fixture });

    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    for (const job of response.jobs) {
      expect(job.location?.city).toBe('Boulder');
      expect(job.location?.state).toBe('CO');
      // Spec 1689: ThinkOrbital hires only in the US — the country default is restored.
      expect(job.location?.country).toBe('USA');
      expect(job.locations).toEqual([job.location]);
      expect(job.location?.displayLocation()).toMatch(/Boulder/);
    }
  });

  /** Spec 1689 — pre-5125 location data restored on top of the shared parser. */
  describe('location heuristics (THINKORBITAL_LOCATION_HEURISTICS)', () => {
    const saved = process.env.THINKORBITAL_LOCATION_HEURISTICS;
    const parse = (label: string) => (service as any).parseLocation(label);

    beforeEach(() => {
      delete process.env.THINKORBITAL_LOCATION_HEURISTICS;
    });

    afterAll(() => {
      if (saved === undefined) delete process.env.THINKORBITAL_LOCATION_HEURISTICS;
      else process.env.THINKORBITAL_LOCATION_HEURISTICS = saved;
    });

    it('fills a missing country with USA by default', () => {
      const location = parse('Boulder, Colorado');
      expect(location).toMatchObject({ city: 'Boulder', state: 'CO', country: 'USA' });
    });

    it('resolves the first US state named after the city in multi-site labels', () => {
      const location = parse('Boulder, Colorado or Washington, DC Area');
      expect(location).toMatchObject({ city: 'Boulder', state: 'CO', country: 'USA' });
    });

    it('keeps a country for a label with no parseable geography', () => {
      expect(parse('Remote')).toMatchObject({ country: 'USA' });
    });

    it('never overwrites fields the shared parser found', () => {
      const location = parse('Toronto, ON, Canada');
      expect(location?.country).toBe('Canada');
    });

    it.each(['false', '0', 'off', 'NO'])('=%s returns the shared-parser output only', (value) => {
      process.env.THINKORBITAL_LOCATION_HEURISTICS = value;
      const location = parse('Boulder, Colorado');
      expect(location).toMatchObject({ city: 'Boulder', state: 'CO' });
      expect(location?.country).toBeUndefined();
      expect(parse('Remote')).toBeNull();
    });

    it('switches off for scraped jobs end to end', async () => {
      process.env.THINKORBITAL_LOCATION_HEURISTICS = 'false';
      getMock.mockResolvedValueOnce({ data: fixture });

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      expect(response.jobs.length).toBeGreaterThan(0);
      for (const job of response.jobs) expect(job.location?.country).toBeUndefined();
    });
  });

  it('builds a markdown description from the labeled body sections', async () => {
    getMock.mockResolvedValueOnce({ data: fixture });

    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    const assembly = response.jobs.find(
      (job) => job.title === 'Assembly Integration and Test Engineer',
    )!;
    expect(assembly.description).toContain('## About ThinkOrbital');
    expect(assembly.description).toContain('## Position Summary');
    expect(assembly.description).toContain('## Key Responsibilities');
    expect(assembly.description).toContain('## Salary Range');
    expect(assembly.description).toContain('ThinkOrbital is developing breakthrough technologies');
    expect(assembly.description).toContain('From $110,000 to $130,000');
  });

  it('filters by searchTerm', async () => {
    getMock.mockResolvedValueOnce({ data: fixture });

    const response = await service.scrape(
      new ScraperInputDto({ searchTerm: 'Lead Avionics', resultsWanted: 999 }),
    );

    expect(response.jobs).toHaveLength(1);
    expect(response.jobs[0].title).toBe('Lead Avionics Software Engineer');
  });

  it('filters by location', async () => {
    getMock.mockResolvedValueOnce({ data: fixture });

    const response = await service.scrape(
      new ScraperInputDto({ location: 'Boulder', resultsWanted: 999 }),
    );

    expect(response.jobs).toHaveLength(3);
  });

  it('applies offset and resultsWanted', async () => {
    getMock.mockResolvedValueOnce({ data: fixture });

    const response = await service.scrape(new ScraperInputDto({ offset: 1, resultsWanted: 1 }));

    expect(response.jobs).toHaveLength(1);
    expect(response.jobs[0].title).toBe('Electrical Engineer');
  });

  it('uses the provided companyUrl for the initial request', async () => {
    const customUrl = 'https://example.com/careers/';
    getMock.mockResolvedValueOnce({ data: fixture });

    const response = await service.scrape(
      new ScraperInputDto({ companyUrl: customUrl, resultsWanted: 999 }),
    );

    expect(getMock).toHaveBeenCalledWith(customUrl);
    expect(response.jobs[0].companyUrl).toBe(customUrl);
  });

  it('returns diagnostics when the accordion widget is missing', async () => {
    getMock.mockResolvedValueOnce({ data: '<html><head></head><body></body></html>' });

    const response = await service.scrape(new ScraperInputDto());

    expect(response.jobs).toHaveLength(0);
    expect(response.diagnostics).toBeDefined();
  });
});

/** Best of three wall-clock runs, in ms (one run can overshoot on a throttled pod). */
function bestOf3Ms(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('ThinkorbitalService scraped-text regexes stay linear (Spec 1689)', () => {
  const resolve = (raw: string) =>
    (new ThinkorbitalService() as unknown as { resolveStateName(r: string): string | null }).resolveStateName(raw);

  it('still splits on the same connectors', () => {
    expect(resolve('Colorado or Texas')).toBe('CO');
    expect(resolve('Mars  and  Texas')).toBe('TX');
    expect(resolve('Moon, Utah')).toBe('UT');
  });

  it('resolves a 20k-char whitespace run in linear time', () => {
    const raw = `Mars${' '.repeat(20_000)}Venus`;
    expect(bestOf3Ms(() => resolve(raw))).toBeLessThan(50);
  });
});
