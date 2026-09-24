import { readFileSync } from 'fs';
import { join } from 'path';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';

const careersHtml = readFileSync(
  join(__dirname, 'fixtures', 'careers.html'),
  'utf8',
);
const careersChunk = readFileSync(
  join(__dirname, 'fixtures', 'careers-chunk.js'),
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

import { FourEarthTechService } from '../src/four-earth-tech.service';
import { FOUR_EARTH_TECH_ALLOWED_HOSTS } from '../src/four-earth-tech.constants';

function respondWith(shell: unknown, chunk?: unknown): void {
  getMock.mockReset();
  getMock.mockResolvedValueOnce({ data: shell });
  if (chunk !== undefined) getMock.mockResolvedValueOnce({ data: chunk });
}

/**
 * Best of three wall-clock runs, in ms. One run can overshoot a small budget
 * on a throttled CI pod (CFS quota, GC pause); a super-linear regex overshoots
 * it on every run, by orders of magnitude.
 */
function bestOf3Ms(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('FourEarthTechService', () => {
  let service: FourEarthTechService;

  beforeEach(() => {
    getMock.mockReset();
    service = new FourEarthTechService();
  });

  it('maps both roles from the embedded jobs array', async () => {
    respondWith(careersHtml, careersChunk);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(2);
    expect(res.diagnostics).toBeUndefined();

    const ee = res.jobs.find((j) => j.atsId === 'electrical-systems-engineer');
    expect(ee).toBeDefined();
    expect(ee!.id).toBe('4earth_tech-electrical-systems-engineer');
    expect(ee!.title).toBe('Electrical Systems Engineer');
    expect(ee!.site).toBe(Site.FOUR_EARTH_TECH);
    expect(ee!.atsType).toBe('4earth_tech');
    expect(ee!.companyName).toBe('4Earth');
    expect(ee!.location?.city).toBe('Marietta');
    expect(ee!.location?.state).toBe('GA');
    expect(ee!.employmentType).toBe('Full-time (Onsite)');
    expect(ee!.jobType).toEqual([JobType.FULL_TIME]);

    const me = res.jobs.find((j) => j.atsId === 'mechanical-systems-engineer');
    expect(me).toBeDefined();
    expect(me!.title).toBe('Mechanical Systems Engineer');
  });

  it('fetches the shell then the Careers chunk it references', async () => {
    respondWith(careersHtml, careersChunk);
    await service.scrape(new ScraperInputDto({}));
    expect(getMock).toHaveBeenNthCalledWith(1, 'https://www.4earth.tech/careers');
    expect(getMock).toHaveBeenNthCalledWith(
      2,
      'https://www.4earth.tech/assets/Careers-2dff7c22.js',
    );
  });

  it('composes a multi-part description from the entry fields', async () => {
    respondWith(careersHtml, careersChunk);
    const res = await service.scrape(new ScraperInputDto({}));
    const ee = res.jobs.find((j) => j.atsId === 'electrical-systems-engineer');
    const desc = ee!.description ?? '';
    expect(desc).toContain('resource recovery technology');
    expect(desc).toContain('electron path');
    expect(desc).toContain('What You Will Build:');
    expect(desc).toContain('- The Nervous System:');
    expect(desc).toContain('- PLC Programming');
    expect(desc).toContain('re-engineering the water cycle');
    expect(desc.length).toBeGreaterThan(2000);
  });

  it('points jobUrl and applyUrl at the careers page', async () => {
    respondWith(careersHtml, careersChunk);
    const res = await service.scrape(new ScraperInputDto({}));
    for (const job of res.jobs) {
      expect(job.jobUrl).toBe('https://www.4earth.tech/careers');
      expect(job.jobUrlDirect).toBe('https://www.4earth.tech/careers');
      expect(job.applyUrl).toBe('https://www.4earth.tech/careers');
    }
  });

  it('returns an empty diagnostic when the shell has no chunk link', async () => {
    respondWith('<html><body><main>no assets</main></body></html>');
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('returns an empty diagnostic when the chunk has no jobs array', async () => {
    respondWith(careersHtml, 'const x=1;export{x};');
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns diagnostics when the fetch fails', async () => {
    getMock.mockReset();
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
  });

  it('honors resultsWanted, searchTerm, and location', async () => {
    respondWith(careersHtml, careersChunk);
    const paged = await service.scrape(new ScraperInputDto({ resultsWanted: 1 }));
    expect(paged.jobs).toHaveLength(1);

    respondWith(careersHtml, careersChunk);
    const searched = await service.scrape(
      new ScraperInputDto({ resultsWanted: 9999, searchTerm: 'mechanical' }),
    );
    expect(searched.jobs).toHaveLength(1);
    expect(searched.jobs[0].atsId).toBe('mechanical-systems-engineer');

    respondWith(careersHtml, careersChunk);
    const located = await service.scrape(
      new ScraperInputDto({ resultsWanted: 9999, location: 'Marietta' }),
    );
    expect(located.jobs).toHaveLength(2);
  });

  describe('companyUrl pin-or-ignore (Spec 1689)', () => {
    it('accepts an on-domain companyUrl and uses it for the fetch and jobUrl', async () => {
      respondWith(careersHtml, careersChunk);
      const res = await service.scrape(
        new ScraperInputDto({ companyUrl: 'https://4earth.tech/careers?ref=x' }),
      );
      expect(getMock).toHaveBeenNthCalledWith(1, 'https://4earth.tech/careers?ref=x');
      expect(res.jobs[0].jobUrl).toBe('https://4earth.tech/careers?ref=x');
    });

    it('upgrades an on-domain http companyUrl to https', async () => {
      respondWith(careersHtml, careersChunk);
      await service.scrape(new ScraperInputDto({ companyUrl: 'http://www.4earth.tech/careers' }));
      expect(getMock).toHaveBeenNthCalledWith(1, 'https://www.4earth.tech/careers');
    });

    it.each([
      ['off-domain', 'https://evil.example/careers'],
      ['lookalike', 'https://4earth.tech.evil.example/careers'],
      ['userinfo smuggling', 'https://4earth.tech@evil.example/careers'],
      ['internal IP', 'http://169.254.169.254/latest/meta-data/'],
      ['cluster service', 'https://kubernetes.default.svc/api'],
      ['non-http scheme', 'file:///etc/passwd'],
    ])('ignores a %s companyUrl and fetches the default board', async (_label, companyUrl) => {
      respondWith(careersHtml, careersChunk);
      const res = await service.scrape(new ScraperInputDto({ companyUrl }));
      expect(getMock).toHaveBeenNthCalledWith(1, 'https://www.4earth.tech/careers');
      for (const call of getMock.mock.calls) {
        expect(new URL(call[0] as string).hostname).toBe('www.4earth.tech');
      }
      expect(res.jobs).toHaveLength(2);
      expect(res.jobs[0].jobUrl).toBe('https://www.4earth.tech/careers');
    });
  });

  describe('ReDoS hardening (Spec 1689)', () => {
    type Parser = { scalarField(objText: string, key: string): string | null };

    it('scalarField stays linear on 64 backslashes before a line break', () => {
      const text = `{title:"${'\\'.repeat(64)}\n"}`;
      const parser = service as unknown as Parser;
      expect(bestOf3Ms(() => parser.scalarField(text, 'title'))).toBeLessThan(50);
      expect(parser.scalarField(text, 'title')).toBeNull();
    });

    it('scalarField still unescapes quotes and backslashes', () => {
      const parser = service as unknown as Parser;
      expect(parser.scalarField(`{title:"a \\"b\\" c\\\\",x:1}`, 'title')).toBe('a "b" c\\');
      expect(parser.scalarField(`{title:'it\\'s "fine"'}`, 'title')).toBe(`it's "fine"`);
      expect(parser.scalarField(`{title:"broken\nline"}`, 'title')).toBeNull();
    });

    it('scrapes past a pathological entry end-to-end', async () => {
      const chunk = `const E=[{id:"a",title:"${'\\'.repeat(64)}\n"},{id:"b",title:"Real Role",location:"Marietta, GA"}];`;
      respondWith(careersHtml, chunk);
      const started = performance.now();
      const res = await service.scrape(new ScraperInputDto({}));
      expect(performance.now() - started).toBeLessThan(1000);
      expect(res.jobs.map((j) => j.title)).toEqual(['Real Role']);
    });

    it('treats a jobs literal over the size cap as malformed', async () => {
      const chunk = `const E=[{id:"a",title:"${'x'.repeat(1_000_001)}"}];`;
      respondWith(careersHtml, chunk);
      const res = await service.scrape(new ScraperInputDto({}));
      expect(res.jobs).toHaveLength(0);
      expect(res.diagnostics?.reason).toBe('empty');
    });
  });
});

describe('FourEarthTechService companyUrl hygiene (Spec 1689)', () => {
  afterEach(() => getMock.mockReset());

  it('logs only the host of a refused companyUrl, never its credentials or query', () => {
    const svc = new FourEarthTechService();
    const debug = jest
      .spyOn((svc as unknown as { logger: { debug: (m: string) => void } }).logger, 'debug')
      .mockImplementation(() => undefined);
    (svc as unknown as { careersUrl(input: ScraperInputDto): string }).careersUrl(
      new ScraperInputDto({ companyUrl: 'https://user:s3cret@evil.example/x?token=t0k' }),
    );
    const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('evil.example');
    expect(logged).not.toMatch(/s3cret|t0k|user:/);
  });

  it('pins every redirect hop to the plugin allowlist', async () => {
    const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
      createHttpClient: jest.Mock;
    };
    createHttpClient.mockClear();
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await new FourEarthTechService().scrape(new ScraperInputDto({})).catch(() => undefined);
    expect(createHttpClient).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRedirectHosts: FOUR_EARTH_TECH_ALLOWED_HOSTS }),
    );
  });
});
