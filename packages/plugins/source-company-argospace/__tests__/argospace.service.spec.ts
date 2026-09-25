import * as fs from 'fs';
import * as path from 'path';
import { createHttpClient } from '@ever-jobs/common';
import { CompensationInterval, JobType, ScraperInputDto, Site } from '@ever-jobs/models';
import { ArgospaceService } from '../src/argospace.service';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(),
  };
});

function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.html`), 'utf8');
}

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function slugFromUrl(url: string): string {
  return url
    .replace(/\/$/, '')
    .split('/')
    .pop() ?? '';
}

function getMockResponse(url: string): Promise<{ data: string }> {
  const careersUrl = 'https://argospace.com/careers';
  if (url === careersUrl || url === `${careersUrl}/`) {
    return Promise.resolve({ data: fixture('argospace-careers') });
  }

  const slug = slugFromUrl(url);
  const filePath = path.join(FIXTURES_DIR, `argospace-${slug}.html`);
  if (fs.existsSync(filePath)) {
    return Promise.resolve({ data: fs.readFileSync(filePath, 'utf8') });
  }

  return Promise.reject(new Error(`Unexpected request URL: ${url}`));
}

describe('ArgospaceService', () => {
  let service: ArgospaceService;
  let getMock: jest.Mock;

  beforeEach(() => {
    service = new ArgospaceService();
    getMock = jest.fn(getMockResponse);
    (createHttpClient as jest.Mock).mockReturnValue({ get: getMock });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('scrapes the visible grouped list and returns all 14 jobs', async () => {
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    expect(response.jobs).toHaveLength(14);
    const titles = response.jobs.map((job) => job.title);
    expect(titles).toContain('Engineering Intern');
    expect(titles).toContain('Avionics Engineer I');
    expect(titles).toContain('Senior Propulsion Engineer');
    expect(titles).toContain('Mechanical Engineer');
  });

  it('sets Argo Space company metadata and detail-page job URLs', async () => {
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    const senior = response.jobs.find((job) => job.title === 'Senior Propulsion Engineer')!;
    expect(senior.site).toBe(Site.ARGOSPACE);
    expect(senior.companyName).toBe('Argo Space');
    expect(senior.companyUrl).toBe('https://argospace.com');
    expect(senior.jobUrl).toBe('https://argospace.com/careers/senior-propulsion-engineer');
    expect(senior.jobUrlDirect).toBe('https://argospace.com/careers/senior-propulsion-engineer');
  });

  it('sets the apply URL to the detail-page apply button', async () => {
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    const senior = response.jobs.find((job) => job.title === 'Senior Propulsion Engineer')!;
    expect(senior.applyUrl).toBe('https://www.linkedin.com/company/argo-space/jobs/');

    const intern = response.jobs.find((job) => job.title === 'Engineering Intern')!;
    expect(intern.applyUrl).toBe('https://argospace.com/careers/engineering-intern#Apply-Now');
  });

  it('parses location for El Segundo, CA', async () => {
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    const senior = response.jobs.find((job) => job.title === 'Senior Propulsion Engineer')!;
    expect(senior.location?.city).toBe('El Segundo');
    expect(senior.location?.state).toBe('CA');
    // Spec 1689: Argo Space hires only in the US — the country default is restored.
    expect(senior.location?.country).toBe('USA');
    expect(senior.isRemote).toBe(false);
    expect(senior.workFromHomeType).toBe('On Site');
  });

  /** Spec 1689 — pre-5125 location data restored on top of the shared parser. */
  describe('location heuristics (ARGOSPACE_LOCATION_HEURISTICS)', () => {
    const saved = process.env.ARGOSPACE_LOCATION_HEURISTICS;
    const parse = (label: string) => (service as any).parseLocation(label);

    beforeEach(() => {
      delete process.env.ARGOSPACE_LOCATION_HEURISTICS;
    });

    afterAll(() => {
      if (saved === undefined) delete process.env.ARGOSPACE_LOCATION_HEURISTICS;
      else process.env.ARGOSPACE_LOCATION_HEURISTICS = saved;
    });

    it('strips parenthetical qualifiers and fills USA by default', () => {
      expect(parse('El Segundo, CA (On-site)')).toMatchObject({ city: 'El Segundo', state: 'CA', country: 'USA' });
      expect(parse('El Segundo (Headquarters), CA')).toMatchObject({ city: 'El Segundo', state: 'CA', country: 'USA' });
    });

    it('falls back to the full label when the parenthetical is the geography', () => {
      expect(parse('Remote (Austin, TX)')).toMatchObject({ city: 'Austin', state: 'TX', country: 'USA' });
    });

    it('keeps a country the shared parser found', () => {
      expect(parse('Toronto, ON, Canada')?.country).toBe('Canada');
    });

    it('emits USA on every scraped job by default', async () => {
      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));
      expect(response.jobs.length).toBeGreaterThan(0);
      for (const job of response.jobs) expect(job.location?.country).toBe('USA');
    });

    it.each(['false', '0', 'off', 'no'])('=%s returns the shared-parser output only', (value) => {
      process.env.ARGOSPACE_LOCATION_HEURISTICS = value;
      const location = parse('El Segundo, CA (On-site)');
      expect(location).toMatchObject({ city: 'El Segundo', state: 'CA' });
      expect(location?.country).toBeUndefined();
    });
  });

  it('parses compensation for yearly and hourly ranges', async () => {
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    const senior = response.jobs.find((job) => job.title === 'Senior Propulsion Engineer')!;
    expect(senior.compensation?.minAmount).toBe(100000);
    expect(senior.compensation?.maxAmount).toBe(200000);
    expect(senior.compensation?.currency).toBe('USD');
    expect(senior.compensation?.interval).toBe(CompensationInterval.YEARLY);

    const intern = response.jobs.find((job) => job.title === 'Engineering Intern')!;
    expect(intern.compensation?.minAmount).toBe(30);
    expect(intern.compensation?.maxAmount).toBe(30);
    expect(intern.compensation?.currency).toBe('USD');
    expect(intern.compensation?.interval).toBe(CompensationInterval.HOURLY);
  });

  it('leaves compensation unset when no salary is listed', async () => {
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    const mechanical = response.jobs.find((job) => job.title === 'Mechanical Engineer')!;
    expect(mechanical.compensation).toBeNull();
  });

  it('maps Full-Time and Internship to the right job types', async () => {
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    const senior = response.jobs.find((job) => job.title === 'Senior Propulsion Engineer')!;
    expect(senior.jobType).toEqual([JobType.FULL_TIME]);
    expect(senior.employmentType).toBe('Full-Time');

    const intern = response.jobs.find((job) => job.title === 'Engineering Intern')!;
    expect(intern.jobType).toEqual([JobType.INTERNSHIP]);
    expect(intern.employmentType).toBe('Internship');
  });

  it('builds a markdown description from the detail page body', async () => {
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    const senior = response.jobs.find((job) => job.title === 'Senior Propulsion Engineer')!;
    expect(senior.description).toContain('As a Propulsion Engineer at Argo');
    expect(senior.description?.length).toBeGreaterThan(100);
  });

  it('filters by searchTerm', async () => {
    const response = await service.scrape(
      new ScraperInputDto({ searchTerm: 'propulsion', resultsWanted: 999 }),
    );

    expect(response.jobs.length).toBeGreaterThanOrEqual(3);
    for (const job of response.jobs) {
      const haystack = `${job.title} ${job.description ?? ''}`.toLowerCase();
      expect(haystack).toContain('propulsion');
    }
  });

  it('filters by location', async () => {
    const response = await service.scrape(
      new ScraperInputDto({ location: 'El Segundo', resultsWanted: 999 }),
    );

    expect(response.jobs).toHaveLength(14);
  });

  it('filters by jobType', async () => {
    const response = await service.scrape(
      new ScraperInputDto({ jobType: JobType.INTERNSHIP, resultsWanted: 999 }),
    );

    expect(response.jobs).toHaveLength(1);
    expect(response.jobs[0].title).toBe('Engineering Intern');
  });

  it('returns no jobs when isRemote is true', async () => {
    const response = await service.scrape(
      new ScraperInputDto({ isRemote: true, resultsWanted: 999 }),
    );

    expect(response.jobs).toHaveLength(0);
  });

  it('applies offset and resultsWanted', async () => {
    const response = await service.scrape(new ScraperInputDto({ offset: 1, resultsWanted: 2 }));

    expect(response.jobs).toHaveLength(2);
    expect(response.jobs[0].title).toBe('Avionics Engineer I');
    expect(response.jobs[1].title).toBe('Avionics Engineer II');
  });

  it('does not include hidden LinkedIn-list cards', async () => {
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

    for (const job of response.jobs) {
      expect(job.jobUrl).toMatch(/^https:\/\/argospace\.com\/careers\//);
    }
    const linkedInApplyCount = response.jobs.filter((job) =>
      job.applyUrl?.includes('linkedin.com/jobs/view/'),
    ).length;
    expect(linkedInApplyCount).toBe(0);
  });

  it('uses the provided companyUrl for the initial request', async () => {
    const customUrl = 'https://example.com/careers';
    const customGetMock = jest.fn((url: string) => {
      if (url === customUrl) {
        return Promise.resolve({ data: fixture('argospace-careers') });
      }
      return getMockResponse(url);
    });
    (createHttpClient as jest.Mock).mockReturnValue({ get: customGetMock });

    const response = await service.scrape(
      new ScraperInputDto({ companyUrl: customUrl, resultsWanted: 999 }),
    );

    expect(customGetMock).toHaveBeenNthCalledWith(1, customUrl);
    expect(response.jobs[0].companyUrl).toBe(customUrl);
  });

  it('returns diagnostics when the visible grouped list is missing', async () => {
    const emptyMock = jest.fn().mockResolvedValue({ data: '<html><head></head><body></body></html>' });
    (createHttpClient as jest.Mock).mockReturnValue({ get: emptyMock });

    const response = await service.scrape(new ScraperInputDto());

    expect(response.jobs).toHaveLength(0);
    expect(response.diagnostics).toBeDefined();
    expect(response.diagnostics!.detail).toMatch(/Current Openings list/);
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

describe('ArgospaceService scraped-text regexes stay linear (Spec 1689)', () => {
  const parse = (raw: string) =>
    (new ArgospaceService() as unknown as { parseLocation(r: string): { city?: string | null } | null }).parseLocation(
      raw,
    );

  it('still falls back to the parenthetical when it is the geography', () => {
    expect(parse('Remote (Austin, TX)')?.city).toBe('Austin');
  });

  // 40k chars and a 1 s budget: the plugin's own char-by-char normalize() is
  // linear but slow (~50 ms per 20k chars on a dev box, run twice here); the
  // former /\([^)]*\)/g was quadratic — 553 ms at 20k, so ~2.2 s at 40k.
  it.each([
    ['unclosed parens', '('.repeat(40_000)],
    ['open-paren words', '(a'.repeat(20_000)],
  ])('strips a 40k-char label of %s in linear time', (_name, raw) => {
    expect(bestOf3Ms(() => parse(raw))).toBeLessThan(1000);
  });
});
