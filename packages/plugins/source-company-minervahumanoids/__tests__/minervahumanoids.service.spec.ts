import * as fs from 'fs';
import * as path from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { MinervaHumanoidsService } from '../src/minervahumanoids.service';

const PUBLISHED_JS = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'published.js'),
  'utf-8',
);

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return { ...actual, createHttpClient: jest.fn() };
});
const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
  createHttpClient: jest.Mock;
};

function mutatedPayload(mutate: (jobs: Record<string, unknown>[]) => void): string {
  const start = PUBLISHED_JS.indexOf('{');
  const end = PUBLISHED_JS.lastIndexOf('}');
  const payload = JSON.parse(PUBLISHED_JS.slice(start, end + 1)) as {
    content: { jobs: Record<string, unknown>[] };
  };
  mutate(payload.content.jobs);
  return `window.__minervaContent=${JSON.stringify(payload)}`;
}

function mockClient(body: unknown = PUBLISHED_JS, reject = false) {
  const getMock = jest.fn((url: string) => {
    if (reject) return Promise.reject(new Error('ECONNRESET'));
    if (url === 'https://www.minervahumanoids.com/content/published.js') {
      return Promise.resolve({ data: body });
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
  createHttpClient.mockReturnValue({ get: getMock, setHeaders: jest.fn() });
  return getMock;
}

describe('MinervaHumanoidsService', () => {
  const service = new MinervaHumanoidsService();
  const input = new ScraperInputDto({
    siteType: [Site.MINERVAHUMANOIDS],
    resultsWanted: 100,
  });

  beforeEach(() => jest.clearAllMocks());

  it('fetches the published content file and maps all 11 roles', async () => {
    const getMock = mockClient();
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(11);
    expect(getMock).toHaveBeenCalledWith(
      'https://www.minervahumanoids.com/content/published.js',
    );
    expect(res.diagnostics).toBeUndefined();
  });

  it('maps title, id, site, and per-role anchor urls', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.atsId === 'job-1');
    expect(job).toBeDefined();
    expect(job!.id).toBe('minervahumanoids-job-1');
    expect(job!.site).toBe(Site.MINERVAHUMANOIDS);
    expect(job!.atsType).toBe('minervahumanoids');
    expect(job!.companyName).toBe('Minerva Humanoids');
    expect(job!.jobUrl).toBe(
      'https://www.minervahumanoids.com/careers#job-description-job-1',
    );
    expect(job!.applyUrl).toBe('https://www.minervahumanoids.com/careers#apply');
  });

  it('uses the talent apply anchor for program=talent roles', async () => {
    mockClient();
    const res = await service.scrape(input);
    const talent = res.jobs.filter((j) =>
      j.applyUrl?.endsWith('#talent-apply'),
    );
    // 3 intern roles + the open-application bucket
    expect(talent).toHaveLength(4);
    const regular = res.jobs.filter((j) => j.applyUrl?.endsWith('#apply'));
    expect(regular).toHaveLength(7);
  });

  it('parses free-text locations', async () => {
    mockClient();
    const res = await service.scrape(input);
    const sf = res.jobs.find((j) => j.atsId === 'job-1');
    expect(sf!.location?.city).toBe('San Francisco');
    const de = res.jobs.find((j) => j.atsId === 'job-5');
    expect(de!.location?.country).toBeTruthy();
    const openApp = res.jobs.find((j) => j.atsId === 'talent-open-application');
    expect(openApp).toBeDefined();
  });

  it('flattens description blocks with headings and list bullets', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.atsId === 'job-1');
    expect(job!.description).toBeTruthy();
    expect(job!.description).toContain('\n- ');
    expect(job!.description!.length).toBeGreaterThan(200);
  });

  it('uses a non-empty applyUrl verbatim', async () => {
    const mutated = mutatedPayload((jobs) => {
      jobs[0].applyUrl = 'https://boards.greenhouse.io/minerva/jobs/1';
    });
    mockClient(mutated);
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.atsId === 'job-1');
    expect(job!.applyUrl).toBe('https://boards.greenhouse.io/minerva/jobs/1');
    expect(job!.jobUrl).toBe('https://boards.greenhouse.io/minerva/jobs/1');
  });

  it('drops jobs with published=false', async () => {
    const mutated = mutatedPayload((jobs) => {
      jobs[0].published = false;
    });
    mockClient(mutated);
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(10);
    expect(res.jobs.some((j) => j.atsId === 'job-1')).toBe(false);
  });

  it('filters on searchTerm', async () => {
    mockClient();
    const res = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.MINERVAHUMANOIDS],
        searchTerm: 'mechanical',
        resultsWanted: 100,
      }),
    );
    expect(res.jobs.length).toBeGreaterThan(0);
    expect(res.jobs.length).toBeLessThan(11);
    expect(
      res.jobs.every(
        (j) =>
          j.title!.toLowerCase().includes('mechanical') ||
          (j.description ?? '').toLowerCase().includes('mechanical'),
      ),
    ).toBe(true);
  });

  it('reports empty diagnostics when the payload has no jobs', async () => {
    mockClient('window.__minervaContent={"version":1,"content":{"jobs":[]}}');
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('reports empty diagnostics on unparseable content', async () => {
    mockClient('window.__minervaContent=not json');
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns error diagnostics when the fetch fails', async () => {
    mockClient(PUBLISHED_JS, true);
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBeTruthy();
    expect(res.diagnostics?.reason).not.toBe('empty');
  });
});
